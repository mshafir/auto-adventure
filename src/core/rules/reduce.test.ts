import { describe, expect, it } from "vitest";
import type { Command } from "./commands.js";
import type { DomainEffect } from "./effects.js";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState, type QuestObjective, START_TICK } from "./state.js";

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
	function withCrate(
		contents: { name: string; description: string; quantity: number }[],
	): WorldProbe {
		// Typed as WorldProbe on purpose. Returning an inferred object hid a stale
		// `containerAt` from the compiler through a rename, and the tests failed at
		// runtime instead of at build time.
		return {
			...probe(),
			searchableAt: (x: number, y: number) =>
				x === 10 && y === 11
					? { key: "looted:7:10,11", contents, emptyText: "The crate is empty." }
					: undefined,
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

describe("where the player is while indoors", () => {
	/**
	 * Interior coordinates are local to the interior, which starts at its own
	 * origin. Resolving a settlement from them is not merely useless but wrong:
	 * a position like (6, 7) sits near the world origin, so a town there would
	 * claim the player standing in a building two hundred tiles away — completing
	 * a `reach` objective and journalling an arrival that never happened.
	 */
	function townAtOrigin(): WorldProbe {
		return {
			...probe(),
			// A town at the world origin, and a building two hundred tiles away.
			placeNameAt: (x, y) => (Math.abs(x) < 20 && Math.abs(y) < 20 ? "Origintown" : undefined),
			doorAt: (x, y) => (x === 200 && y === 201 ? { interiorId: 7, structure: "mill" } : undefined),
			interiorEntrance: () => ({ x: 6, y: 7 }),
		};
	}

	function enter(state: GameState, world: WorldProbe): GameState {
		return run(state, [{ t: "Move", facing: "down" }], world).state;
	}

	it("does not claim the player arrived somewhere they only walked past a door into", () => {
		const world = townAtOrigin();
		const state = enter(makeState({ player: { ...makeState().player, x: 200, y: 200 } }), world);
		expect(state.player.inside?.interiorId).toBe(7);
		// Interior-local (6,7) is inside Origintown's radius, but the doorway is not.
		expect(state.flags["visited:origintown"]).toBeUndefined();
	});

	it("does not complete a `reach` objective for a town the door is nowhere near", () => {
		const world = townAtOrigin();
		const quest = makeState({
			player: { ...makeState().player, x: 200, y: 200 },
			quests: [
				{
					id: "q1",
					name: "Go to Origintown",
					description: "",
					objectives: [{ kind: "reach", target: "Origintown", done: false }],
					progress: [],
					completed: false,
				},
			],
		});
		expect(enter(quest, world).quests[0]?.completed).toBe(false);
	});

	it("still resolves the settlement the doorway is actually in", () => {
		// The player is in the town while indoors, so an objective naming it closes.
		const world: WorldProbe = {
			...townAtOrigin(),
			// A settlement covers an area, so it contains both the door and the
			// tile the player stepped in from.
			placeNameAt: (x, y) =>
				Math.abs(x - 200) < 5 && Math.abs(y - 200) < 5 ? "Brackgate" : undefined,
		};
		const quest = makeState({
			player: { ...makeState().player, x: 200, y: 200 },
			quests: [
				{
					id: "q1",
					name: "Go to Brackgate",
					description: "",
					objectives: [{ kind: "reach", target: "Brackgate", done: false }],
					progress: [],
					completed: false,
				},
			],
		});
		expect(enter(quest, world).quests[0]?.completed).toBe(true);
	});
});

describe("gathering from the ground", () => {
	/**
	 * The gesture is the same as opening a crate, so it is the same code — but it
	 * only worked indoors. An errand to fetch moss from the crops near the forest
	 * named things the player could see and walk up to and had no way to pick.
	 */
	function withPatch(
		contents: { name: string; description: string; quantity: number }[],
	): WorldProbe {
		return {
			...probe(),
			searchableAt: (x: number, y: number) =>
				x === 10 && y === 11
					? {
							key: "gathered:10,11",
							contents,
							emptyText: "Nothing more worth taking from the forest floor.",
						}
					: undefined,
		};
	}

	const MOSS = { name: "Cushion Moss", description: "Deep green.", quantity: 1 };

	it("puts what it gathers into the inventory", () => {
		const world = withPatch([MOSS]);
		const { state } = run(makeState(), [{ t: "Interact" }], world);
		expect(state.inventory.find((i) => i.name === "Cushion Moss")?.quantity).toBe(1);
		expect(state.notice).toBe("You find Cushion Moss.");
	});

	it("does not regrow, and says the patch is picked over", () => {
		const world = withPatch([MOSS]);
		let state = run(makeState(), [{ t: "Interact" }], world).state;
		state = run(state, [{ t: "Interact" }], world).state;
		expect(state.inventory.find((i) => i.name === "Cushion Moss")?.quantity).toBe(1);
		expect(state.notice).toBe("Nothing more worth taking from the forest floor.");
	});

	it("uses a key that cannot collide with an emptied crate", () => {
		const { state } = run(makeState(), [{ t: "Interact" }], withPatch([MOSS]));
		expect(state.flags["gathered:10,11"]).toBe(true);
		expect(state.flags["looted:10,11"]).toBeUndefined();
	});

	it("completes a `have` objective for what it gathered", () => {
		const quest = makeState({
			quests: [
				{
					id: "q1",
					name: "Moss for the poultice",
					description: "From the crops by the forest.",
					objectives: [{ kind: "have", target: "Cushion Moss", done: false }],
					progress: [],
					completed: false,
				},
			],
		});
		const { state } = run(quest, [{ t: "Interact" }], withPatch([MOSS]));
		expect(state.quests[0]?.completed).toBe(true);
	});
});

describe("putting something down", () => {
	const carrying = (): GameState =>
		makeState({
			inventory: [
				{ name: "Timber", description: "Rough-sawn planks.", quantity: 3 },
				{ name: "Gold", description: "A handful of coins.", quantity: 12 },
			],
		});

	it("takes the whole stack and says so", () => {
		const { state } = run(carrying(), [{ t: "DropItem", name: "Timber", quantity: 3 }]);
		expect(state.inventory.map((item) => item.name)).toEqual(["Gold"]);
		expect(state.notice).toBe("You leave 3 Timber behind.");
	});

	it("takes only part of one when asked for part", () => {
		const { state } = run(carrying(), [{ t: "DropItem", name: "Timber", quantity: 1 }]);
		expect(state.inventory.find((item) => item.name === "Timber")?.quantity).toBe(2);
	});

	it("cannot drop more than is carried, or go negative", () => {
		const { state } = run(carrying(), [{ t: "DropItem", name: "Gold", quantity: 999 }]);
		expect(state.inventory.some((item) => item.name === "Gold")).toBe(false);
		expect(state.notice).toBe("You leave 12 Gold behind.");
	});

	it("does nothing for something that is not carried", () => {
		const before = carrying();
		const { state } = run(before, [{ t: "DropItem", name: "Lantern", quantity: 1 }]);
		expect(state.inventory).toEqual(before.inventory);
		expect(state.notice).toBeUndefined();
	});

	it("matches the name however it was capitalised", () => {
		// The name is carried from the panel rather than an index, so the command
		// survives the list being re-ordered — but only if it still matches.
		const { state } = run(carrying(), [{ t: "DropItem", name: "timber", quantity: 3 }]);
		expect(state.inventory.map((item) => item.name)).toEqual(["Gold"]);
	});

	it("checkpoints, because it cannot be undone by walking back", () => {
		const { effects } = run(carrying(), [{ t: "DropItem", name: "Timber", quantity: 3 }]);
		expect(effects).toContainEqual({ t: "Save", reason: "checkpoint" });
	});

	it("refuses a nonsense quantity rather than adding stock", () => {
		const { state } = run(carrying(), [{ t: "DropItem", name: "Timber", quantity: -5 }]);
		expect(state.inventory.find((item) => item.name === "Timber")?.quantity).toBe(3);
	});
});

describe("asking to save", () => {
	it("writes out now rather than waiting for the debounce", () => {
		// The debounce timer is unref'd, so a quitting process would abandon it and
		// the last few steps would be lost.
		const { state, effects } = run(makeState(), [{ t: "RequestSave" }]);
		expect(effects).toEqual([{ t: "Save", reason: "exit" }]);
		expect(state.player).toEqual(makeState().player);
	});
});

describe("what the journal remembers", () => {
	function questState(objectives: QuestObjective[]) {
		const state = createInitialState(
			{ id: "j", name: "j", seed: 1, createdAt: "2026-01-01T00:00:00.000Z" },
			{ x: 0, y: 0 },
		);
		return reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [
					{
						t: "CreateQuest",
						id: "rope",
						name: "Find the season's rope",
						description: "It went down in the narrows.",
						objectives,
					},
				],
			},
			probe(),
		).state;
	}

	it("records an errand being given, not only one being finished", () => {
		// Only completion used to be journalled, so a log read a week later showed
		// errands ending that it never showed beginning.
		const state = questState([{ kind: "have", target: "Coil of rope", done: false }]);
		expect(state.journal.map((entry) => entry.text)).toContain(
			"New errand: Find the season's rope.",
		);
	});

	it("files it under the errand, so the log can be read back by quest", () => {
		const state = questState([{ kind: "have", target: "Coil of rope", done: false }]);
		expect(state.journal.at(-1)?.source).toBe("rope");
	});

	it("does not record the same errand twice", () => {
		// Quest ids are the identity and re-issuing one is already a no-op; the journal
		// entry has to inherit that or a repeating model would fill the log.
		const first = questState([{ kind: "have", target: "Coil of rope", done: false }]);
		const again = reduce(
			first,
			{
				t: "ApplyEffects",
				effects: [
					{
						t: "CreateQuest",
						id: "rope",
						name: "Find the season's rope",
						description: "It went down in the narrows.",
						objectives: [],
					},
				],
			},
			probe(),
		).state;
		expect(again.journal.filter((entry) => entry.text.startsWith("New errand"))).toHaveLength(1);
	});

	it("records an objective ticking off on an errand still open", () => {
		const state = questState([
			{ kind: "have", target: "Coil of rope", done: false },
			{ kind: "talk", target: "Ilse", done: false },
		]);
		const carried = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [{ t: "GrantItem", name: "Coil of rope", description: "Tarred.", quantity: 1 }],
			},
			probe(),
		).state;

		const texts = carried.journal.map((entry) => entry.text);
		expect(texts).toContain("Find the season's rope: carry Coil of rope — done.");
		// And it is progress, not an ending: the errand is still open.
		expect(texts.some((text) => text.startsWith("Completed:"))).toBe(false);
	});

	it("announces a finish once, rather than as progress and then as a finish", () => {
		// A single-objective errand satisfies its last objective and completes in the
		// same step; reporting both would put two lines in the log for one act.
		const state = questState([{ kind: "have", target: "Coil of rope", done: false }]);
		const carried = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [{ t: "GrantItem", name: "Coil of rope", description: "Tarred.", quantity: 1 }],
			},
			probe(),
		).state;

		const texts = carried.journal.map((entry) => entry.text);
		expect(texts).toContain("Completed: Find the season's rope.");
		expect(texts.some((text) => text.includes("— done."))).toBe(false);
	});

	it("phrases progress the way the quest pane does", () => {
		// Both call `describeObjective`, which is why it lives in core: the pane and the
		// log describing one objective differently is the kind of drift a player notices.
		const state = questState([
			{ kind: "have", target: "Timber", quantity: 3, done: false },
			{ kind: "talk", target: "Ilse", done: false },
		]);
		const carried = reduce(
			state,
			{
				t: "ApplyEffects",
				effects: [{ t: "GrantItem", name: "Timber", description: "Sawn.", quantity: 3 }],
			},
			probe(),
		).state;
		expect(carried.journal.map((entry) => entry.text)).toContain(
			"Find the season's rope: carry 3 Timber — done.",
		);
	});
});
