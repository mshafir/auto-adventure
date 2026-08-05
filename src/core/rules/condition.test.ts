import { describe, expect, it } from "vitest";
import { asCondition, type Condition, evaluate, flagsRead, npcsRead } from "./condition.js";
import { ConditionSchema, RequiresSchema } from "./condition-schema.js";
import { createNpcRecord } from "./npc.js";
import { createInitialState, type GameState, timeFromTick, visitedKey } from "./state.js";

function base(): GameState {
	return createInitialState(
		{
			id: "test",
			name: "test",
			seed: 1,
			createdAt: "2020-01-01T00:00:00.000Z",
		},
		{ x: 0, y: 0 },
	);
}

function withFlags(flags: GameState["flags"]): GameState {
	return { ...base(), flags };
}

describe("evaluate", () => {
	it("holds when there is nothing to require", () => {
		expect(evaluate(undefined, base())).toBe(true);
	});

	it("reads a flag as truthiness, and with equals as a value", () => {
		const state = withFlags({ open: true, closed: false, side: "left", count: 0 });
		expect(evaluate({ flag: "open" }, state)).toBe(true);
		expect(evaluate({ flag: "closed" }, state)).toBe(false);
		expect(evaluate({ flag: "missing" }, state)).toBe(false);
		// A flag set to 0 or "" is falsy but present, which `equals` can still see.
		expect(evaluate({ flag: "count" }, state)).toBe(false);
		expect(evaluate({ flag: "count", equals: 0 }, state)).toBe(true);
		expect(evaluate({ flag: "side", equals: "left" }, state)).toBe(true);
		expect(evaluate({ flag: "side", equals: "right" }, state)).toBe(false);
	});

	it("counts items, defaulting to one", () => {
		const state: GameState = {
			...base(),
			inventory: [{ name: "Timber", description: "", quantity: 3 }],
		};
		expect(evaluate({ item: "Timber" }, state)).toBe(true);
		expect(evaluate({ item: "timber", atLeast: 3 }, state)).toBe(true);
		expect(evaluate({ item: "Timber", atLeast: 4 }, state)).toBe(false);
		expect(evaluate({ item: "Rope" }, state)).toBe(false);
	});

	it("tells an open quest from a finished one from an absent one", () => {
		const open = {
			id: "a",
			name: "A",
			description: "",
			objectives: [],
			progress: [],
			completed: false,
		};
		const state: GameState = { ...base(), quests: [open, { ...open, id: "b", completed: true }] };
		expect(evaluate({ quest: "a", is: "open" }, state)).toBe(true);
		expect(evaluate({ quest: "a", is: "done" }, state)).toBe(false);
		expect(evaluate({ quest: "b", is: "done" }, state)).toBe(true);
		expect(evaluate({ quest: "b", is: "open" }, state)).toBe(false);
		expect(evaluate({ quest: "c", is: "absent" }, state)).toBe(true);
		expect(evaluate({ quest: "a", is: "absent" }, state)).toBe(false);
	});

	it("reads whether an npc has been spoken to", () => {
		const met = createNpcRecord({ id: "npc:1:0", name: "Ott", role: "smith", siteId: 1 });
		const state: GameState = {
			...base(),
			npcs: { "npc:1:0": { ...met, totalTurns: 2 }, "npc:1:1": met },
		};
		expect(evaluate({ talked: "npc:1:0" }, state)).toBe(true);
		// Known but never actually spoken to: the record exists from being met.
		expect(evaluate({ talked: "npc:1:1" }, state)).toBe(false);
		expect(evaluate({ talked: "npc:9:9" }, state)).toBe(false);
	});

	it("reads arrival through the same key recordArrival writes", () => {
		const state = withFlags({ [visitedKey("Thornwick")]: true });
		expect(evaluate({ visited: "Thornwick" }, state)).toBe(true);
		// Case-insensitive, because the key is lower-cased on both sides.
		expect(evaluate({ visited: "thornwick" }, state)).toBe(true);
		expect(evaluate({ visited: "Harrowfen" }, state)).toBe(false);
	});

	it("bounds reputation from either side", () => {
		const state: GameState = { ...base(), reputation: { levy: 40 } };
		expect(evaluate({ reputation: "levy", atLeast: 30 }, state)).toBe(true);
		expect(evaluate({ reputation: "levy", atLeast: 50 }, state)).toBe(false);
		expect(evaluate({ reputation: "levy", atMost: 50 }, state)).toBe(true);
		expect(evaluate({ reputation: "levy", atLeast: 30, atMost: 35 }, state)).toBe(false);
		// An unknown faction is neutral, which is a real answer rather than absence.
		expect(evaluate({ reputation: "guild", atMost: 0 }, state)).toBe(true);
	});

	it("treats an unmet npc as having no disposition rather than a neutral one", () => {
		const record = createNpcRecord({ id: "npc:1:0", name: "Ott", role: "smith", siteId: 1 });
		const state: GameState = { ...base(), npcs: { "npc:1:0": { ...record, disposition: -30 } } };
		expect(evaluate({ disposition: "npc:1:0", atMost: -20 }, state)).toBe(true);
		expect(evaluate({ disposition: "npc:1:0", atLeast: 0 }, state)).toBe(false);
		// Not "neutral, so atMost: 0 holds" — a stranger fails either way.
		expect(evaluate({ disposition: "npc:9:9", atMost: 0 }, state)).toBe(false);
		expect(evaluate({ disposition: "npc:9:9", atLeast: 0 }, state)).toBe(false);
	});

	it("reads the hour, including a window across midnight", () => {
		const at = (hour: number): GameState => ({ ...base(), time: timeFromTick(hour * 60) });
		expect(evaluate({ hour: { from: 8, to: 12 } }, at(8))).toBe(true);
		expect(evaluate({ hour: { from: 8, to: 12 } }, at(11))).toBe(true);
		// `to` is exclusive, so two adjacent windows cannot both claim an hour.
		expect(evaluate({ hour: { from: 8, to: 12 } }, at(12))).toBe(false);
		expect(evaluate({ hour: { from: 22, to: 5 } }, at(23))).toBe(true);
		expect(evaluate({ hour: { from: 22, to: 5 } }, at(2))).toBe(true);
		expect(evaluate({ hour: { from: 22, to: 5 } }, at(12))).toBe(false);
	});

	it("combines with all, any and not, to arbitrary depth", () => {
		const state = withFlags({ a: true, b: true, c: false });
		expect(evaluate({ all: [{ flag: "a" }, { flag: "b" }] }, state)).toBe(true);
		expect(evaluate({ all: [{ flag: "a" }, { flag: "c" }] }, state)).toBe(false);
		expect(evaluate({ any: [{ flag: "c" }, { flag: "a" }] }, state)).toBe(true);
		expect(evaluate({ not: { flag: "c" } }, state)).toBe(true);
		expect(
			evaluate(
				{
					all: [
						{ any: [{ flag: "c" }, { not: { flag: "c" } }] },
						{ not: { any: [{ flag: "c" }] } },
					],
				},
				state,
			),
		).toBe(true);
	});

	it("reads an empty all as true and an empty any as false", () => {
		// The honest readings, and both fall out of the array methods: nothing
		// listed fails, and nothing listed succeeds.
		expect(evaluate({ all: [] }, base())).toBe(true);
		expect(evaluate({ any: [] }, base())).toBe(false);
	});
});

describe("asCondition", () => {
	it("lowers a flag list to the same answer the list form gave", () => {
		const state = withFlags({ a: true, b: true });
		expect(evaluate(asCondition(["a", "b"]), state)).toBe(true);
		expect(evaluate(asCondition(["a", "z"]), state)).toBe(false);
	});

	it("treats nothing to require as no requirement", () => {
		expect(asCondition(undefined)).toBeUndefined();
		expect(asCondition([])).toBeUndefined();
		// Blank entries are noise from hand-editing, not a gate on the empty flag.
		expect(asCondition([""])).toBeUndefined();
	});

	it("passes a condition through untouched", () => {
		const condition: Condition = { item: "Rope" };
		expect(asCondition(condition)).toBe(condition);
	});
});

describe("flagsRead and npcsRead", () => {
	it("collect every name the validator would need to check", () => {
		const condition: Condition = {
			all: [
				{ flag: "levy:paid" },
				{ any: [{ visited: "Thornwick" }, { not: { talked: "npc:1:0" } }] },
				{ disposition: "npc:2:1", atLeast: 10 },
			],
		};
		expect([...flagsRead(condition)].sort()).toEqual(["levy:paid", visitedKey("Thornwick")]);
		expect([...npcsRead(condition)].sort()).toEqual(["npc:1:0", "npc:2:1"]);
	});
});

describe("ConditionSchema", () => {
	it("accepts every leaf and the combinators", () => {
		const conditions: Condition[] = [
			{ flag: "a" },
			{ flag: "a", equals: 3 },
			{ item: "Rope", atLeast: 2 },
			{ quest: "q", is: "done" },
			{ talked: "npc:1:0" },
			{ visited: "Thornwick" },
			{ reputation: "levy", atLeast: -20, atMost: 40 },
			{ disposition: "npc:1:0", atLeast: 5 },
			{ hour: { from: 22, to: 5 } },
			{ not: { all: [{ flag: "a" }, { any: [{ flag: "b" }] }] } },
		];
		for (const condition of conditions) {
			expect(ConditionSchema.safeParse(condition).success, JSON.stringify(condition)).toBe(true);
		}
	});

	it("refuses shapes the evaluator has no branch for", () => {
		expect(ConditionSchema.safeParse({ nonsense: 1 }).success).toBe(false);
		expect(ConditionSchema.safeParse({ quest: "q" }).success).toBe(false);
		expect(ConditionSchema.safeParse({ quest: "q", is: "maybe" }).success).toBe(false);
		expect(ConditionSchema.safeParse({ hour: { from: 0, to: 24 } }).success).toBe(false);
		expect(ConditionSchema.safeParse({ flag: "" }).success).toBe(false);
	});

	it("refuses a condition nested past the depth limit", () => {
		let deep: Condition = { flag: "a" };
		for (let i = 0; i < 8; i++) deep = { not: deep };
		expect(ConditionSchema.safeParse(deep).success).toBe(false);

		let shallow: Condition = { flag: "a" };
		for (let i = 0; i < 6; i++) shallow = { not: shallow };
		expect(ConditionSchema.safeParse(shallow).success).toBe(true);
	});

	it("accepts a requires field in either spelling", () => {
		expect(RequiresSchema.safeParse(["a", "b"]).success).toBe(true);
		expect(RequiresSchema.safeParse({ item: "Rope" }).success).toBe(true);
		expect(RequiresSchema.safeParse("a").success).toBe(false);
	});
});
