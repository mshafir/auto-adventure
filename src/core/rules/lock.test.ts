import { describe, expect, it } from "vitest";
import { T, terrainDef } from "../tiles/terrain.js";
import { chunkKey, localIndex, toChunkX, toChunkY, toLocalX, toLocalY } from "../world/coords.js";
import { type Barrier, barrierIndex, barrierKey, barrierOpen } from "./lock.js";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState } from "./state.js";

const SPAWN = { x: 100, y: 100 };

function base(overrides: Partial<GameState> = {}): GameState {
	return {
		...createInitialState({ id: "t", name: "t", seed: 1, createdAt: "" }, SPAWN),
		...overrides,
	};
}

function world(overrides: Partial<WorldProbe> = {}): WorldProbe {
	return {
		isPassable: () => true,
		isLoaded: () => true,
		npcAt: () => undefined,
		...overrides,
	};
}

/** Step down, which is the facing a new player already has. */
function stepDown(state: GameState, probe: WorldProbe) {
	return reduce(state, { t: "Move", facing: "down" }, probe);
}

const AHEAD = { x: SPAWN.x, y: SPAWN.y + 1 };

describe("locked doors", () => {
	const door = {
		interiorId: 7,
		structure: "smithy",
		name: "The Cold Forge",
		lock: { opensWhen: { flag: "smith:trusts" as const }, lockedText: "The forge door is barred." },
	};
	const probe = world({
		doorAt: (x, y) => (x === AHEAD.x && y === AHEAD.y ? door : undefined),
		interiorEntrance: () => ({ x: 5, y: 7 }),
	});

	it("refuses entry and says why", () => {
		const { state } = stepDown(base(), probe);
		expect(state.notice).toBe("The forge door is barred.");
		expect(state.player.inside).toBeUndefined();
		// Not even the turn: being refused at a door is not an action.
		expect(state.player.x).toBe(SPAWN.x);
		expect(state.player.y).toBe(SPAWN.y);
	});

	it("lets the player in once the condition holds", () => {
		const { state } = stepDown(base({ flags: { "smith:trusts": true } }), probe);
		expect(state.player.inside?.interiorId).toBe(7);
		expect(state.notice).toBeUndefined();
	});

	it("leaves an unlocked door exactly as it was", () => {
		const { lock: _lock, ...open } = door;
		const { state } = stepDown(
			base(),
			world({
				doorAt: (x, y) => (x === AHEAD.x && y === AHEAD.y ? open : undefined),
				interiorEntrance: () => ({ x: 5, y: 7 }),
			}),
		);
		expect(state.player.inside?.interiorId).toBe(7);
	});
});

describe("barriers", () => {
	const barrier: Barrier = {
		id: "levy-gate",
		tiles: [AHEAD],
		opensWhen: { item: "Toll Token" },
		lockedText: "The gate is barred. A tollhouse window is shuttered beside it.",
		opensText: "The bar lifts, and the gate swings inward.",
	};
	const probe = world({
		barrierAt: (x, y) => (x === AHEAD.x && y === AHEAD.y ? barrier : undefined),
	});

	/**
	 * A world that knows about the gate.
	 *
	 * `OpenBarrier` carries only an id and looks the span up in state, the way
	 * `CompleteQuest` looks a quest up — so a gate the world has never heard of cannot be
	 * opened, which is the property the last test here pins down.
	 */
	const withGate = (overrides: Partial<GameState> = {}) =>
		base({ barriers: [barrier], ...overrides });

	it("refuses the step and says why", () => {
		const { state } = stepDown(withGate(), probe);
		expect(state.notice).toBe(barrier.lockedText);
		expect(state.player.y).toBe(SPAWN.y);
		expect(barrierOpen(state.flags, barrier.id)).toBe(false);
	});

	it("opens on the step that satisfies it, without walking through yet", () => {
		const carrying = withGate({
			inventory: [{ name: "Toll Token", description: "A pierced lead disc.", quantity: 1 }],
		});
		const { state } = stepDown(carrying, probe);
		expect(state.notice).toBe(barrier.opensText);
		expect(barrierOpen(state.flags, barrier.id)).toBe(true);
		// Unbarring costs the turn; the player is still on the near side.
		expect(state.player.y).toBe(SPAWN.y);
		expect(state.time.tick).toBe(carrying.time.tick + 1);
	});

	it("writes the open gate into the delta map, so it survives eviction", () => {
		const carrying = withGate({
			inventory: [{ name: "Toll Token", description: "", quantity: 1 }],
		});
		const { state } = stepDown(carrying, probe);
		const key = chunkKey(toChunkX(AHEAD.x), toChunkY(AHEAD.y));
		const tiles = state.deltas[key]?.tiles ?? [];
		// The registry's own flags, not a copied number: a delta carries an explicit
		// flag set, and one that disagreed with the terrain would produce a gate that
		// looks open and is not walkable.
		expect(tiles).toEqual([
			localIndex(toLocalX(AHEAD.x), toLocalY(AHEAD.y)),
			T.gateOpen,
			terrainDef(T.gateOpen).flags,
		]);
	});

	it("steps through freely once open", () => {
		const opened = withGate({ flags: { [barrierKey(barrier.id)]: true } });
		const { state } = stepDown(opened, probe);
		expect(state.player.y).toBe(SPAWN.y + 1);
		expect(state.notice).toBeUndefined();
	});

	it("does not write the delta a second time if the effect is re-applied", () => {
		// A partially-saved turn can re-apply an effect, and a delta list that grew
		// every time would bloat the save with duplicate writes of the same tile.
		const carrying = withGate({
			inventory: [{ name: "Toll Token", description: "", quantity: 1 }],
		});
		const first = stepDown(carrying, probe).state;
		const again = reduce(
			first,
			{ t: "ApplyEffects", effects: [{ t: "OpenBarrier", id: barrier.id }] },
			probe,
		).state;
		const key = chunkKey(toChunkX(AHEAD.x), toChunkY(AHEAD.y));
		expect(again.deltas[key]?.tiles).toHaveLength(3);
	});

	it("opens the whole span, not the one tile the player faced", () => {
		// A gate is as wide as the road, and a save that recorded only the tile walked
		// into would come back with a hole in the middle of an open gate.
		const wide: Barrier = {
			...barrier,
			tiles: [AHEAD, { x: AHEAD.x + 1, y: AHEAD.y }, { x: AHEAD.x + 2, y: AHEAD.y }],
		};
		const carrying = base({
			barriers: [wide],
			inventory: [{ name: "Toll Token", description: "", quantity: 1 }],
		});
		const { state } = stepDown(
			carrying,
			world({ barrierAt: (_x, y) => (y === AHEAD.y ? wide : undefined) }),
		);
		const key = chunkKey(toChunkX(AHEAD.x), toChunkY(AHEAD.y));
		// Three tiles, three triples.
		expect(state.deltas[key]?.tiles).toHaveLength(9);
	});

	it("cannot open a gate the world has never heard of", () => {
		const { state } = reduce(
			base(),
			{ t: "ApplyEffects", effects: [{ t: "OpenBarrier", id: "invented" }] },
			probe,
		);
		expect(state.flags[barrierKey("invented")]).toBeUndefined();
		expect(state.deltas).toEqual({});
	});

	it("is checked before the door behind it", () => {
		// A gatehouse is both: barred tile, guardroom behind. Being told the way is
		// barred beats being silently refused entry to the guardroom.
		const { state } = stepDown(
			withGate(),
			world({
				barrierAt: () => barrier,
				doorAt: () => ({ interiorId: 1, structure: "tower" }),
				interiorEntrance: () => ({ x: 1, y: 1 }),
			}),
		);
		expect(state.notice).toBe(barrier.lockedText);
		expect(state.player.inside).toBeUndefined();
	});
});

describe("barrierIndex", () => {
	it("keys by position, and copes with none", () => {
		const barrier: Barrier = {
			id: "a",
			tiles: [
				{ x: 3, y: -4 },
				{ x: 4, y: -4 },
			],
			opensWhen: { flag: "f" },
			lockedText: "",
		};
		// Every tile of the span points at the one gate, so whichever the player walks
		// into is the same gate with the same flag.
		const index = barrierIndex([barrier]);
		expect(index.get("3,-4")).toBe(barrier);
		expect(index.get("4,-4")).toBe(barrier);
		expect(barrierIndex(undefined).size).toBe(0);
	});
});
