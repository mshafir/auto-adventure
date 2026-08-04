import { describe, expect, it } from "vitest";
import { hashString } from "../rand/hash.js";
import { CHUNK, chunkKey } from "../world/coords.js";
import { isSettlement, macroSite } from "../world/macro.js";
import { bearingTo, questChunks, questMarks } from "./quest-map.js";
import { createInitialState, type GameState, type Quest } from "./state.js";

const SEED = hashString("vale");
const WORLD = { id: "t", name: "T", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" };

/** A settled chunk in this seed, so the test targets somewhere that exists. */
function findSettlement(): { cx: number; cy: number; siteId: number } {
	for (let cx = -6; cx <= 6; cx++) {
		for (let cy = -6; cy <= 6; cy++) {
			const site = macroSite(SEED, cx, cy);
			if (isSettlement(site.kind)) return { cx, cy, siteId: site.id };
		}
	}
	throw new Error("no settlement in range");
}

const TOWN = findSettlement();

function quest(overrides: Partial<Quest> = {}): Quest {
	return {
		id: "q1",
		name: "Timber",
		description: "Fetch it from the mill.",
		objectives: [{ kind: "have", target: "Timber", done: false }],
		progress: [],
		completed: false,
		...overrides,
	};
}

function stateWith(quests: Quest[], discovered: string[]): GameState {
	return {
		...createInitialState(WORLD, { x: 0, y: 0 }),
		quests,
		discovered,
	};
}

describe("locating an open errand", () => {
	it("finds the chunk of the settlement that gave it out", () => {
		const state = stateWith([quest({ siteId: TOWN.siteId })], [chunkKey(TOWN.cx, TOWN.cy)]);
		expect(questMarks(state)).toEqual([
			{ questId: "q1", name: "Timber", cx: TOWN.cx, cy: TOWN.cy },
		]);
	});

	it("marks nothing for a chunk the player has never seen", () => {
		// A deliberate limit: the problem worth solving is "which of the towns I have
		// visited was that", not directions to somewhere unvisited.
		const state = stateWith([quest({ siteId: TOWN.siteId })], []);
		expect(questMarks(state)).toEqual([]);
	});

	it("marks nothing for a quest with no recorded site", () => {
		// Quests from before this existed, and any the engine could not place.
		const state = stateWith([quest()], [chunkKey(TOWN.cx, TOWN.cy)]);
		expect(questMarks(state)).toEqual([]);
	});

	it("ignores a completed quest", () => {
		const state = stateWith(
			[quest({ siteId: TOWN.siteId, completed: true })],
			[chunkKey(TOWN.cx, TOWN.cy)],
		);
		expect(questMarks(state)).toEqual([]);
	});

	it("reports the chunk keys the minimap should mark", () => {
		const state = stateWith([quest({ siteId: TOWN.siteId })], [chunkKey(TOWN.cx, TOWN.cy)]);
		expect(questChunks(state).has(chunkKey(TOWN.cx, TOWN.cy))).toBe(true);
	});

	it("does no work when there are no quests", () => {
		const state = stateWith([], [chunkKey(TOWN.cx, TOWN.cy)]);
		expect(questMarks(state)).toEqual([]);
	});
});

describe("bearings", () => {
	it("points the right way on each axis", () => {
		// Screen coordinates: y grows south, so north is negative. Measuring the
		// angle the mathematical way round would invert every one of these.
		expect(bearingTo(0, 0, 0, -3)?.compass).toBe("N");
		expect(bearingTo(0, 0, 0, 3)?.compass).toBe("S");
		expect(bearingTo(0, 0, 3, 0)?.compass).toBe("E");
		expect(bearingTo(0, 0, -3, 0)?.compass).toBe("W");
	});

	it("points the right way on the diagonals", () => {
		expect(bearingTo(0, 0, 2, -2)?.compass).toBe("NE");
		expect(bearingTo(0, 0, 2, 2)?.compass).toBe("SE");
		expect(bearingTo(0, 0, -2, 2)?.compass).toBe("SW");
		expect(bearingTo(0, 0, -2, -2)?.compass).toBe("NW");
	});

	it("measures distance in chunks the player can act on", () => {
		expect(bearingTo(0, 0, 3, 0)?.distance).toBe(3);
		expect(bearingTo(0, 0, 3, -4)?.distance).toBe(4);
	});

	it("gives no bearing for the chunk the player is standing in", () => {
		// A direction would be actively misleading; the caller says "here" instead.
		expect(bearingTo(2, 2, 2, 2)).toBeUndefined();
	});

	it("works from a negative origin", () => {
		expect(bearingTo(-5, -5, -5, -8)?.compass).toBe("N");
		expect(bearingTo(-5, -5, -2, -5)?.compass).toBe("E");
	});
});

describe("the chunk a player stands in", () => {
	it("agrees with the marker for the town they are in", () => {
		// Guards the sign convention end to end: standing in the marked town must
		// read as "here", not as a bearing pointing somewhere else.
		const state: GameState = {
			...stateWith([quest({ siteId: TOWN.siteId })], [chunkKey(TOWN.cx, TOWN.cy)]),
			player: {
				...createInitialState(WORLD, { x: 0, y: 0 }).player,
				x: TOWN.cx * CHUNK + 1,
				y: TOWN.cy * CHUNK + 1,
			},
		};
		const mark = questMarks(state)[0];
		expect(mark).toBeDefined();
		if (!mark) return;
		expect(bearingTo(TOWN.cx, TOWN.cy, mark.cx, mark.cy)).toBeUndefined();
	});
});
