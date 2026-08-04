import { describe, expect, it } from "vitest";
import { computeFov, lightAt } from "../geom/fov.js";
import { hashString } from "../rand/hash.js";
import { timeOfDay, weatherAt } from "../world/weather.js";
import { verifyQuests } from "./quests.js";
import { reduce, type WorldProbe } from "./reduce.js";
import { basePrice, buyPrice, sellPrice, shopStock } from "./shop.js";
import { createInitialState, type GameState, type Quest } from "./state.js";

const SEED = hashString("polish");

const PROBE: WorldProbe = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
};

function withQuest(quest: Quest): GameState {
	const base = createInitialState(
		{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
		{ x: 0, y: 0 },
	);
	return { ...base, quests: [quest] };
}

function quest(objectives: Quest["objectives"]): Quest {
	return {
		id: "q",
		name: "The Errand",
		description: "",
		objectives,
		progress: [],
		completed: false,
	};
}

describe("engine-verified quests", () => {
	it("ticks off a 'have' objective the moment the item is carried", () => {
		const state = withQuest(quest([{ kind: "have", target: "Gold", quantity: 5, done: false }]));
		const { state: next, completed } = verifyQuests(state, {});
		expect(next.quests[0]?.objectives[0]?.done).toBe(true);
		expect(completed).toHaveLength(1);
	});

	it("does not tick off an objective the player has not met", () => {
		const state = withQuest(quest([{ kind: "have", target: "Brass Lamp", done: false }]));
		expect(verifyQuests(state, {}).state).toBe(state);
	});

	it("resolves 'reach' against the place the player is standing in", () => {
		const state = withQuest(quest([{ kind: "reach", target: "Mirefen", done: false }]));
		expect(verifyQuests(state, { placeName: "Mirefen" }).completed).toHaveLength(1);
		expect(verifyQuests(state, { placeName: "Coldhollow" }).completed).toHaveLength(0);
	});

	it("resolves 'talk' loosely, because targets come from prose", () => {
		const state = withQuest(quest([{ kind: "talk", target: "Wren", done: false }]));
		expect(verifyQuests(state, { talkedTo: "Wren Ashdown" }).completed).toHaveLength(1);
	});

	it("latches, so handing the item over does not un-complete the quest", () => {
		// This is the bug the naive reading produces: bring me the lamp, hand it
		// over, and the objective flips back to incomplete on the next command.
		const state = withQuest(quest([{ kind: "have", target: "Gold", quantity: 5, done: false }]));
		const ticked = verifyQuests(state, {}).state;
		const spent: GameState = { ...ticked, inventory: [] };
		expect(verifyQuests(spent, {}).state.quests[0]?.objectives[0]?.done).toBe(true);
	});

	it("never auto-completes a quest with no objectives", () => {
		// A quest with nothing to check is a note to self; only the model may close
		// one, or every one of them would complete the instant it was created.
		const state = withQuest(quest([]));
		expect(verifyQuests(state, {}).completed).toHaveLength(0);
	});

	it("closes through the reducer and writes a journal entry", () => {
		const state = withQuest(quest([{ kind: "flag", target: "spoke-to-smith", done: false }]));
		const next = reduce(
			state,
			{ t: "ApplyEffects", effects: [{ t: "SetFlag", key: "spoke-to-smith", value: true }] },
			PROBE,
		).state;
		expect(next.quests[0]?.completed).toBe(true);
		expect(next.journal.some((entry) => entry.text.includes("The Errand"))).toBe(true);
	});
});

describe("arrival", () => {
	it("is journalled once and only once", () => {
		const state = createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		const probe: WorldProbe = { ...PROBE, placeNameAt: () => "Ashreach" };

		const first = reduce(state, { t: "Move", facing: "down" }, probe).state;
		expect(first.journal.filter((e) => e.kind === "place")).toHaveLength(1);

		const second = reduce(first, { t: "Move", facing: "down" }, probe).state;
		expect(second.journal.filter((e) => e.kind === "place")).toHaveLength(1);
	});
});

describe("prices", () => {
	it("is stable for the same item name", () => {
		expect(basePrice("Iron Knife")).toBe(basePrice("Iron Knife"));
	});

	it("values a sword above a turnip", () => {
		expect(basePrice("Steel Sword")).toBeGreaterThan(basePrice("Turnip"));
	});

	it("never sells for more than it buys, at any disposition", () => {
		// Otherwise the player can farm gold by trading the same item back and
		// forth, which is the classic shop exploit.
		for (const disposition of [-100, -40, 0, 40, 100]) {
			const base = basePrice("Tin Lantern");
			expect(sellPrice(base, disposition)).toBeLessThan(buyPrice(base, disposition));
		}
	});

	it("moves prices with regard, but never to nothing", () => {
		const base = basePrice("Travelling Cloak");
		expect(buyPrice(base, 100)).toBeLessThan(buyPrice(base, -100));
		expect(buyPrice(base, 100)).toBeGreaterThanOrEqual(1);
	});

	it("gives a shop the same shelf every time", () => {
		const a = shopStock(SEED, 41, 0, "smithy");
		const b = shopStock(SEED, 41, 0, "smithy");
		expect(a).toEqual(b);
		expect(a.length).toBeGreaterThan(0);

		// Two smithies drawing from a five-item catalogue will sometimes match, so
		// the property worth asserting is variety across the world, not per pair.
		const shelves = new Set(
			Array.from({ length: 10 }, (_, i) =>
				JSON.stringify(shopStock(SEED, 100 + i, 0, "smithy").map((item) => item.name)),
			),
		);
		expect(shelves.size).toBeGreaterThan(1);
	});

	it("falls back to general goods for an unknown trade", () => {
		expect(shopStock(SEED, 1, 0, "cheesemonger").length).toBeGreaterThan(0);
	});
});

describe("weather and time", () => {
	it("is the same at the same tick and place", () => {
		expect(weatherAt(SEED, 500, 10, 20)).toEqual(weatherAt(SEED, 500, 10, 20));
	});

	it("changes over the course of a journey", () => {
		const skies = new Set<string>();
		for (let tick = 0; tick < 20_000; tick += 700) {
			skies.add(weatherAt(SEED, tick, 0, 0).sky);
		}
		expect(skies.size).toBeGreaterThan(1);
	});

	it("buckets the clock the way a schedule expects", () => {
		expect(timeOfDay(2)).toBe("night");
		expect(timeOfDay(9)).toBe("morning");
		expect(timeOfDay(14)).toBe("afternoon");
		expect(timeOfDay(23)).toBe("night");
	});
});

describe("field of view", () => {
	/** A room with a wall down the middle and a gap in it. */
	const blocks = (x: number, y: number) => x === 3 && y !== 0;

	it("lights the tile the viewer is standing on", () => {
		const fov = computeFov(0, 0, 6, () => false);
		expect(lightAt(fov, 0, 0)).toBe(1);
	});

	it("does not see through a wall", () => {
		const fov = computeFov(0, 0, 8, blocks);
		expect(lightAt(fov, 3, 4)).toBeGreaterThan(0); // the wall itself is visible
		expect(lightAt(fov, 6, 4)).toBe(0); // what is behind it is not
	});

	it("sees through the gap in the wall", () => {
		const fov = computeFov(0, 0, 8, blocks);
		expect(lightAt(fov, 6, 0)).toBeGreaterThan(0);
	});

	it("falls off with distance rather than ending in a hard edge", () => {
		const fov = computeFov(0, 0, 8, () => false);
		expect(lightAt(fov, 1, 0)).toBeGreaterThan(lightAt(fov, 7, 0));
		expect(lightAt(fov, 7, 0)).toBeGreaterThan(0);
	});

	it("reports nothing outside its own radius", () => {
		const fov = computeFov(0, 0, 4, () => false);
		expect(lightAt(fov, 40, 40)).toBe(0);
	});
});
