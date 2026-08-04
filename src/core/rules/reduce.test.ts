import { describe, expect, it } from "vitest";
import type { Command } from "./commands.js";
import type { DomainEffect } from "./effects.js";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState, START_TICK } from "./state.js";

const WORLD = { id: "test", name: "Test", seed: 1234, createdAt: "2026-01-01T00:00:00.000Z" };

function makeState(overrides: Partial<GameState> = {}): GameState {
	return { ...createInitialState(WORLD, { x: 10, y: 10 }), ...overrides };
}

/** A world that is open everywhere except an explicit wall set. */
function probe(
	options: {
		walls?: ReadonlySet<string>;
		unloaded?: ReadonlySet<string>;
		npcs?: ReadonlyMap<string, { id: string; name: string }>;
	} = {},
): WorldProbe {
	const key = (x: number, y: number) => `${x},${y}`;
	return {
		isPassable: (x, y) => !options.walls?.has(key(x, y)),
		isLoaded: (x, y) => !options.unloaded?.has(key(x, y)),
		npcAt: (x, y) => options.npcs?.get(key(x, y)),
	};
}

function run(state: GameState, commands: readonly Command[], world = probe()) {
	let current = state;
	const effects = [];
	for (const command of commands) {
		const result = reduce(current, command, world);
		current = result.state;
		effects.push(...result.effects);
	}
	return { state: current, effects };
}

describe("movement", () => {
	it("turns to face a new direction without moving or spending time", () => {
		const start = makeState();
		const { state } = run(start, [{ t: "Move", facing: "right" }]);
		expect(state.player.facing).toBe("right");
		expect([state.player.x, state.player.y]).toEqual([10, 10]);
		// Turning must be free, or looking at a sign costs you an hour.
		expect(state.time.tick).toBe(start.time.tick);
	});

	it("moves when already facing that way", () => {
		const { state } = run(makeState(), [
			{ t: "Move", facing: "right" },
			{ t: "Move", facing: "right" },
		]);
		expect([state.player.x, state.player.y]).toEqual([11, 10]);
		// The clock is derived from `tick` alone and a new world opens at 08:00,
		// so what matters is the step, not the absolute value.
		expect(state.time.tick).toBe(START_TICK + 1);
	});

	it("refuses to walk into a wall and does not spend time", () => {
		const walls = new Set(["11,10"]);
		const { state } = run(
			makeState({ player: { x: 10, y: 10, facing: "right", hp: 20, maxHp: 20 } }),
			[{ t: "Move", facing: "right" }],
			probe({ walls }),
		);
		expect([state.player.x, state.player.y]).toEqual([10, 10]);
		expect(state.time.tick).toBe(START_TICK);
	});

	it("refuses to step into ungenerated ground and asks for it instead", () => {
		const unloaded = new Set(["11,10"]);
		const { state, effects } = run(
			makeState({ player: { x: 10, y: 10, facing: "right", hp: 20, maxHp: 20 } }),
			[{ t: "Move", facing: "right" }],
			probe({ unloaded }),
		);
		expect([state.player.x, state.player.y]).toEqual([10, 10]);
		expect(effects.some((e) => e.t === "EnsureChunk")).toBe(true);
	});

	it("crosses a chunk boundary without any transition", () => {
		// The player walks from chunk 0 into chunk 1 and simply keeps going;
		// there is no map swap and no repositioning.
		let state = makeState({ player: { x: 62, y: 10, facing: "right", hp: 20, maxHp: 20 } });
		for (let i = 0; i < 4; i++) {
			state = reduce(state, { t: "Move", facing: "right" }, probe()).state;
		}
		expect(state.player.x).toBe(66);
		expect(state.player.y).toBe(10);
	});

	it("records every chunk it enters as discovered, without duplicates", () => {
		let state = makeState({ player: { x: 62, y: 10, facing: "right", hp: 20, maxHp: 20 } });
		for (let i = 0; i < 8; i++) {
			state = reduce(state, { t: "Move", facing: "right" }, probe()).state;
		}
		expect(new Set(state.discovered).size).toBe(state.discovered.length);
		expect(state.discovered).toContain("1,0");
	});

	it("advances the clock and rolls hours over into days", () => {
		let state = makeState({ player: { x: 0, y: 0, facing: "right", hp: 20, maxHp: 20 } });
		const opening = state.time.hour;
		state = reduce(state, { t: "Tick", amount: 60 * 24 }, probe()).state;
		expect(state.time.day).toBe(2);
		expect(state.time.hour).toBe(opening);
	});

	it("ignores movement while a dialogue is open", () => {
		const state = makeState({
			dialogue: {
				npcId: "n1",
				npcName: "Bram",
				lines: [],
				cursor: 0,
				choiceIndex: 0,
				pending: false,
			},
		});
		const { state: next } = run(state, [
			{ t: "Move", facing: "right" },
			{ t: "Move", facing: "right" },
		]);
		expect([next.player.x, next.player.y]).toEqual([10, 10]);
	});
});

describe("interaction and dialogue", () => {
	const npcs = new Map([["11,10", { id: "npc:1", name: "Bram" }]]);

	it("opens a dialogue with the NPC being faced", () => {
		const state = makeState({ player: { x: 10, y: 10, facing: "right", hp: 20, maxHp: 20 } });
		const { state: next, effects } = run(state, [{ t: "Interact" }], probe({ npcs }));
		expect(next.dialogue?.npcId).toBe("npc:1");
		expect(next.dialogue?.pending).toBe(true);
		expect(effects.some((e) => e.t === "RunDialogueTurn")).toBe(true);
	});

	it("does nothing when facing empty ground", () => {
		const state = makeState({ player: { x: 10, y: 10, facing: "left", hp: 20, maxHp: 20 } });
		const { state: next } = run(state, [{ t: "Interact" }], probe({ npcs }));
		expect(next.dialogue).toBeUndefined();
	});

	it("queues a reply and its choices", () => {
		const state = makeState({ player: { x: 10, y: 10, facing: "right", hp: 20, maxHp: 20 } });
		const { state: next } = run(
			state,
			[
				{ t: "Interact" },
				{
					t: "DialogueTurn",
					npcId: "npc:1",
					speaker: "Bram",
					text: "Well met.",
					choices: ["Hello", "Goodbye"],
				},
			],
			probe({ npcs }),
		);
		expect(next.dialogue?.pending).toBe(false);
		expect(next.dialogue?.choices).toEqual(["Hello", "Goodbye"]);
	});

	it("wraps choice selection at both ends", () => {
		const base = makeState({
			dialogue: {
				npcId: "npc:1",
				npcName: "Bram",
				lines: [{ speaker: "Bram", text: "Well met." }],
				cursor: 0,
				choices: ["A", "B", "C"],
				choiceIndex: 0,
				pending: false,
			},
		});
		expect(run(base, [{ t: "ChoiceUp" }]).state.dialogue?.choiceIndex).toBe(2);
		expect(
			run(base, [{ t: "ChoiceDown" }, { t: "ChoiceDown" }, { t: "ChoiceDown" }]).state.dialogue
				?.choiceIndex,
		).toBe(0);
	});

	it("sends the chosen line back and returns to pending", () => {
		const base = makeState({
			dialogue: {
				npcId: "npc:1",
				npcName: "Bram",
				lines: [{ speaker: "Bram", text: "Well met." }],
				cursor: 0,
				choices: ["Hello", "Goodbye"],
				choiceIndex: 1,
				pending: false,
			},
		});
		const { state, effects } = run(base, [{ t: "Advance" }]);
		expect(state.dialogue?.pending).toBe(true);
		expect(state.dialogue?.lines.at(-1)).toEqual({ speaker: "You", text: "Goodbye" });
		expect(effects).toContainEqual({ t: "RunDialogueTurn", npcId: "npc:1", choice: "Goodbye" });
	});

	it("ignores a turn that arrives after the player walked away", () => {
		// The reply for a conversation the player already closed must not
		// resurrect the panel.
		const { state } = run(makeState(), [
			{ t: "DialogueTurn", npcId: "npc:1", speaker: "Bram", text: "Wait!" },
		]);
		expect(state.dialogue).toBeUndefined();
	});

	it("ignores a turn belonging to a different NPC", () => {
		const base = makeState({
			dialogue: {
				npcId: "npc:1",
				npcName: "Bram",
				lines: [],
				cursor: 0,
				choiceIndex: 0,
				pending: true,
			},
		});
		const { state } = run(base, [
			{ t: "DialogueTurn", npcId: "npc:2", speaker: "Other", text: "Hi" },
		]);
		expect(state.dialogue?.lines).toHaveLength(0);
	});

	it("asks for a memory summary when the conversation closes", () => {
		const base = makeState({
			dialogue: {
				npcId: "npc:1",
				npcName: "Bram",
				lines: [{ speaker: "Bram", text: "Farewell." }],
				cursor: 0,
				choiceIndex: 0,
				pending: false,
			},
		});
		const { state, effects } = run(base, [{ t: "Advance" }]);
		expect(state.dialogue).toBeUndefined();
		expect(effects).toContainEqual({ t: "SummarizeNpcMemory", npcId: "npc:1" });
	});

	it("closes on escape without summarising a conversation that never started", () => {
		const base = makeState({
			dialogue: {
				npcId: "npc:1",
				npcName: "Bram",
				lines: [],
				cursor: 0,
				choiceIndex: 0,
				pending: true,
			},
		});
		expect(run(base, [{ t: "CloseDialogue" }]).state.dialogue).toBeUndefined();
	});
});

describe("domain effects", () => {
	const apply = (state: GameState, effects: DomainEffect[]) =>
		run(state, [{ t: "ApplyEffects", effects }]).state;

	it("grants and stacks items", () => {
		let state = apply(makeState(), [
			{ t: "GrantItem", name: "Rope", description: "Coiled hemp.", quantity: 1 },
		]);
		state = apply(state, [
			{ t: "GrantItem", name: "Rope", description: "Coiled hemp.", quantity: 2 },
		]);
		expect(state.inventory.find((i) => i.name === "Rope")?.quantity).toBe(3);
	});

	it("stacks the same item twice in one conversation", () => {
		// The old implementation deduplicated by comparing the *notification
		// text*, so picking up the same item and quantity twice silently dropped
		// the second one.
		const state = apply(makeState(), [
			{ t: "GrantItem", name: "Gold", description: "Coins.", quantity: 5 },
			{ t: "GrantItem", name: "Gold", description: "Coins.", quantity: 5 },
		]);
		expect(state.inventory.find((i) => i.name === "Gold")?.quantity).toBe(22);
	});

	it("removes an item and drops it when the stack empties", () => {
		const state = apply(makeState(), [{ t: "TakeItem", name: "Gold", quantity: 12 }]);
		expect(state.inventory.find((i) => i.name === "Gold")).toBeUndefined();
	});

	it("never takes an item stack negative", () => {
		const state = apply(makeState(), [{ t: "TakeItem", name: "Gold", quantity: 9999 }]);
		expect(state.inventory.every((i) => i.quantity > 0)).toBe(true);
	});

	it("matches item names case-insensitively", () => {
		const state = apply(makeState(), [{ t: "TakeItem", name: "gold", quantity: 2 }]);
		expect(state.inventory.find((i) => i.name === "Gold")?.quantity).toBe(10);
	});

	it("treats a repeated quest id as a no-op rather than a duplicate", () => {
		const create: DomainEffect = {
			t: "CreateQuest",
			id: "q1",
			name: "Find the tanner's daughter",
			description: "She went to the mire.",
			objectives: [{ kind: "talk", target: "npc:daughter", done: false }],
		};
		const state = apply(apply(makeState(), [create]), [create]);
		expect(state.quests).toHaveLength(1);
	});

	it("does not record the same progress note twice", () => {
		let state = apply(makeState(), [
			{
				t: "CreateQuest",
				id: "q1",
				name: "Q",
				description: "",
				objectives: [],
			},
		]);
		state = apply(state, [{ t: "AdvanceQuest", id: "q1", note: "asked the miller" }]);
		state = apply(state, [{ t: "AdvanceQuest", id: "q1", note: "asked the miller" }]);
		expect(state.quests[0]?.progress).toEqual(["asked the miller"]);
	});

	it("clamps healing at max and damage at zero", () => {
		let state = apply(makeState(), [{ t: "Damage", amount: 999 }]);
		expect(state.player.hp).toBe(0);
		state = apply(state, [{ t: "Heal", amount: 999 }]);
		expect(state.player.hp).toBe(state.player.maxHp);
	});

	it("stamps the journal with the current tick", () => {
		const base = run(makeState(), [{ t: "Tick", amount: 120 }]).state;
		const state = apply(base, [
			{ t: "RecordJournal", entry: { kind: "lore", text: "The mire drowned a village." } },
		]);
		expect(state.journal[0]?.tick).toBe(START_TICK + 120);
	});

	it("is idempotent for effects that describe a target state", () => {
		const base = apply(makeState(), [
			{ t: "CreateQuest", id: "q1", name: "Q", description: "", objectives: [] },
		]);
		const once = apply(base, [{ t: "CompleteQuest", id: "q1" }]);
		const twice = apply(once, [{ t: "CompleteQuest", id: "q1" }]);
		expect(twice).toEqual(once);
	});

	it("requests a save only when something actually changed", () => {
		const base = makeState();
		const noop = reduce(base, { t: "ApplyEffects", effects: [] }, probe());
		expect(noop.effects).toHaveLength(0);
		expect(noop.state).toBe(base);
	});
});

describe("purity", () => {
	it("never mutates the state it was given", () => {
		const state = makeState();
		const snapshot = JSON.parse(JSON.stringify(state));
		run(state, [
			{ t: "Move", facing: "right" },
			{ t: "Move", facing: "right" },
			{
				t: "ApplyEffects",
				effects: [{ t: "GrantItem", name: "Rope", description: "", quantity: 1 }],
			},
			{ t: "Tick", amount: 30 },
		]);
		expect(JSON.parse(JSON.stringify(state))).toEqual(snapshot);
	});

	it("returns the identical object when a command changes nothing", () => {
		const state = makeState({ player: { x: 5, y: 5, facing: "up", hp: 20, maxHp: 20 } });
		const result = reduce(state, { t: "Move", facing: "up" }, probe({ walls: new Set(["5,4"]) }));
		expect(result.state).toBe(state);
	});

	it("never persists UI-transient dialogue into a reload path", () => {
		// `dialogue` is deliberately not part of what a save should restore; the
		// old design serialised the whole store including `locked` and `status`,
		// so a save taken mid-action reloaded permanently wedged.
		const state = makeState();
		expect(Object.hasOwn(state, "dialogue")).toBe(false);
	});
});

describe("reaching a building closes a quest", () => {
	/**
	 * The failure this closes: an NPC sends the player to the mill, they walk into
	 * the mill, and the quest sits open forever.
	 *
	 * `reach` was only ever matched against `placeNameAt`, which resolves
	 * settlements and nothing else, so a target naming a building could not be
	 * satisfied even with the building standing right there.
	 */
	function questFor(target: string): GameState {
		return makeState({
			quests: [
				{
					id: "q1",
					name: "Timber",
					description: "Fetch it from the mill.",
					objectives: [{ kind: "reach", target, done: false }],
					progress: [],
					completed: false,
				},
			],
		});
	}

	/** A world with a door at (10,11) leading into a named mill. */
	function millWorld(name?: string): WorldProbe {
		return {
			...probe(),
			doorAt: (x, y) =>
				x === 10 && y === 11
					? { interiorId: 7, structure: "mill", ...(name ? { name } : {}) }
					: undefined,
			interiorEntrance: () => ({ x: 3, y: 3 }),
			placeNameAt: () => "Harrowfen",
		};
	}

	it("completes when the player walks into the named building", () => {
		// Facing south first, because the first press of a new direction only turns.
		const { state } = run(
			questFor("Harrowmill Mill"),
			[
				{ t: "Move", facing: "down" },
				{ t: "Move", facing: "down" },
			],
			millWorld("Harrowmill Mill"),
		);
		expect(state.player.inside?.structure).toBe("mill");
		expect(state.quests[0]?.completed).toBe(true);
	});

	it("completes on the kind of building when it has no authored name", () => {
		const { state } = run(
			questFor("the mill"),
			[
				{ t: "Move", facing: "down" },
				{ t: "Move", facing: "down" },
			],
			millWorld(),
		);
		expect(state.quests[0]?.completed).toBe(true);
	});

	it("does not complete on a different building", () => {
		const { state } = run(
			questFor("the smithy"),
			[
				{ t: "Move", facing: "down" },
				{ t: "Move", facing: "down" },
			],
			millWorld("Harrowmill Mill"),
		);
		expect(state.player.inside?.structure).toBe("mill");
		expect(state.quests[0]?.completed).toBe(false);
	});

	it("still completes on a settlement name, as it always did", () => {
		const { state } = run(questFor("Harrowfen"), [{ t: "Move", facing: "up" }], millWorld());
		expect(state.quests[0]?.completed).toBe(true);
	});
});

describe("searching a container", () => {
	/**
	 * Nothing in the world could be picked up: the only routes into the inventory
	 * were an NPC handing something over and buying it. So "go and find timber" was
	 * impossible to complete by exploring, however well the quest was grounded.
	 */
	function withCrate(contents: { name: string; description: string; quantity: number }[]) {
		return {
			...probe(),
			containerAt: (x: number, y: number) =>
				x === 10 && y === 11 ? { place: 7, contents, emptyText: "The crate is empty." } : undefined,
		};
	}

	const TIMBER = { name: "Timber", description: "Rough-sawn planks.", quantity: 3 };

	// The player spawns facing down, so the crate below them is already the faced
	// tile. Pressing a direction first would walk them off it.
	it("puts what it holds into the inventory", () => {
		const world = withCrate([TIMBER]);
		const facing = makeState();
		const { state } = run(facing, [{ t: "Interact" }], world);
		expect(state.inventory.find((i) => i.name === "Timber")?.quantity).toBe(3);
	});

	it("says what was found", () => {
		const world = withCrate([TIMBER]);
		const { state } = run(makeState(), [{ t: "Interact" }], world);
		expect(state.notice).toBe("You find 3 Timber.");
	});

	it("cannot be searched twice", () => {
		const world = withCrate([TIMBER]);
		let state = makeState();
		state = run(state, [{ t: "Interact" }], world).state;
		state = run(state, [{ t: "Interact" }], world).state;
		// Three, not six: emptying it is remembered.
		expect(state.inventory.find((i) => i.name === "Timber")?.quantity).toBe(3);
		expect(state.notice).toBe("The crate is empty.");
	});

	it("remembers a fruitless search, so it is not repeated forever", () => {
		const world = withCrate([]);
		const { state } = run(makeState(), [{ t: "Interact" }], world);
		expect(state.notice).toBe("The crate is empty.");
		expect(state.flags["looted:7:10,11"]).toBe(true);
	});

	it("clears the notice on the very next command", () => {
		// A notice reports what just happened; left in place it becomes status text
		// sitting under the map for the rest of the game.
		const world = withCrate([TIMBER]);
		let state = run(makeState(), [{ t: "Interact" }], world).state;
		expect(state.notice).toBeDefined();
		state = run(state, [{ t: "Move", facing: "left" }], world).state;
		expect(state.notice).toBeUndefined();
	});

	it("talks to a person standing beside a crate rather than searching it", () => {
		// Walking up to someone and pressing SPACE must always talk to them.
		const world = {
			...withCrate([TIMBER]),
			npcAt: (x: number, y: number) =>
				x === 10 && y === 11 ? { id: "npc:1:0", name: "Wren" } : undefined,
		};
		const { state } = run(makeState(), [{ t: "Interact" }], world);
		expect(state.dialogue?.npcName).toBe("Wren");
		expect(state.inventory.find((i) => i.name === "Timber")).toBeUndefined();
	});

	it("does nothing when facing something that is not a container", () => {
		const world = withCrate([TIMBER]);
		// Facing away from the crate, at open ground.
		const looking = makeState({
			player: { ...makeState().player, facing: "left" },
		});
		const { state } = run(looking, [{ t: "Interact" }], world);
		expect(state.inventory.find((i) => i.name === "Timber")).toBeUndefined();
		expect(state.notice).toBeUndefined();
	});

	it("completes a `have` objective for what it yielded", () => {
		// The whole point: the errand can now be finished by exploring.
		const world = withCrate([TIMBER]);
		const quest = makeState({
			quests: [
				{
					id: "q1",
					name: "Timber",
					description: "Fetch three lengths.",
					objectives: [{ kind: "have", target: "Timber", quantity: 3, done: false }],
					progress: [],
					completed: false,
				},
			],
		});
		const { state } = run(quest, [{ t: "Interact" }], world);
		expect(state.quests[0]?.completed).toBe(true);
	});
});
