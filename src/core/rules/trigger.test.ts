import { describe, expect, it } from "vitest";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState, itemCount } from "./state.js";
import { MAX_TRIGGER_PASSES, pendingTriggers, type Trigger, triggerKey } from "./trigger.js";

function world(overrides: Partial<WorldProbe> = {}): WorldProbe {
	return {
		isPassable: () => true,
		isLoaded: () => true,
		npcAt: () => undefined,
		...overrides,
	};
}

function base(triggers?: readonly Trigger[]): GameState {
	const state = createInitialState(
		{ id: "t", name: "t", seed: 1, createdAt: "" },
		{ x: 100, y: 100 },
	);
	return triggers ? { ...state, triggers } : state;
}

/** Step the reducer with a turn in place, which advances nothing else. */
function tick(state: GameState, probe = world()): GameState {
	return reduce(state, { t: "Move", facing: "left" }, probe).state;
}

describe("pendingTriggers", () => {
	/*
	 * The exception to "mark it fired when it fires", and it is not a tidy-up. A cutscene that
	 * was interrupted has applied only part of itself, so a world that recorded it as done
	 * would never play it again and never apply the rest — the chapter it was turning simply
	 * would not turn. `closeScene` writes the flag once the scene has actually ended.
	 */
	it("does not mark a scene-playing trigger fired when it fires", () => {
		const trigger: Trigger = {
			id: "arrive",
			when: { flag: "ready" },
			effects: [{ t: "PlayScene", id: "the-messenger-arrives" }],
		};
		const state = { ...base([trigger]), flags: { ready: true } };
		expect(pendingTriggers([trigger], state)).toEqual([
			{ t: "PlayScene", id: "the-messenger-arrives" },
		]);
	});

	it("returns nothing when there are no triggers", () => {
		expect(pendingTriggers(undefined, base())).toEqual([]);
		expect(pendingTriggers([], base())).toEqual([]);
	});

	it("fires a trigger whose condition holds, and marks it fired", () => {
		const trigger: Trigger = {
			id: "gate",
			when: { flag: "asked" },
			effects: [{ t: "SetFlag", key: "gate:open", value: true }],
		};
		const state = { ...base([trigger]), flags: { asked: true } };
		expect(pendingTriggers([trigger], state)).toEqual([
			{ t: "SetFlag", key: "gate:open", value: true },
			{ t: "SetFlag", key: triggerKey("gate"), value: true },
		]);
	});

	it("holds back a trigger whose condition does not hold", () => {
		const trigger: Trigger = { id: "gate", when: { flag: "asked" }, effects: [] };
		expect(pendingTriggers([trigger], base([trigger]))).toEqual([]);
	});

	it("fires a once-trigger exactly once", () => {
		const trigger: Trigger = {
			id: "gate",
			when: { flag: "asked" },
			effects: [{ t: "SetFlag", key: "gate:open", value: true }],
		};
		const fired = { ...base([trigger]), flags: { asked: true, [triggerKey("gate")]: true } };
		expect(pendingTriggers([trigger], fired)).toEqual([]);
	});

	it("keeps firing one asked to repeat, and does not mark it", () => {
		const trigger: Trigger = {
			id: "toll",
			when: { flag: "asked" },
			once: false,
			effects: [{ t: "AdjustGold", amount: -1 }],
		};
		const state = { ...base([trigger]), flags: { asked: true, [triggerKey("toll")]: true } };
		expect(pendingTriggers([trigger], state)).toEqual([{ t: "AdjustGold", amount: -1 }]);
	});

	it("keeps author order, because two firing together are a sequence", () => {
		const triggers: Trigger[] = [
			{ id: "a", when: { flag: "go" }, effects: [{ t: "SetFlag", key: "first", value: 1 }] },
			{ id: "b", when: { flag: "go" }, effects: [{ t: "SetFlag", key: "second", value: 2 }] },
		];
		const state = { ...base(triggers), flags: { go: true } };
		const keys = pendingTriggers(triggers, state).map((effect) =>
			effect.t === "SetFlag" ? effect.key : effect.t,
		);
		expect(keys).toEqual(["first", triggerKey("a"), "second", triggerKey("b")]);
	});
});

describe("triggers in reduce", () => {
	it("fires on the same command that made the condition true", () => {
		// Arriving somewhere is the archetype: the flag goes down in `recordArrival`
		// during this very command, and the trigger must not wait for the next one.
		const state = base([
			{
				id: "welcome",
				when: { visited: "Thornwick" },
				effects: [{ t: "SetFlag", key: "welcomed", value: true }],
			},
		]);
		const next = tick(state, world({ placeNameAt: () => "Thornwick" }));
		expect(next.flags.welcomed).toBe(true);
		expect(next.flags[triggerKey("welcome")]).toBe(true);
	});

	it("resolves a chain of triggers within one command", () => {
		const state = {
			...base([
				{
					id: "one",
					when: { flag: "start" },
					effects: [{ t: "SetFlag", key: "two", value: true }],
				},
				{
					id: "two",
					when: { flag: "two" },
					effects: [{ t: "SetFlag", key: "three", value: true }],
				},
				{
					id: "three",
					when: { flag: "three" },
					effects: [{ t: "SetFlag", key: "four", value: true }],
				},
			]),
			flags: { start: true },
		};
		const next = tick(state);
		expect(next.flags.four).toBe(true);
	});

	it("stops a chain at the pass limit rather than following it forever", () => {
		// One trigger per link, each waiting on the one before. More links than passes,
		// so the tail is left for the next command instead of spinning here.
		const links = MAX_TRIGGER_PASSES + 3;
		const triggers: Trigger[] = Array.from({ length: links }, (_, i) => ({
			id: `link${i}`,
			when: i === 0 ? { flag: "start" } : { flag: `step${i - 1}` },
			effects: [{ t: "SetFlag", key: `step${i}`, value: true }],
		}));
		const next = tick({ ...base(triggers), flags: { start: true } });
		expect(next.flags[`step${MAX_TRIGGER_PASSES - 1}`]).toBe(true);
		expect(next.flags[`step${links - 1}`]).toBeUndefined();
	});

	it("cannot hang the game on a trigger that repeats without progressing", () => {
		// The sharp edge `once: false` opens up: the condition is never changed by the
		// effects, so a fixed-point loop would never terminate.
		const state = {
			...base([
				{
					id: "bleed",
					when: { flag: "cursed" },
					once: false,
					effects: [{ t: "AdjustGold", amount: 1 }],
				},
			]),
			flags: { cursed: true },
		};
		const next = tick(state);
		// Bounded: it fires, repeatedly, but a bounded number of times.
		expect(itemCount(next, "Gold")).toBeGreaterThan(itemCount(state, "Gold"));
		expect(itemCount(next, "Gold")).toBeLessThanOrEqual(
			itemCount(state, "Gold") + MAX_TRIGGER_PASSES,
		);
	});

	it("ticks an objective a trigger's own gift satisfied, in the same command", () => {
		const state = {
			...base([
				{
					id: "gift",
					when: { flag: "asked" },
					effects: [{ t: "GrantItem", name: "Ledger", description: "A tally book.", quantity: 1 }],
				},
			]),
			flags: { asked: true },
			quests: [
				{
					id: "fetch",
					name: "The ledger",
					description: "",
					objectives: [{ kind: "have" as const, target: "Ledger", done: false }],
					progress: [],
					completed: false,
				},
			],
		};
		const next = tick(state);
		expect(next.quests[0]?.completed).toBe(true);
	});

	it("does nothing at all when no trigger qualifies", () => {
		const state = base([{ id: "a", when: { flag: "never" }, effects: [] }]);
		// Same object back where nothing happened, which is what keeps the store from
		// notifying and the frame from being redrawn. Walking into a wall the player is
		// already facing is the one command that changes nothing at all — turning to
		// face a new direction is itself a change.
		const probe = world({ isPassable: () => false });
		expect(reduce(state, { t: "Move", facing: "down" }, probe).state).toBe(state);
	});
});

/*
 * A conversation owns the screen until it ends.
 *
 * This is the rule that makes a beat's own cutscene work at all. A beat's flag is set the
 * moment its conversation *opens*, so a trigger watching for that beat used to fire while the
 * player was still reading the first line — the world was taken away mid-sentence, the scene
 * played over the top, and what the person had come to say happened afterwards as though it
 * were a second, unrelated conversation. Worse, the model's reply to the opening line arrived
 * while the scene held the world and was swallowed, so the panel underneath waited forever on
 * an answer that had already been thrown away.
 */
describe("a trigger that would take the screen", () => {
	const talking = (state: GameState): GameState => ({
		...state,
		dialogue: {
			npcId: "npc:1:0",
			npcName: "Ilse",
			lines: [],
			cursor: 0,
			choiceIndex: 0,
			pending: false,
		},
	});

	const scene: Trigger = {
		id: "arrive",
		when: { flag: "ready" },
		effects: [{ t: "PlayScene", id: "the-messenger-arrives" }],
	};
	const card: Trigger = {
		id: "news",
		when: { flag: "ready" },
		effects: [{ t: "ShowCard", card: { id: "news", title: "News", sections: ["It is over."] } }],
	};

	it("waits while a conversation is open", () => {
		const state = talking({ ...base([scene, card]), flags: { ready: true } });
		expect(pendingTriggers([scene, card], state)).toEqual([]);
	});

	it("fires the moment the conversation is not", () => {
		const state = { ...base([scene]), flags: { ready: true } };
		expect(pendingTriggers([scene], state)).toHaveLength(1);
	});

	it("lets a trigger that only moves the world through", () => {
		// Most triggers are invisible — a flag, an opened gate — and there is no reason for one
		// of those to wait for anybody. Only the ones that take the whole screen do.
		const quiet: Trigger = {
			id: "quiet",
			when: { flag: "ready" },
			effects: [{ t: "SetFlag", key: "the-tide-turned", value: true }],
		};
		const state = talking({ ...base([quiet]), flags: { ready: true } });
		expect(pendingTriggers([quiet], state)).toHaveLength(2);
	});
});
