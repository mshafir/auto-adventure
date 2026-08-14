import { authoredTiles, terraformBounds } from "../core/gen/features/authored.js";
import type { Anchor, BuildingPlacement } from "../core/gen/features/patch.js";
import type { SettlementSpec } from "../core/gen/features/settlement.js";
import { generateChunk, type TerrainSummary } from "../core/gen/pipeline.js";
import type { ChunkDelta } from "../core/rules/state.js";
import { type Chunk, setTerrain } from "../core/tiles/chunk.js";
import type { TerrainId } from "../core/tiles/terrain.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { CHUNK, type ChunkCoord, type ChunkKey, chunkKey } from "../core/world/coords.js";
import type { MacroSite } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";
import type { TerraformEdit } from "../scenario/terraform.js";

export interface ChunkManagerOptions {
	readonly world: WorldSeed;
	/** Chunks kept resident. 49 covers a 7x7 ring around the player. */
	readonly capacity?: number;
	readonly onGenerated?: (key: ChunkKey, summary: TerrainSummary) => void;
	/** Director-supplied settlement specs; absent means use the fallback roster. */
	readonly specFor?: (site: MacroSite) => SettlementSpec | undefined;
	/** The edge of a bounded world. Absent means infinite. */
	readonly bounds?: WorldBounds;
	/** Gates the scenario stamps across the world. Positions only — see `GenContext`. */
	readonly barriers?: readonly { readonly x: number; readonly y: number }[];
	/** Signposts the scenario puts up. Positions only, for the same reason. */
	readonly signs?: readonly { readonly x: number; readonly y: number }[];
	/** Ground the scenario authored. Rasterised once, here, rather than per chunk. */
	readonly terraform?: readonly TerraformEdit[];
}

interface Entry {
	readonly chunk: Chunk;
	readonly summary: TerrainSummary;
	readonly buildings: readonly BuildingPlacement[];
	readonly anchors: readonly Anchor[];
	lastUsed: number;
}

/**
 * Generates chunks on demand and keeps a bounded set resident.
 *
 * Eviction is safe precisely because generation is deterministic: an evicted
 * chunk is not lost, it is merely not currently computed. Anything the player
 * changed lives in the delta map, which is state, not cache.
 */
export class ChunkManager {
	private readonly entries = new Map<ChunkKey, Entry>();
	private readonly capacity: number;
	private clock = 0;
	private deltas: Readonly<Record<ChunkKey, ChunkDelta>> = {};
	/**
	 * The authored ground, resolved to tiles.
	 *
	 * Held here rather than passed through as edits, because a road across a world would
	 * otherwise be re-rasterised once per chunk it crosses.
	 */
	private terraform: ReadonlyMap<string, TerrainId>;
	private edits: readonly TerraformEdit[];
	/**
	 * Bumped whenever a resident chunk is dropped or replaced.
	 *
	 * `WorldView` memoises the last chunk it resolved, because a render pass asks about a whole
	 * row of tiles from the same one. That memo holds an *object*, so a chunk that has been
	 * dropped and regenerated leaves the view answering from the old copy until it happens to
	 * be asked about somewhere else. Harmless while the only invalidation was a settlement spec
	 * arriving before anything was on screen; not harmless when a chapter turns and relays the
	 * ground under the player's feet.
	 */
	revision = 0;

	constructor(private readonly options: ChunkManagerOptions) {
		this.capacity = options.capacity ?? 49;
		this.edits = options.terraform ?? [];
		this.terraform = authoredTiles(this.edits);
	}

	/**
	 * Point the manager at a new set of authored ground, as a phase change does.
	 *
	 * Drops the chunks the *union* of the old and new edits touches. The old ones because a
	 * removed edit cannot be un-stamped from a chunk already carrying it; the new ones because
	 * they have yet to be stamped at all. Dropping rather than patching is safe for the same
	 * reason eviction is: regeneration is deterministic, so a chunk is never lost, only
	 * recomputed.
	 *
	 * Returns the keys it dropped, so the caller can tell the view which ground has changed
	 * under it.
	 */
	setTerraform(edits: readonly TerraformEdit[]): ChunkKey[] {
		if (edits === this.edits) return [];
		const before = terraformBounds(this.edits);
		this.edits = edits;
		this.terraform = authoredTiles(edits);
		const after = terraformBounds(edits);
		const dropped = new Set<ChunkKey>();
		for (const rect of [before, after]) {
			if (rect) for (const key of this.invalidateRect(rect)) dropped.add(key);
		}
		return [...dropped];
	}

	/**
	 * Point the manager at a wholesale-replaced delta map. Called after a save load.
	 *
	 * Drops every resident chunk, because a replaced map may have *removed* a delta
	 * and there is no way to un-apply one to a chunk already stamped with it.
	 */
	setDeltas(deltas: Readonly<Record<ChunkKey, ChunkDelta>>): void {
		if (this.deltas === deltas) return;
		this.deltas = deltas;
		// Deltas changed, so any resident chunk may now be stale.
		this.entries.clear();
		this.revision++;
	}

	/**
	 * Point the manager at a delta map that has only grown.
	 *
	 * Patches the resident chunks in place instead of dropping them, which is the
	 * difference between a gate opening and the whole viewport blanking for a frame
	 * while sixteen chunks regenerate. Safe because `applyDelta` writes an explicit
	 * terrain id and flag set — re-applying a delta a chunk already carries is a
	 * no-op — and because play only ever *adds* deltas.
	 */
	applyAddedDeltas(deltas: Readonly<Record<ChunkKey, ChunkDelta>>): void {
		if (this.deltas === deltas) return;
		this.deltas = deltas;
		for (const [key, entry] of this.entries) this.applyDelta(entry.chunk, deltas[key]);
		// The chunk objects are the same ones, patched in place, so a view memoising them is
		// still correct — but the tiles it may already have read are not.
		this.revision++;
	}

	get(cx: number, cy: number): Chunk | undefined {
		const key = chunkKey(cx, cy);
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		entry.lastUsed = ++this.clock;
		return entry.chunk;
	}

	/** Generate the chunk if it is not resident, and return it. */
	ensure(cx: number, cy: number): Chunk {
		const key = chunkKey(cx, cy);
		const existing = this.entries.get(key);
		if (existing) {
			existing.lastUsed = ++this.clock;
			return existing.chunk;
		}

		const cc: ChunkCoord = { cx, cy };
		const generated = generateChunk(
			{
				world: this.options.world,
				...(this.options.specFor ? { specFor: this.options.specFor } : {}),
				...(this.options.bounds ? { bounds: this.options.bounds } : {}),
				...(this.options.barriers?.length ? { barriers: this.options.barriers } : {}),
				...(this.options.signs?.length ? { signs: this.options.signs } : {}),
				...(this.terraform.size > 0 ? { terraform: this.terraform } : {}),
			},
			cc,
		);
		const { chunk, summary, buildings, anchors } = generated;
		this.applyDelta(chunk, this.deltas[key]);
		this.entries.set(key, { chunk, summary, buildings, anchors, lastUsed: ++this.clock });
		this.evictIfNeeded();
		this.options.onGenerated?.(key, summary);
		return chunk;
	}

	summaryFor(cx: number, cy: number): TerrainSummary | undefined {
		return this.entries.get(chunkKey(cx, cy))?.summary;
	}

	/** Buildings whose door lies in this chunk. */
	buildingsIn(cx: number, cy: number): readonly BuildingPlacement[] {
		return this.entries.get(chunkKey(cx, cy))?.buildings ?? [];
	}

	anchorsIn(cx: number, cy: number): readonly Anchor[] {
		return this.entries.get(chunkKey(cx, cy))?.anchors ?? [];
	}

	/** Text of the shop board at this position, if one stands here. */
	signNear(x: number, y: number): string | undefined {
		const cx = Math.floor(x / CHUNK);
		const cy = Math.floor(y / CHUNK);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const match = this.buildingsIn(cx + dx, cy + dy).find(
					(b) => b.signAt?.x === x && b.signAt?.y === y,
				);
				if (match) return match.signText ?? match.name ?? `${match.kind}`;
			}
		}
		return undefined;
	}

	/** The building whose door is at this world position, if any. */
	doorAt(x: number, y: number): BuildingPlacement | undefined {
		const cx = Math.floor(x / CHUNK);
		const cy = Math.floor(y / CHUNK);
		return this.buildingsIn(cx, cy).find((b) => b.door.x === x && b.door.y === y);
	}

	has(cx: number, cy: number): boolean {
		return this.entries.has(chunkKey(cx, cy));
	}

	/**
	 * Drop every resident chunk overlapping a world rectangle.
	 *
	 * Used when a settlement's spec arrives and its patch has to be rebuilt.
	 * Dropping rather than patching is safe for the same reason eviction is:
	 * regeneration is deterministic, so a chunk is never *lost*, only recomputed.
	 */
	invalidateRect(rect: { x: number; y: number; w: number; h: number }): ChunkKey[] {
		const x0 = Math.floor(rect.x / CHUNK);
		const y0 = Math.floor(rect.y / CHUNK);
		const x1 = Math.floor((rect.x + rect.w - 1) / CHUNK);
		const y1 = Math.floor((rect.y + rect.h - 1) / CHUNK);
		const dropped: ChunkKey[] = [];
		for (let cy = y0; cy <= y1; cy++) {
			for (let cx = x0; cx <= x1; cx++) {
				const key = chunkKey(cx, cy);
				if (this.entries.delete(key)) {
					dropped.push(key);
					this.revision++;
				}
			}
		}
		return dropped;
	}

	/** Build every chunk in a square ring around a centre. */
	prefetch(around: ChunkCoord, radius: number): ChunkKey[] {
		const built: ChunkKey[] = [];
		for (let dy = -radius; dy <= radius; dy++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const cx = around.cx + dx;
				const cy = around.cy + dy;
				if (this.has(cx, cy)) continue;
				this.ensure(cx, cy);
				built.push(chunkKey(cx, cy));
			}
		}
		return built;
	}

	get residentCount(): number {
		return this.entries.size;
	}

	private applyDelta(chunk: Chunk, delta: ChunkDelta | undefined): void {
		if (!delta?.tiles) return;
		for (let i = 0; i + 2 < delta.tiles.length; i += 3) {
			const index = delta.tiles[i] as number;
			const terrain = delta.tiles[i + 1] as number;
			const flags = delta.tiles[i + 2] as number;
			const lx = index % CHUNK;
			const ly = (index - lx) / CHUNK;
			setTerrain(chunk, lx, ly, terrain, flags);
		}
		if (delta.decor) {
			for (let i = 0; i + 1 < delta.decor.length; i += 2) {
				chunk.decor[delta.decor[i] as number] = delta.decor[i + 1] as number;
			}
		}
	}

	private evictIfNeeded(): void {
		while (this.entries.size > this.capacity) {
			let oldestKey: ChunkKey | undefined;
			let oldest = Number.POSITIVE_INFINITY;
			for (const [key, entry] of this.entries) {
				if (entry.lastUsed < oldest) {
					oldest = entry.lastUsed;
					oldestKey = key;
				}
			}
			if (oldestKey === undefined) return;
			this.entries.delete(oldestKey);
		}
	}
}
