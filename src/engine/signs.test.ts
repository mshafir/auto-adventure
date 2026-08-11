import { describe, expect, it } from "vitest";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import type { Sign } from "../core/rules/signage.js";
import { createInitialState, type GameState } from "../core/rules/state.js";
import { D } from "../core/tiles/decor.js";
import { TFlag } from "../core/tiles/flags.js";
import type { WorldBounds } from "../core/world/bounds.js";
import { localIndex, toChunk } from "../core/world/coords.js";
import { isSettlement, macroSite, sitesInside } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import type { SiteSpec } from "../core/world/spec.js";
import { GameEngine } from "./engine.js";
import { findSpawn } from "./spawn.js";

/**
 * A signpost in a running world: stamped by the generator, read by the engine.
 *
 * Two halves that have to agree without talking to each other. The generator only ever
 * learns the *tile* — what a board says is a question about the whole world and not about
 * one chunk — and the engine composes the words when the player faces it. What binds them
 * is that both are handed the same list.
 */

const SEED = hashString("signpost-test");
const WORLD = worldSeed(SEED);

const BOUNDS: WorldBounds = {
	minX: -512,
	minY: -512,
	maxX: 512,
	maxY: 512,
	style: "ocean",
	thickness: 8,
};

/** Two settlements of this seed inside the boundary, so a board has somewhere to point. */
function towns(): { readonly id: number; readonly x: number; readonly y: number }[] {
	const found: { id: number; x: number; y: number }[] = [];
	for (const site of sitesInside(WORLD, BOUNDS).values()) {
		if (!isSettlement(site.kind)) continue;
		found.push({ id: site.id, x: site.site.x, y: site.site.y });
	}
	found.sort((a, b) => a.id - b.id);
	return found;
}

function spec(id: number, name: string): SiteSpec {
	return {
		siteId: id,
		name: `${name} on the Water`,
		shortName: name,
		description: "A town.",
		settlement: { name, walled: false, structures: [] },
		npcs: [],
		hooks: [],
	};
}

/** A tile the player can stand on beside the spawn, to plant a post on. */
function openTileNear(at: { readonly x: number; readonly y: number }) {
	const cc = toChunk(at.x, at.y);
	const { chunk } = generateChunk({ world: WORLD, bounds: BOUNDS }, cc);
	for (const [dx, dy] of [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[2, 0],
		[0, 2],
	] as const) {
		const x = at.x + dx;
		const y = at.y + dy;
		const local = toChunk(x, y);
		if (local.cx !== cc.cx || local.cy !== cc.cy) continue;
		const index = localIndex(x - cc.cx * 64, y - cc.cy * 64);
		if (((chunk.flags[index] ?? 0) & TFlag.Passable) !== 0) return { x, y };
	}
	throw new Error("no open ground beside the spawn to stand a post on");
}

describe("the generator putting up a post", () => {
	const spawn = findSpawn(WORLD, 12, BOUNDS);
	const spot = openTileNear(spawn);
	const cc = toChunk(spot.x, spot.y);
	const index = localIndex(spot.x - cc.cx * 64, spot.y - cc.cy * 64);

	it("stamps a signpost on the tile the scenario claims one is on", () => {
		const { chunk } = generateChunk({ world: WORLD, bounds: BOUNDS, signs: [spot] }, cc);
		expect(chunk.decor[index]).toBe(D.signpost);
	});

	/*
	 * Decor rather than terrain, which is what makes it safe to plant one anywhere: outdoor
	 * movement consults the terrain flag and nothing else, so a post cannot wall off a road
	 * or seal a bridge however badly it is placed.
	 */
	it("leaves the tile as walkable as it found it", () => {
		const bare = generateChunk({ world: WORLD, bounds: BOUNDS }, cc).chunk;
		const posted = generateChunk({ world: WORLD, bounds: BOUNDS, signs: [spot] }, cc).chunk;
		expect(posted.flags[index]).toBe(bare.flags[index]);
		expect(posted.terrain[index]).toBe(bare.terrain[index]);
	});

	/*
	 * A post is read by facing it, so one in deep water or in the cliffs closing the world is
	 * a promise attached to a bare tile. The validator refuses those where they can still be
	 * moved; this is the floor under it, for a scenario somebody hand-edited.
	 */
	it("declines ground nobody could stand on", () => {
		// The boundary band, which is cliffs or ocean by construction.
		const edge = { x: BOUNDS.minX + 1, y: 0 };
		const at = toChunk(edge.x, edge.y);
		const { chunk } = generateChunk({ world: WORLD, bounds: BOUNDS, signs: [edge] }, at);
		const where = localIndex(edge.x - at.cx * 64, edge.y - at.cy * 64);
		expect(chunk.decor[where]).toBe(0);
	});

	it("changes nothing at all in a world with no signs in it", () => {
		const bare = generateChunk({ world: WORLD, bounds: BOUNDS }, cc).chunk;
		const same = generateChunk({ world: WORLD, bounds: BOUNDS, signs: [] }, cc).chunk;
		expect([...same.decor]).toEqual([...bare.decor]);
	});
});

describe("the engine reading a board", () => {
	const spawn = findSpawn(WORLD, 12, BOUNDS);
	const spot = openTileNear(spawn);
	const [first, second] = towns();

	function engineWith(signs: readonly Sign[], sites: Readonly<Record<string, SiteSpec>> = {}) {
		const state: GameState = {
			...createInitialState(
				{ id: "t", name: "t", seed: SEED, createdAt: "", bounds: BOUNDS },
				spawn,
			),
			sites,
			signs,
		};
		return new GameEngine(state, { runEffect: () => {} });
	}

	it("says the place, the direction and the distance", () => {
		expect(first).toBeDefined();
		const engine = engineWith(
			[{ id: "s", x: spot.x, y: spot.y, arms: [{ siteId: first?.id as number }] }],
			{ [String(first?.id)]: spec(first?.id as number, "Aldermoor") },
		);
		const board = engine.signAt(spot.x, spot.y);
		expect(board).toContain("Aldermoor");
		expect(board).toMatch(/(to the (north|south|east|west)|you are here)/);
	});

	/*
	 * The short name, because a signpost is two lines of a fixed-height panel and "Aldermoor
	 * on the Water" spends both of them on one arm.
	 */
	it("paints the short name rather than the full one", () => {
		const engine = engineWith(
			[{ id: "s", x: spot.x, y: spot.y, arms: [{ siteId: first?.id as number }] }],
			{ [String(first?.id)]: spec(first?.id as number, "Aldermoor") },
		);
		expect(engine.signAt(spot.x, spot.y)).not.toContain("on the Water");
	});

	it("reads two arms when a board carries two", () => {
		expect(second, "this seed has only one settlement in range").toBeDefined();
		const engine = engineWith(
			[
				{
					id: "s",
					x: spot.x,
					y: spot.y,
					arms: [{ siteId: first?.id as number }, { siteId: second?.id as number }],
				},
			],
			{
				[String(first?.id)]: spec(first?.id as number, "Aldermoor"),
				[String(second?.id)]: spec(second?.id as number, "Saltgate"),
			},
		);
		const board = engine.signAt(spot.x, spot.y);
		expect(board).toContain("Aldermoor");
		expect(board).toContain("Saltgate");
	});

	it("answers nothing for a tile with no post on it", () => {
		const engine = engineWith([
			{ id: "s", x: spot.x, y: spot.y, arms: [{ siteId: first?.id as number }] },
		]);
		expect(engine.signAt(spot.x + 40, spot.y + 40)).toBeUndefined();
	});

	/*
	 * An arm naming a place the scenario does not describe has no name to paint, so it comes
	 * off the board — and a board with nothing left on it says nothing rather than saying
	 * "undefined: to the north".
	 */
	it("leaves off an arm for a place this world does not name", () => {
		const engine = engineWith([{ id: "s", x: spot.x, y: spot.y, arms: [{ siteId: 999_999 }] }]);
		expect(engine.signAt(spot.x, spot.y)).toBeUndefined();
	});

	it("reads the author's own label when the board carries one", () => {
		const engine = engineWith([
			{
				id: "s",
				x: spot.x,
				y: spot.y,
				arms: [{ siteId: first?.id as number, label: "the weighing station" }],
			},
		]);
		expect(engine.signAt(spot.x, spot.y)).toContain("the weighing station");
	});

	it("has nothing to say in a world with no signs", () => {
		expect(engineWith([]).signAt(spot.x, spot.y)).toBeUndefined();
	});
});

describe("a world with no boundary", () => {
	/*
	 * Signposts are a scenario feature, and a scenario is finite. Finding a site by id means
	 * sweeping every cell of the world, which only a bounded one can afford — so an unbounded
	 * world answers nothing rather than sweeping an infinite plane.
	 */
	it("has no positions to work a bearing from, and says nothing", () => {
		const spawn = findSpawn(WORLD);
		const [first] = towns();
		const state: GameState = {
			...createInitialState({ id: "t", name: "t", seed: SEED, createdAt: "" }, spawn),
			signs: [{ id: "s", x: spawn.x, y: spawn.y, arms: [{ siteId: first?.id as number }] }],
			sites: { [String(first?.id)]: spec(first?.id as number, "Aldermoor") },
		};
		const engine = new GameEngine(state, { runEffect: () => {} });
		expect(engine.signAt(spawn.x, spawn.y)).toBeUndefined();
	});

	it("still has a settlement of this seed to have pointed at", () => {
		// Guards the test above from passing for the wrong reason: an empty `towns()` would
		// make it pass whatever the engine did.
		expect(macroSite(WORLD, 0, 0)).toBeDefined();
		expect(towns().length).toBeGreaterThan(0);
	});
});
