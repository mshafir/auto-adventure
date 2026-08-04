import { describe, expect, it } from "vitest";
import { reduce } from "../../core/rules/reduce.js";
import { createInitialState, type GameState } from "../../core/rules/state.js";
import { mapActions } from "./actions.js";
import type { ActionResponse } from "./schema.js";

const BASE = createInitialState(
	{ id: "t", name: "t", seed: 1, createdAt: "2026-01-01T00:00:00.000Z" },
	{ x: 0, y: 0 },
);

/** An action with every optional field absent, so each test states only what it
 * is about. This is also the shape a lazy model actually returns. */
function action(partial: Partial<ActionResponse> & Pick<ActionResponse, "kind">): ActionResponse {
	return {
		item: null,
		description: null,
		quantity: null,
		questId: null,
		questName: null,
		note: null,
		objectives: null,
		key: null,
		value: null,
		...partial,
	};
}

function map(actions: ActionResponse[], state: GameState = BASE) {
	return mapActions(actions, { state, npcId: "npc:1:0", npcName: "Wren" });
}

const NO_PROBE = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
};

describe("granting and taking", () => {
	it("grants an item with a sane default quantity", () => {
		expect(map([action({ kind: "giveItem", item: "Iron Key" })])).toEqual([
			{ t: "GrantItem", name: "Iron Key", description: "Given to you.", quantity: 1 },
		]);
	});

	it("drops a grant with no item name rather than inventing one", () => {
		expect(map([action({ kind: "giveItem" })])).toEqual([]);
		expect(map([action({ kind: "giveItem", item: "   " })])).toEqual([]);
	});

	it("never takes more than the player has", () => {
		// The model cannot see the inventory, so it must not be trusted with the
		// arithmetic. The starting purse is 12 gold.
		expect(map([action({ kind: "takeItem", item: "Gold", quantity: 50 })])).toEqual([
			{ t: "TakeItem", name: "Gold", quantity: 12 },
		]);
	});

	it("refuses to take something the player does not carry", () => {
		expect(map([action({ kind: "takeItem", item: "Silver Locket" })])).toEqual([]);
	});

	it("does not let two actions in one turn spend the same coin", () => {
		const effects = map([
			action({ kind: "takeItem", item: "Gold", quantity: 10 }),
			action({ kind: "takeItem", item: "Gold", quantity: 10 }),
		]);
		const total = effects.reduce((sum, e) => sum + (e.t === "TakeItem" ? e.quantity : 0), 0);
		expect(total).toBe(12);
	});

	it("clamps a gold payment to what is actually in the purse", () => {
		expect(map([action({ kind: "adjustGold", quantity: -100 })])).toEqual([
			{ t: "AdjustGold", amount: -12 },
		]);
	});

	it("caps a windfall so one turn cannot rewrite the economy", () => {
		const [effect] = map([action({ kind: "adjustGold", quantity: 1_000_000 })]);
		expect(effect).toEqual({ t: "AdjustGold", amount: 500 });
	});
});

describe("quests", () => {
	it("normalises the id so the same quest is one quest", () => {
		const created = map([
			action({ kind: "createQuest", questId: "Find the Lamp", questName: "Find the Lamp" }),
		]);
		const advanced = map([
			action({ kind: "advanceQuest", questId: "find-the-lamp", note: "Asked at the inn." }),
		]);
		expect(created[0]).toMatchObject({ t: "CreateQuest", id: "find-the-lamp" });
		expect(advanced[0]).toMatchObject({ t: "AdvanceQuest", id: "find-the-lamp" });
	});

	it("carries objectives through, dropping the malformed ones", () => {
		const [effect] = map([
			action({
				kind: "createQuest",
				questId: "lamp",
				questName: "The Lamp",
				objectives: [
					{ kind: "have", target: "Brass Lamp", quantity: 1 },
					{ kind: "talk", target: "  ", quantity: null },
				],
			}),
		]);
		expect(effect).toMatchObject({
			t: "CreateQuest",
			objectives: [{ kind: "have", target: "Brass Lamp", quantity: 1, done: false }],
		});
	});

	it("drops an advance with no note, which would be an empty log line", () => {
		expect(map([action({ kind: "advanceQuest", questId: "lamp" })])).toEqual([]);
	});

	it("is idempotent through the reducer, so a repeated quest is not duplicated", () => {
		const effects = map([action({ kind: "createQuest", questId: "lamp", questName: "The Lamp" })]);
		let state = reduce(BASE, { t: "ApplyEffects", effects }, NO_PROBE).state;
		state = reduce(state, { t: "ApplyEffects", effects }, NO_PROBE).state;
		expect(state.quests).toHaveLength(1);
	});
});

describe("disposition and journal", () => {
	it("clamps a disposition swing to a plausible step", () => {
		expect(map([action({ kind: "adjustDisposition", quantity: 900 })])).toEqual([
			{ t: "AdjustDisposition", npcId: "npc:1:0", delta: 15 },
		]);
	});

	it("ignores a zero-delta adjustment rather than emitting a no-op", () => {
		expect(map([action({ kind: "adjustDisposition", quantity: 0 })])).toEqual([]);
	});

	it("attributes a journal entry to whoever said it", () => {
		expect(map([action({ kind: "recordJournal", note: "The bridge is out." })])).toEqual([
			{
				t: "RecordJournal",
				entry: { kind: "rumor", text: "The bridge is out.", source: "Wren" },
			},
		]);
	});
});

describe("malformed input", () => {
	it("survives a turn where every field is null", () => {
		const everything = (
			[
				"giveItem",
				"takeItem",
				"adjustGold",
				"createQuest",
				"advanceQuest",
				"completeQuest",
				"setFlag",
				"adjustDisposition",
				"recordJournal",
				"heal",
			] as const
		).map((kind) => action({ kind }));
		expect(() => map(everything)).not.toThrow();
		expect(map(everything)).toEqual([]);
	});

	it("survives non-finite quantities", () => {
		expect(map([action({ kind: "heal", quantity: Number.NaN })])).toEqual([]);
		expect(
			map([action({ kind: "giveItem", item: "Bread", quantity: Number.POSITIVE_INFINITY })]),
		).toEqual([{ t: "GrantItem", name: "Bread", description: "Given to you.", quantity: 99 }]);
	});
});

describe("trade", () => {
	const STOCK = [
		{ name: "Tin Lantern", description: "Dented.", price: 18 },
		{ name: "Loaf and Cheese", description: "Yesterday's bread.", price: 3 },
	];

	function trade(actions: ActionResponse[], state: GameState = BASE) {
		return mapActions(actions, {
			state,
			npcId: "npc:1:0",
			npcName: "Wren",
			stock: STOCK,
			disposition: 0,
		});
	}

	it("charges the engine's price, not one the model made up", () => {
		// The action names the goods and a quantity; the price comes from the stock
		// list, so an NPC offering "a lantern, free for you" still costs 18 gold.
		const rich: GameState = {
			...BASE,
			inventory: [{ name: "Gold", description: "Coins.", quantity: 40 }],
		};
		expect(trade([action({ kind: "buy", item: "Tin Lantern", quantity: 1 })], rich)).toEqual([
			{ t: "AdjustGold", amount: -18 },
			{ t: "GrantItem", name: "Tin Lantern", description: "Dented.", quantity: 1 },
		]);
	});

	it("sells only as many as the player can afford", () => {
		// 12 gold buys four loaves at 3 each, not the ten that were asked for.
		const effects = trade([action({ kind: "buy", item: "Loaf and Cheese", quantity: 10 })]);
		expect(effects).toEqual([
			{ t: "AdjustGold", amount: -12 },
			{
				t: "GrantItem",
				name: "Loaf and Cheese",
				description: "Yesterday's bread.",
				quantity: 4,
			},
		]);
	});

	it("refuses a purchase the player cannot afford at all", () => {
		const broke: GameState = { ...BASE, inventory: [] };
		expect(trade([action({ kind: "buy", item: "Tin Lantern" })], broke)).toEqual([]);
	});

	it("refuses to sell what is not on the shelf", () => {
		expect(trade([action({ kind: "buy", item: "A Warhorse" })])).toEqual([]);
	});

	it("pays for something the player actually carries", () => {
		const carrying: GameState = {
			...BASE,
			inventory: [
				...BASE.inventory,
				{ name: "Brass Lamp", description: "Tarnished.", quantity: 1 },
			],
		};
		const effects = trade([action({ kind: "sell", item: "Brass Lamp" })], carrying);
		expect(effects[0]).toEqual({ t: "TakeItem", name: "Brass Lamp", quantity: 1 });
		expect(effects[1]).toMatchObject({ t: "AdjustGold" });
	});

	it("will not let the player sell their own purse", () => {
		expect(trade([action({ kind: "sell", item: "Gold", quantity: 5 })])).toEqual([]);
	});

	it("will not pay for something the player does not have", () => {
		expect(trade([action({ kind: "sell", item: "Brass Lamp" })])).toEqual([]);
	});
});

describe("grounding quest objectives", () => {
	/**
	 * An NPC has no inventory of the world, so it will happily send the player to a
	 * mill that was never built or after timber that exists nowhere. Such an
	 * objective can never be satisfied, and a quest carrying one hangs open forever
	 * — which is what happened in play. Targets are resolved against what the engine
	 * actually placed, the same posture `buy` already takes with prices.
	 */
	const WORLD = {
		place: "Harrowfen",
		buildings: [
			{ name: "Harrowmill Mill", kind: "mill" },
			{ name: "The Slaked Ox", kind: "inn" },
		],
		people: [{ name: "Wren", role: "miller" }],
		places: ["Stonecutter's Reach"],
		items: ["Coil of Rope"],
	};

	function quest(objectives: ActionResponse["objectives"], state: GameState = BASE) {
		const effects = mapActions([action({ kind: "createQuest", questName: "Errand", objectives })], {
			state,
			npcId: "npc:1:0",
			npcName: "Wren",
			surroundings: WORLD,
		});
		const created = effects.find((e) => e.t === "CreateQuest");
		return created?.t === "CreateQuest" ? created.objectives : undefined;
	}

	it("keeps an objective naming a building the generator placed", () => {
		expect(quest([{ kind: "reach", target: "the mill", quantity: null }])).toEqual([
			// Rewritten to the world's spelling, so the log and the place label agree.
			{ kind: "reach", target: "Harrowmill Mill", done: false },
		]);
	});

	it("drops an objective naming a building that does not exist", () => {
		expect(quest([{ kind: "reach", target: "the sawmill on the ridge", quantity: null }])).toEqual(
			[],
		);
	});

	it("keeps the quest when every objective is dropped", () => {
		// The NPC has already said the words aloud by the time this runs, so binning
		// the quest would contradict the conversation. A quest with no engine-checked
		// objective is a note to self, which only the model may close.
		const effects = mapActions(
			[
				action({
					kind: "createQuest",
					questName: "Errand",
					objectives: [{ kind: "have", target: "Moonsilver", quantity: null }],
				}),
			],
			{ state: BASE, npcId: "npc:1:0", npcName: "Wren", surroundings: WORLD },
		);
		const created = effects.find((e) => e.t === "CreateQuest");
		expect(created).toBeDefined();
		expect(created?.t === "CreateQuest" && created.objectives).toEqual([]);
	});

	it("drops a `have` objective for an item that exists nowhere", () => {
		expect(quest([{ kind: "have", target: "Timber", quantity: 3 }])).toEqual([]);
	});

	it("keeps a `have` objective for something on sale nearby", () => {
		expect(quest([{ kind: "have", target: "rope", quantity: 2 }])).toEqual([
			{ kind: "have", target: "Coil of Rope", quantity: 2, done: false },
		]);
	});

	it("keeps a `have` objective for something the player already carries", () => {
		// The item may have been picked up somewhere this conversation knows nothing
		// about, so the inventory counts as evidence that it exists.
		const carrying: GameState = {
			...BASE,
			inventory: [
				...BASE.inventory,
				{ name: "Millstone Grit", description: "Coarse.", quantity: 1 },
			],
		};
		expect(quest([{ kind: "have", target: "Millstone Grit", quantity: null }], carrying)).toEqual([
			{ kind: "have", target: "Millstone Grit", done: false },
		]);
	});

	it("resolves a `talk` objective only to someone who lives here", () => {
		expect(quest([{ kind: "talk", target: "Wren", quantity: null }])).toEqual([
			{ kind: "talk", target: "Wren", done: false },
		]);
		expect(quest([{ kind: "talk", target: "Aldric the Grey", quantity: null }])).toEqual([]);
	});

	it("lets a `reach` objective name a neighbouring settlement", () => {
		expect(quest([{ kind: "reach", target: "Stonecutter's Reach", quantity: null }])).toEqual([
			{ kind: "reach", target: "Stonecutter's Reach", done: false },
		]);
	});

	it("never checks a flag target, because a flag names nothing in the world", () => {
		expect(quest([{ kind: "flag", target: "spoke-to-the-council", quantity: null }])).toEqual([
			{ kind: "flag", target: "spoke-to-the-council", done: false },
		]);
	});

	it("passes targets through untouched when there are no surroundings", () => {
		// A missing wiring must degrade to the old behaviour rather than to no
		// quests at all, and every existing caller keeps working.
		const effects = map([
			action({
				kind: "createQuest",
				questName: "Errand",
				objectives: [{ kind: "reach", target: "anywhere at all", quantity: null }],
			}),
		]);
		const created = effects.find((e) => e.t === "CreateQuest");
		expect(created?.t === "CreateQuest" && created.objectives).toEqual([
			{ kind: "reach", target: "anywhere at all", done: false },
		]);
	});
});
