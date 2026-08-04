import { scatterField, variantAt } from "../rand/blue-noise.js";
import { fbm2, unit } from "../rand/noise.js";
import { streamId, valueAt } from "../rand/rng.js";
import { type Chunk, createChunk, setTerrain } from "../tiles/chunk.js";
import { TFlag } from "../tiles/flags.js";
import { T, type TerrainId } from "../tiles/terrain.js";
import { type BiomeId, biomeDef, classifyBiome } from "../world/biome.js";
import { boundaryTerrain, isBoundary, type WorldBounds } from "../world/bounds.js";
import { CHUNK, type ChunkCoord, localIndex } from "../world/coords.js";
import { elevationBand, SEA_LEVEL } from "../world/fields.js";
import { isSettlement, type MacroSite, sitesAround } from "../world/macro.js";
import { type River, riversAround } from "../world/rivers.js";
import { type Road, roadsAround } from "../world/roads.js";
import {
	buildFeatureMasks,
	MASK_BANK,
	MASK_CHANNEL,
	MASK_MAJOR,
	MASK_MINOR,
	maskAt,
} from "./feature-mask.js";
import { fallbackSettlementSpec } from "./features/fallback-spec.js";
import type { Anchor, BuildingPlacement, FeaturePatch } from "./features/patch.js";
import { patchIndex } from "./features/patch.js";
import { type SettlementSpec, settlementsOverlapping } from "./features/settlement.js";
import { fieldAt, sampleFieldBuffer, slopeFromBuffer } from "./field-buffer.js";

/**
 * One scatter lattice spacing for every biome. Density varies per biome, the
 * lattice does not — which is what keeps a forest/grassland border from showing
 * a change in the underlying grid.
 */
const SCATTER_CELL = 3;

// Resolved once at module load rather than per tile.
const GROUND_STREAM = streamId("ground");
const PICK_STREAM = streamId("scatter:pick");

/**
 * World units per patch of alternate ground. Around 16 puts several patches in
 * a 64-tile chunk while each is still wide enough to read as a patch.
 */
const PATCH_SCALE = 16;

/**
 * Thresholds on {@link groundPatchAt}. Tuned to reproduce the coverage the old
 * per-tile rolls produced (a quarter alternate ground, banks split evenly), so
 * this changes the *shape* of the distribution without changing its balance.
 */
const ALT_GROUND_BELOW = 0.42;
const BANK_GRAVEL_BELOW = 0.5;

/**
 * Where a biome shows its alternate ground — as a coherent field, not a
 * per-tile coin flip.
 *
 * This was `valueAt(seed, GROUND_STREAM, wx, wy)`, which is a hash: white noise
 * with no spatial correlation whatsoever. A quarter of every biome's tiles
 * flipped to `groundAlt` independently of their neighbours, so grassland came
 * out not as grass with gravel patches but as grass with gravel *dust*. It
 * measured 38% disagreement between horizontally adjacent tiles, which is why
 * the map read as static and why the row encoder had so little to collapse.
 * Sampling fbm at the same coverage takes that to about 8%.
 */
function groundPatchAt(seed: number, wx: number, wy: number): number {
	return unit(fbm2(seed ^ GROUND_STREAM, wx, wy, { octaves: 3, scale: PATCH_SCALE }));
}

export interface GenContext {
	readonly seed: number;
	/** Precomputed halo features, when the caller already gathered them. */
	readonly roads?: readonly Road[];
	readonly rivers?: readonly River[];
	/**
	 * Supplies the LLM-authored settlement spec for a site. Omitted, or
	 * returning undefined, falls back to the deterministic roster — which is
	 * what makes the world fully playable with no director at all.
	 */
	readonly specFor?: (site: MacroSite) => SettlementSpec | undefined;
	/**
	 * The edge of a bounded world, for pre-generated scenarios.
	 *
	 * Omitted everywhere else, which is why the goldens do not move: an unbounded
	 * world generates exactly as it did. A tile stays a pure function of
	 * `(seed, worldPosition, bounds)` and `bounds` is constant for a scenario, so
	 * no stage reads another chunk and the seam contract is unaffected.
	 */
	readonly bounds?: WorldBounds;
}

/**
 * What the generator learned about a chunk.
 *
 * This is handed to the LLM director so it can *name and populate a place the
 * engine already built*, rather than inventing a place the engine then has to
 * reproduce. Inverting that relationship is the whole point of the redesign.
 */
export interface TerrainSummary {
	readonly cc: ChunkCoord;
	readonly biomeCounts: Readonly<Record<string, number>>;
	readonly dominantBiome: BiomeId;
	readonly elevationRange: readonly [number, number];
	readonly waterFraction: number;
	readonly passableFraction: number;
	readonly roadEntries: readonly ("north" | "south" | "east" | "west")[];
	readonly hasRiver: boolean;
	/** Settlement sites whose footprint reaches this chunk. */
	readonly sites: readonly MacroSite[];
	readonly buildingCount: number;
}

export interface GeneratedChunk {
	readonly chunk: Chunk;
	readonly summary: TerrainSummary;
	/** Buildings and anchors clipped into this chunk, for entity placement. */
	readonly buildings: readonly BuildingPlacement[];
	readonly anchors: readonly Anchor[];
}

/**
 * Generate one chunk.
 *
 * Every stage reads only `(seed, worldX, worldY)` and halo features that are
 * themselves pure functions of `(seed, macroCoordinate)`. No stage reads
 * another chunk and no stage writes outside this one. That is the entire seam
 * contract, and it is why generating a block of chunks in any order produces
 * byte-identical results.
 */
export function generateChunk(ctx: GenContext, cc: ChunkCoord): GeneratedChunk {
	const { seed } = ctx;
	const chunk = createChunk(cc);
	const originX = cc.cx * CHUNK;
	const originY = cc.cy * CHUNK;

	// S1 -- fields, sampled once into typed arrays.
	const fields = sampleFieldBuffer(seed, cc);

	// S2/S4/S5 -- halo features, rasterised once into local masks.
	const roads = ctx.roads ?? roadsAround(seed, cc.cx, cc.cy);
	const rivers = ctx.rivers ?? riversAround(seed, cc.cx, cc.cy);
	const masks = buildFeatureMasks(cc, roads, rivers);

	// S7 -- one scatter lattice for the whole chunk. Biome decides whether a
	// candidate is accepted and what it becomes, but not where candidates fall,
	// so the lattice does not visibly change across a biome border.
	const scatter = scatterField(seed, "scatter", originX, originY, CHUNK, CHUNK, SCATTER_CELL);

	const biomeCounts: Record<string, number> = {};
	let minElevation = 1;
	let maxElevation = 0;
	let riverPresent = false;

	for (let ly = 0; ly < CHUNK; ly++) {
		const wy = originY + ly;
		for (let lx = 0; lx < CHUNK; lx++) {
			const wx = originX + lx;
			const i = localIndex(lx, ly);

			const elevation = fieldAt(fields.elevation, lx, ly);
			const temperature = fieldAt(fields.temperature, lx, ly);
			const moisture = fieldAt(fields.moisture, lx, ly);
			const roughness = fieldAt(fields.roughness, lx, ly);

			// S3 -- biome. Continuous inputs mean continuous borders, for free.
			const biome = classifyBiome(elevation, temperature, moisture);
			const def = biomeDef(biome);
			biomeCounts[biome] = (biomeCounts[biome] ?? 0) + 1;
			if (elevation < minElevation) minElevation = elevation;
			if (elevation > maxElevation) maxElevation = elevation;

			chunk.variant[i] = variantAt(seed, wx, wy);
			chunk.elevation[i] = Math.max(0, Math.min(255, Math.round(elevation * 255)));
			const groundPatch = groundPatchAt(seed, wx, wy);
			let terrain: TerrainId = groundPatch < ALT_GROUND_BELOW ? def.groundAlt : def.ground;

			// S4 -- hydrology.
			const riverMask = maskAt(masks.rivers, lx, ly);
			if (biome !== "ocean" && riverMask !== 0) {
				riverPresent = true;
				if (riverMask === MASK_CHANNEL) {
					terrain = T.water;
				} else if (riverMask === MASK_BANK && elevation >= SEA_LEVEL) {
					// Coherent too, so a bank reads as stretches of shingle and
					// stretches of sand rather than a speckle of both.
					terrain = groundPatch < BANK_GRAVEL_BELOW ? T.gravel : T.sand;
				}
			}

			// S8 -- relief. Runs before roads so a road cut into a slope wins.
			const band = elevationBand(elevation);
			if (band === "alpine" && terrain === def.ground && roughness > 0.55) {
				terrain = T.mountain;
			} else if (
				band !== "ocean" &&
				terrain !== T.water &&
				roughness > 0.5 &&
				slopeFromBuffer(fields, lx, ly) > 0.05
			) {
				terrain = T.cliff;
			}

			// S5 -- roads, and bridges where they meet a channel.
			if (elevation >= SEA_LEVEL) {
				const roadMask = maskAt(masks.roads, lx, ly);
				if (roadMask === MASK_MAJOR) {
					terrain = riverMask === MASK_CHANNEL ? T.bridge : T.cobbleRoad;
				} else if (roadMask === MASK_MINOR) {
					terrain = riverMask === MASK_CHANNEL ? T.bridge : T.dirtRoad;
				}
			}

			// Scatter, applied only over untouched ground so it never buries a road.
			if (def.scatterDensity > 0 && terrain === def.ground) {
				const roll = scatter[i] as number;
				if (roll >= 0 && roll < def.scatterDensity) {
					terrain = pickScatter(def.scatter, valueAt(seed, PICK_STREAM, wx, wy)) ?? terrain;
				}
			}

			setTerrain(chunk, lx, ly, terrain);
		}
	}

	// S6 -- settlements. Each is generated once in its own frame and clipped in
	// here, so a town straddling several chunks is one town seen several ways.
	const sites = sitesAround(seed, cc.cx, cc.cy).filter((site) => site.kind !== "none");
	const patches = settlementsOverlapping(
		seed,
		sites,
		(site) => ctx.specFor?.(site) ?? fallbackSettlementSpec(seed, site),
		{ x: originX, y: originY, w: CHUNK, h: CHUNK },
	);

	const buildings: BuildingPlacement[] = [];
	const anchors: Anchor[] = [];
	for (const patch of patches) {
		stampPatch(chunk, patch, originX, originY);
		collectWithin(patch, originX, originY, buildings, anchors);
	}

	// S9 -- boundary. After the settlement patches, so a bounded world is closed
	// whatever a patch tried to write at its edge, and before the tally, so the
	// summary describes what the chunk actually is.
	if (ctx.bounds) stampBoundary(chunk, ctx.bounds, seed, originX, originY);

	// Tally after stamping, so the counts describe what the chunk actually is.
	let waterTiles = 0;
	let passableTiles = 0;
	for (let i = 0; i < chunk.flags.length; i++) {
		const flags = chunk.flags[i] ?? 0;
		if (flags & TFlag.Water) waterTiles++;
		if (flags & TFlag.Passable) passableTiles++;
	}

	let dominant: BiomeId = "grassland";
	let dominantCount = -1;
	for (const [biome, count] of Object.entries(biomeCounts)) {
		if (count > dominantCount) {
			dominantCount = count;
			dominant = biome as BiomeId;
		}
	}

	const area = CHUNK * CHUNK;
	return {
		chunk,
		buildings,
		anchors,
		summary: {
			cc,
			biomeCounts,
			dominantBiome: dominant,
			elevationRange: [minElevation, maxElevation],
			waterFraction: waterTiles / area,
			passableFraction: passableTiles / area,
			roadEntries: roadEntriesFor(chunk),
			hasRiver: riverPresent,
			sites: sites.filter((site) => isSettlement(site.kind)),
			buildingCount: buildings.length,
		},
	};
}

/**
 * Close the edge of a bounded world.
 *
 * Unconditional where it applies: a settlement or a road that reached into the
 * band is overwritten, because a bounded world that is only *mostly* closed is
 * not bounded. The authoring pass keeps site footprints clear of the band so this
 * is a guarantee rather than a routine event.
 */
function stampBoundary(
	chunk: Chunk,
	bounds: WorldBounds,
	seed: number,
	originX: number,
	originY: number,
): void {
	const terrain = boundaryTerrain(bounds.style);
	for (let ly = 0; ly < CHUNK; ly++) {
		const wy = originY + ly;
		for (let lx = 0; lx < CHUNK; lx++) {
			if (!isBoundary(seed, bounds, originX + lx, wy)) continue;
			setTerrain(chunk, lx, ly, terrain);
			// Decor is drawn over terrain, so a tree left standing here would appear
			// to grow out of the cliff that replaced the ground under it.
			chunk.decor[localIndex(lx, ly)] = 0;
		}
	}
}

/** Copy the portion of a feature patch that falls inside this chunk. */
function stampPatch(chunk: Chunk, patch: FeaturePatch, originX: number, originY: number): void {
	const x0 = Math.max(patch.bounds.x, originX);
	const y0 = Math.max(patch.bounds.y, originY);
	const x1 = Math.min(patch.bounds.x + patch.bounds.w, originX + CHUNK);
	const y1 = Math.min(patch.bounds.y + patch.bounds.h, originY + CHUNK);

	for (let wy = y0; wy < y1; wy++) {
		for (let wx = x0; wx < x1; wx++) {
			const pi = patchIndex(patch, wx, wy);
			if (pi < 0) continue;
			const terrain = patch.terrain[pi] ?? 0;
			// Terrain 0 means the patch writes nothing here, leaving the
			// wilderness the earlier stages produced.
			if (terrain === 0) continue;
			const ci = localIndex(wx - originX, wy - originY);
			chunk.terrain[ci] = terrain;
			chunk.flags[ci] = patch.flags[pi] ?? 0;
			const decor = patch.decor[pi] ?? 0;
			if (decor !== 0) chunk.decor[ci] = decor;
		}
	}
}

function collectWithin(
	patch: FeaturePatch,
	originX: number,
	originY: number,
	buildings: BuildingPlacement[],
	anchors: Anchor[],
): void {
	const inside = (x: number, y: number) =>
		x >= originX && y >= originY && x < originX + CHUNK && y < originY + CHUNK;
	for (const building of patch.buildings) {
		if (inside(building.door.x, building.door.y)) buildings.push(building);
	}
	for (const anchor of patch.anchors) {
		if (inside(anchor.x, anchor.y)) anchors.push(anchor);
	}
}

function pickScatter(
	table: readonly (readonly [TerrainId, number])[],
	roll: number,
): TerrainId | undefined {
	let total = 0;
	for (const [, weight] of table) total += weight;
	if (total <= 0) return undefined;
	let remaining = roll * total;
	for (const [id, weight] of table) {
		remaining -= weight;
		if (remaining < 0) return id;
	}
	return table[table.length - 1]?.[0];
}

function roadEntriesFor(chunk: Chunk): ("north" | "south" | "east" | "west")[] {
	const entries: ("north" | "south" | "east" | "west")[] = [];
	const isRoad = (x: number, y: number) =>
		((chunk.flags[localIndex(x, y)] ?? 0) & TFlag.Road) !== 0;

	for (let x = 0; x < CHUNK; x++) {
		if (isRoad(x, 0)) {
			entries.push("north");
			break;
		}
	}
	for (let x = 0; x < CHUNK; x++) {
		if (isRoad(x, CHUNK - 1)) {
			entries.push("south");
			break;
		}
	}
	for (let y = 0; y < CHUNK; y++) {
		if (isRoad(CHUNK - 1, y)) {
			entries.push("east");
			break;
		}
	}
	for (let y = 0; y < CHUNK; y++) {
		if (isRoad(0, y)) {
			entries.push("west");
			break;
		}
	}
	return entries;
}
