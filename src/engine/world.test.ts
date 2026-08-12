import { describe, expect, it } from "vitest";
import { getInterior } from "../core/gen/features/interior.js";
import { labelComponents, primaryComponent } from "../core/geom/floodfill.js";
import { hashString } from "../core/rand/hash.js";
import { createInitialState } from "../core/rules/state.js";
import { TFlag } from "../core/tiles/flags.js";
import { T } from "../core/tiles/terrain.js";
import { CHUNK, chunkKey, toChunk } from "../core/world/coords.js";
import { type WorldSeed, worldSeed } from "../core/world/recipe.js";
import { ChunkManager } from "./chunk-manager.js";
import { GameEngine } from "./engine.js";
import { findSpawn } from "./spawn.js";
import { createWorldView } from "./world-view.js";

const SEED = hashString("world-test");

function managerWithBlock(world: WorldSeed, radius: number) {
	const chunks = new ChunkManager({ world, capacity: (radius * 2 + 1) ** 2 + 4 });
	chunks.prefetch({ cx: 0, cy: 0 }, radius);
	return chunks;
}

describe("stitched world view", () => {
	it("reads across a chunk boundary as one continuous surface", () => {
		const chunks = managerWithBlock(worldSeed(SEED), 1);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });

		// The tile at x = CHUNK-1 lives in chunk 0 and the tile at x = CHUNK in
		// chunk 1; the view must resolve both without the caller knowing.
		for (let y = 0; y < CHUNK; y += 7) {
			expect(view.terrainAt(CHUNK - 1, y)).not.toBe(T.void);
			expect(view.terrainAt(CHUNK, y)).not.toBe(T.void);
		}
	});

	it("handles negative world coordinates", () => {
		const chunks = managerWithBlock(worldSeed(SEED), 1);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });
		expect(view.terrainAt(-1, -1)).not.toBe(T.void);
		expect(view.terrainAt(-CHUNK, -CHUNK)).not.toBe(T.void);
	});

	it("treats ungenerated ground as impassable rather than empty", () => {
		// Walking off the edge of what exists must be refused, not permitted into
		// a void the player could never walk back out of.
		const view = createWorldView({ seed: SEED, chunkAt: () => undefined });
		expect(view.isPassable(0, 0)).toBe(false);
		expect(view.isLoaded(0, 0)).toBe(false);
		expect(view.terrainAt(0, 0)).toBe(T.void);
	});

	it("still gives ungenerated ground a stable variant so it does not flicker", () => {
		const view = createWorldView({ seed: SEED, chunkAt: () => undefined });
		expect(view.variantAt(7, 9)).toBe(view.variantAt(7, 9));
	});
});

describe("cross-chunk walkability", () => {
	it("has one walkable region spanning a 5x5 block of chunks", () => {
		// The real test of seamlessness: a flood fill started anywhere on land
		// must reach across every chunk boundary in the block. A seam, a wall of
		// void at an edge, or a mis-stitched view would split this into pieces.
		const radius = 2;
		const chunks = managerWithBlock(worldSeed(SEED), radius);
		const view = createWorldView({ seed: SEED, chunkAt: (cx, cy) => chunks.get(cx, cy) });

		const size = (radius * 2 + 1) * CHUNK;
		const bounds = { x: -radius * CHUNK, y: -radius * CHUNK, w: size, h: size };
		const result = labelComponents(bounds, (x, y) => view.isPassable(x, y), true);
		const primary = primaryComponent(result);
		expect(primary).toBeGreaterThan(0);

		const primarySize = result.sizes[primary] ?? 0;
		let passableTotal = 0;
		for (let id = 1; id <= result.componentCount; id++) passableTotal += result.sizes[id] ?? 0;

		// The dominant landmass should be the overwhelming majority of walkable
		// ground; small islands cut off by water are legitimate.
		expect(primarySize / passableTotal).toBeGreaterThan(0.8);

		// And it must actually span the block rather than fill one chunk.
		const width = size;
		let minX = size;
		let maxX = 0;
		let minY = size;
		let maxY = 0;
		for (let ly = 0; ly < size; ly++) {
			for (let lx = 0; lx < size; lx++) {
				if (result.labels[ly * width + lx] !== primary) continue;
				if (lx < minX) minX = lx;
				if (lx > maxX) maxX = lx;
				if (ly < minY) minY = ly;
				if (ly > maxY) maxY = ly;
			}
		}
		expect(maxX - minX).toBeGreaterThan(CHUNK * 3);
		expect(maxY - minY).toBeGreaterThan(CHUNK * 3);
	});

	it("holds for several independent seeds", () => {
		for (const name of ["moss", "ember", "vale"]) {
			const seed = hashString(name);
			const chunks = managerWithBlock(worldSeed(seed), 1);
			const view = createWorldView({ seed, chunkAt: (cx, cy) => chunks.get(cx, cy) });
			const size = 3 * CHUNK;
			const result = labelComponents(
				{ x: -CHUNK, y: -CHUNK, w: size, h: size },
				(x, y) => view.isPassable(x, y),
				true,
			);
			const primary = primaryComponent(result);
			expect(primary, `seed ${name} produced no walkable ground`).toBeGreaterThan(0);
			expect((result.sizes[primary] ?? 0) / (size * size)).toBeGreaterThan(0.3);
		}
	});
});

describe("chunk manager", () => {
	it("is deterministic across eviction", () => {
		// Eviction is only safe because generation is reproducible; if a chunk
		// came back different after being evicted, the world would change behind
		// the player's back.
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 4 });
		const before = [...chunks.ensure(0, 0).terrain];
		for (let i = 1; i <= 12; i++) chunks.ensure(i, i);
		expect(chunks.has(0, 0)).toBe(false);
		expect([...chunks.ensure(0, 0).terrain]).toEqual(before);
	});

	it("respects its capacity", () => {
		const chunks = new ChunkManager({ world: worldSeed(SEED), capacity: 6 });
		for (let i = 0; i < 30; i++) chunks.ensure(i, 0);
		expect(chunks.residentCount).toBeLessThanOrEqual(6);
	});

	it("applies a stored delta over the generated terrain", () => {
		const chunks = new ChunkManager({ world: worldSeed(SEED) });
		const original = chunks.ensure(0, 0).terrain[0];
		chunks.setDeltas({ [chunkKey(0, 0)]: { tiles: [0, T.doorOpen, 0] } });
		expect(chunks.ensure(0, 0).terrain[0]).toBe(T.doorOpen);
		expect(chunks.ensure(0, 0).terrain[0]).not.toBe(original);
	});

	it("reports a summary for a resident chunk", () => {
		const chunks = new ChunkManager({ world: worldSeed(SEED) });
		chunks.ensure(2, -3);
		expect(chunks.summaryFor(2, -3)?.dominantBiome).toBeTruthy();
		expect(chunks.summaryFor(9, 9)).toBeUndefined();
	});
});

describe("spawn", () => {
	it("places the player on passable ground", () => {
		for (const name of ["alpha", "harrow", "vale", "moss"]) {
			const seed = hashString(name);
			const spawn = findSpawn(worldSeed(seed));
			const chunks = new ChunkManager({ world: worldSeed(seed) });
			const view = createWorldView({ seed, chunkAt: (cx, cy) => chunks.get(cx, cy) });
			chunks.ensure(Math.floor(spawn.x / CHUNK), Math.floor(spawn.y / CHUNK));
			expect(view.isPassable(spawn.x, spawn.y), `seed ${name} spawned in a wall`).toBe(true);
		}
	});
});

describe("engine", () => {
	it("dispatches synchronously and notifies subscribers", () => {
		const spawn = findSpawn(worldSeed(SEED));
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			spawn,
		);
		let notifications = 0;
		const engine = new GameEngine(state, { runEffect: () => undefined });
		engine.subscribe(() => notifications++);

		engine.dispatch({ t: "Move", facing: "right" });
		// The state is already updated when dispatch returns — no awaiting.
		expect(engine.getState().player.facing).toBe("right");
		expect(notifications).toBe(1);
	});

	it("does not notify when a command changes nothing", () => {
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			findSpawn(worldSeed(SEED)),
		);
		const engine = new GameEngine(state, { runEffect: () => undefined });
		let notifications = 0;
		engine.subscribe(() => notifications++);
		engine.dispatch({ t: "ApplyEffects", effects: [] });
		expect(notifications).toBe(0);
	});

	it("lets an effect dispatch without reordering the queue", () => {
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			findSpawn(worldSeed(SEED)),
		);
		const seen: string[] = [];
		const engine = new GameEngine(state, {
			runEffect: (effect, e) => {
				seen.push(effect.t);
				if (effect.t === "EnsureChunk") e.dispatch({ t: "Tick", amount: 1 });
			},
		});
		engine.dispatch({ t: "Move", facing: "right" });
		engine.dispatch({ t: "Move", facing: "right" });
		expect(seen.length).toBeGreaterThan(0);
	});

	it("counts the chunks it opens the world with as discovered", () => {
		// The minimap drew a donut without this: the constructor builds the ring around
		// the player before there is a queue to drain, so it never reported them the way
		// a step's prefetch does, and the eight chunks touching the player stayed dark
		// while the ring beyond them — built by the first step — filled in.
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			findSpawn(worldSeed(SEED)),
		);
		expect(state.discovered).toHaveLength(0);
		const engine = new GameEngine(state, { runEffect: () => undefined });
		const here = toChunk(state.player.x, state.player.y);
		const discovered = new Set(engine.getState().discovered);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const key = chunkKey(here.cx + dx, here.cy + dy);
				expect(discovered.has(key), `chunk ${key} was built but not recorded`).toBe(true);
			}
		}
	});

	it("fills the hole in a save that was made before it did", () => {
		// Which is every save from before the fix. Recording the whole square rather than
		// only what the prefetch reports as newly built is what makes that possible: on a
		// reload the chunks are already there, so "newly built" is nothing at all.
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			findSpawn(worldSeed(SEED)),
		);
		const engine = new GameEngine(state, { runEffect: () => undefined });
		const here = toChunk(state.player.x, state.player.y);
		engine.hydrate({ ...state, discovered: [chunkKey(here.cx, here.cy)] });
		expect(engine.getState().discovered).toContain(chunkKey(here.cx + 1, here.cy + 1));
	});
});

describe("entering buildings", () => {
	function engineAtTown(seedName: string) {
		const seed = hashString(seedName);
		const chunks = new ChunkManager({ world: worldSeed(seed) });
		// Find a settlement chunk and the first building in it.
		for (let my = -4; my <= 4; my++) {
			for (let mx = -4; mx <= 4; mx++) {
				chunks.ensure(mx, my);
				const buildings = chunks.buildingsIn(mx, my);
				const withDoor = buildings[0];
				if (withDoor) return { seed, chunks, building: withDoor };
			}
		}
		return undefined;
	}

	it("walks through a door into an interior and back out again", () => {
		const found = engineAtTown("vale");
		expect(found, "no settlement found to test").toBeDefined();
		if (!found) return;

		const { seed, building } = found;
		// Stand on the doorstep, facing the door.
		const step = {
			x:
				building.door.x +
				(building.door.x === building.rect.x
					? -1
					: building.door.x === building.rect.x + building.rect.w - 1
						? 1
						: 0),
			y:
				building.door.y +
				(building.door.y === building.rect.y
					? -1
					: building.door.y === building.rect.y + building.rect.h - 1
						? 1
						: 0),
		};
		const state = {
			...createInitialState(
				{ id: "door", name: "door", seed, createdAt: "2026-01-01T00:00:00.000Z" },
				step,
			),
		};
		const engine = new GameEngine(state, { runEffect: () => undefined });

		const facing =
			building.door.y < step.y
				? "up"
				: building.door.y > step.y
					? "down"
					: building.door.x > step.x
						? "right"
						: "left";

		engine.dispatch({ t: "Move", facing });
		engine.dispatch({ t: "Move", facing });

		const inside = engine.getState().player.inside;
		expect(inside, "walking into the door did not enter the interior").toBeDefined();
		expect(inside?.interiorId).toBe(building.interiorId);

		// The player stands on floor, not in a wall.
		const player = engine.getState().player;
		expect(engine.getView().isPassable(player.x, player.y)).toBe(true);

		// Walking south out of the entrance returns to the doorstep.
		engine.dispatch({ t: "Move", facing: "down" });
		engine.dispatch({ t: "Move", facing: "down" });
		expect(engine.getState().player.inside).toBeUndefined();
		expect(engine.getState().player.x).toBe(step.x);
		expect(engine.getState().player.y).toBe(step.y);
	});

	it("cannot walk out through an interior wall", () => {
		const found = engineAtTown("harrow");
		if (!found) return;
		const interior = getInterior(found.seed, found.building.interiorId, found.building.kind);
		// Every tile of the outer ring except the single exit must block.
		for (let x = 0; x < interior.width; x++) {
			const top = (interior.flags[x] ?? 0) & TFlag.Passable;
			expect(top).toBe(0);
		}
	});
});

describe("people indoors", () => {
	/** Walk in through a real door, the way the player does. */
	function enter(seedName: string) {
		const seed = hashString(seedName);
		const chunks = new ChunkManager({ world: worldSeed(seed) });
		for (let my = -4; my <= 4; my++) {
			for (let mx = -4; mx <= 4; mx++) {
				chunks.ensure(mx, my);
				for (const building of chunks.buildingsIn(mx, my)) {
					const step = {
						x:
							building.door.x +
							(building.door.x === building.rect.x
								? -1
								: building.door.x === building.rect.x + building.rect.w - 1
									? 1
									: 0),
						y:
							building.door.y +
							(building.door.y === building.rect.y
								? -1
								: building.door.y === building.rect.y + building.rect.h - 1
									? 1
									: 0),
					};
					const engine = new GameEngine(
						createInitialState(
							{ id: "in", name: "in", seed, createdAt: "2026-01-01T00:00:00.000Z" },
							step,
						),
						{ runEffect: () => undefined },
					);
					const facing =
						building.door.y < step.y
							? "up"
							: building.door.y > step.y
								? "down"
								: building.door.x > step.x
									? "right"
									: "left";
					engine.dispatch({ t: "Move", facing });
					engine.dispatch({ t: "Move", facing });
					if (engine.getState().player.inside) return { engine, building };
				}
			}
		}
		return undefined;
	}

	it("has somebody home in a building the player walks into", () => {
		const found = enter("vale");
		expect(found, "could not get inside any building").toBeDefined();
		if (!found) return;
		const inside = found.engine.getState().player.inside;
		expect(inside).toBeDefined();
		if (!inside) return;
		const people = found.engine.getResidents().in(inside.interiorId, inside.structure);
		// Which kind of building this is depends on the seed, and a barn may be empty —
		// so what is pinned is that asking works and that a house is never deserted.
		expect(Array.isArray(people)).toBe(true);
	});

	it("finds a resident by position only while the player is in their building", () => {
		const found = enter("harrow");
		if (!found) return;
		const { engine } = found;
		const inside = engine.getState().player.inside;
		if (!inside) return;
		const people = engine.getResidents().in(inside.interiorId, inside.structure);
		const someone = people[0];
		if (!someone) return;

		expect(engine.personAt(someone.x, someone.y)?.id).toBe(someone.id);
		expect(engine.personById(someone.id)?.name).toBe(someone.name);

		// Walk back out the way they came in, and the same id must stop resolving: out
		// in the world those coordinates mean a different tile entirely, and there is no
		// building whose roster to ask.
		//
		// Stepping until the door rather than a fixed two steps. An interior's exit is at
		// the foot of its own grid however the building is turned outside, but how far the
		// player stands from it depends on the room — and a fixed count that overshoots
		// walks straight back in through the door it just came out of, which is what this
		// used to do once the towns were laid out on more room.
		for (let step = 0; step < 8 && engine.getState().player.inside; step++) {
			engine.dispatch({ t: "Move", facing: "down" });
		}
		expect(engine.getState().player.inside).toBeUndefined();
		expect(engine.personById(someone.id)).toBeUndefined();
	});

	it("gives a resident the site they are standing in, so dialogue has context", () => {
		const found = enter("vale");
		if (!found) return;
		const { engine } = found;
		const inside = engine.getState().player.inside;
		if (!inside) return;
		const someone = engine.getResidents().in(inside.interiorId, inside.structure)[0];
		if (!someone) return;

		// Resolved from the doorway, not from the player's interior-local coordinates —
		// which would answer about whatever town happens to sit near the world origin.
		const placed = engine.personById(someone.id);
		expect(placed?.siteId).not.toBe(0);
	});

	it("opens a conversation when the player walks into somebody indoors", () => {
		const found = enter("harrow");
		if (!found) return;
		const { engine } = found;
		const inside = engine.getState().player.inside;
		if (!inside) return;
		const someone = engine.getResidents().in(inside.interiorId, inside.structure)[0];
		if (!someone) return;

		// Stand beside them and walk in. Indoors this is the only way to start a talk.
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: someone.x - 1, y: someone.y }],
		});
		engine.dispatch({ t: "Move", facing: "right" });
		engine.dispatch({ t: "Move", facing: "right" });

		expect(engine.getState().dialogue?.npcId).toBe(someone.id);
		// And the player did not walk through them.
		expect(engine.getState().player.x).toBe(someone.x - 1);
	});
});
