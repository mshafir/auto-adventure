import { chunkKey, toChunk } from "../world/coords.js";
import { arcEndEffects, arcOutline } from "./arc.js";
import { cardKey, cardSeen, tidyCard } from "./card.js";
import type { Command } from "./commands.js";
import { type DomainEffect, type Effect, facingDelta, type Reduction } from "./effects.js";
import type { LootItem } from "./loot.js";
import { clampDisposition, createNpcRecord, MAX_FACTS, type NpcRecord } from "./npc.js";
import { describeObjective, verifyQuests } from "./quests.js";
import {
	type GameState,
	type InventoryItem,
	type JournalEntry,
	type Quest,
	timeFromTick,
	type WorldTime,
} from "./state.js";

/**
 * The world the reducer is allowed to ask about.
 *
 * Passing this in rather than importing a chunk store keeps `reduce` pure: the
 * same state and the same probe results always produce the same output, which
 * is what makes the whole rules layer testable without generating a world.
 */
export interface WorldProbe {
	isPassable(x: number, y: number): boolean;
	isLoaded(x: number, y: number): boolean;
	npcAt(x: number, y: number): { readonly id: string; readonly name: string } | undefined;
	/** A door the player can pass through, and what lies behind it. */
	doorAt?(
		x: number,
		y: number,
	):
		| { readonly interiorId: number; readonly structure: string; readonly name?: string }
		| undefined;
	/** Where the player lands on entering an interior. */
	interiorEntrance?(interiorId: number): { readonly x: number; readonly y: number } | undefined;
	/** True when this interior tile is the way back out. */
	isExit?(x: number, y: number): boolean;
	describeAt?(x: number, y: number): string | undefined;
	/** The settlement covering a position, used to resolve `reach` objectives. */
	placeNameAt?(x: number, y: number): string | undefined;
	/**
	 * Something worth searching, with what it holds already resolved.
	 *
	 * Covers a crate indoors and a patch of ground outdoors alike, because to the
	 * player they are the same gesture. Resolved by the caller rather than here so
	 * the reducer stays pure: contents are a function of the seed and the position,
	 * which the engine knows and the reducer deliberately does not.
	 */
	searchableAt?(
		x: number,
		y: number,
	):
		| {
				/** Flag identifying this exact thing, for remembering it was emptied. */
				readonly key: string;
				readonly contents: readonly LootItem[];
				readonly emptyText: string;
		  }
		| undefined;
}

/**
 * Apply a command.
 *
 * Synchronous and total: every command produces a new state and a list of
 * things for the runner to do. Nothing here awaits, which is why movement is
 * instant — the previous design routed every arrow key through an async action
 * that took a lock and serialised the entire game state to disk before the
 * player saw the step.
 */
export function reduce(state: GameState, command: Command, world: WorldProbe): Reduction {
	// A notice reports what just happened, so whatever happens next clears it —
	// otherwise "You find 3 Timber." sits under the map for the rest of the game.
	const result = step(withoutNotice(state), command, world);

	// Indoors the player's coordinates are interior-local, and an interior starts
	// at its own origin — so asking which settlement covers them is not merely
	// useless but wrong: coordinates like (6, 7) can land inside a town near the
	// world origin. The doorway the player came in by is where they actually are.
	const inside = result.state.player.inside;
	const placeName = inside
		? world.placeNameAt?.(inside.returnX, inside.returnY)
		: world.placeNameAt?.(result.state.player.x, result.state.player.y);

	// Objectives are checked after every command rather than only when a model
	// remembers to say so. This is what makes a quest something the world can
	// resolve — walk into the right town, carry the right thing, and it closes.
	const progress = verifyQuests(result.state, {
		placeName,
		insideName: result.state.player.inside?.name,
		insideKind: result.state.player.inside?.structure,
		talkedTo: result.state.dialogue?.npcName,
	});

	const arrival = recordArrival(progress.state, placeName);

	const journal = [
		...arrival.entries,
		// Progress before outcome, so a log read newest-first still reads in order
		// within the turn that produced both.
		...progress.advanced.map((step) => ({
			tick: progress.state.time.tick,
			kind: "event" as const,
			text: `${step.quest.name}: ${describeObjective(step.objective)} — done.`,
			source: step.quest.id,
		})),
		...progress.completed.map((quest) => ({
			tick: progress.state.time.tick,
			kind: "event" as const,
			text: `Completed: ${quest.name}.`,
			source: quest.id,
		})),
	];

	const logged =
		journal.length > 0
			? { ...arrival.state, journal: [...arrival.state.journal, ...journal] }
			: arrival.state;

	// Checked here rather than beside the beat that opened, because an arc can run out
	// of story on any of three unrelated acts: the last beat opening, the last
	// objective latching, or a conversation completing a quest outright. Asking once,
	// after everything else has settled, is the only place that catches all three.
	//
	// And checked *before* the no-change shortcut below. The command that opens the
	// final beat changes nothing about quests or arrivals, so an early return would
	// have skipped exactly the case this exists for.
	const ended = applyEffects(
		logged,
		arcEndEffects(logged.arc, logged, arcOutline(logged.arc, logged)),
	);

	if (ended.state === result.state) return result;

	const notable =
		progress.completed.length > 0 ||
		progress.advanced.length > 0 ||
		arrival.entries.length > 0 ||
		ended.state !== logged;
	return {
		state: ended.state,
		effects: notable ? [...result.effects, { t: "Save", reason: "checkpoint" }] : result.effects,
	};
}

/**
 * Note down a place the first time the player walks into it.
 *
 * Everything the director invented used to evaporate the moment the panel
 * closed. The journal is where it accumulates instead — and because arrival is
 * recorded as a flag, a `flag` quest objective can be written against having
 * been somewhere.
 */
function recordArrival(
	state: GameState,
	placeName: string | undefined,
): { state: GameState; entries: readonly JournalEntry[] } {
	if (!placeName) return { state, entries: [] };
	const key = `visited:${placeName.toLowerCase()}`;
	if (state.flags[key]) return { state, entries: [] };

	return {
		state: { ...state, flags: { ...state.flags, [key]: true } },
		entries: [
			{ tick: state.time.tick, kind: "place", text: `Arrived in ${placeName}.`, source: placeName },
		],
	};
}

/**
 * Commands a card is allowed to interrupt.
 *
 * Gated in one place rather than with a guard in each handler: the failure this
 * prevents is a card that can be walked out from under, and a list of what still
 * works is far easier to check than five scattered early returns. Everything
 * asynchronous stays live — a chunk landing or a spec arriving while the player
 * reads must not be dropped, or the world behind the card would be missing pieces.
 */
const CARD_BLOCKS: ReadonlySet<Command["t"]> = new Set([
	"Move",
	"Interact",
	"DropItem",
	"Advance",
	"ChoiceUp",
	"ChoiceDown",
	"Confirm",
	"DialogueOpened",
]);

function step(state: GameState, command: Command, world: WorldProbe): Reduction {
	if (state.card && CARD_BLOCKS.has(command.t)) return { state, effects: [] };

	switch (command.t) {
		case "Move":
			return move(state, command.facing, world);
		case "Interact":
			return interact(state, world);
		case "DropItem":
			return dropItem(state, command.name, command.quantity);
		case "RequestSave":
			// No state change, so `applyEffects`' "save when something changed" rule
			// would never fire; asking to quit has to be able to say so directly.
			return { state, effects: [{ t: "Save", reason: "exit" }] };
		case "Advance":
			return advanceDialogue(state);
		case "ChoiceUp":
			return moveChoice(state, -1);
		case "ChoiceDown":
			return moveChoice(state, 1);
		case "Confirm":
			return confirm(state);
		case "DismissCard": {
			if (!state.card) return { state, effects: [] };
			const [next, ...rest] = state.pendingCards ?? [];
			const { card: _card, pendingCards: _pending, ...bare } = state;
			const cleared = bare as GameState;
			// The next card takes the screen directly, so a finale reads as consecutive
			// pages rather than flashing the map between them.
			if (!next) return { state: cleared, effects: [] };
			return {
				state: { ...cleared, card: next, ...(rest.length > 0 ? { pendingCards: rest } : {}) },
				effects: [],
			};
		}
		case "CloseDialogue":
			return { state: withoutDialogue(state), effects: [] };
		case "DialogueOpened":
			return {
				state: {
					...state,
					dialogue: {
						npcId: command.npcId,
						npcName: command.npcName,
						lines: [],
						cursor: 0,
						choiceIndex: 0,
						pending: true,
					},
				},
				effects: [{ t: "RunDialogueTurn", npcId: command.npcId }],
			};
		case "DialogueTurn":
			return receiveDialogueTurn(state, command);
		case "ApplyEffects":
			return applyEffects(state, command.effects);
		case "LoreLearned":
			return { state: { ...state, lore: command.lore }, effects: [] };
		case "RegionLearned":
			return {
				state: { ...state, regions: { ...state.regions, [command.spec.id]: command.spec } },
				effects: [],
			};
		case "SiteLearned": {
			const key = String(command.spec.siteId);
			// A spec is committed once and never revised: the director drops late
			// answers for places the player has already seen, and this refuses them
			// again here so no other caller can rearrange a settled town either.
			if (state.sites[key]) return { state, effects: [] };
			return {
				state: {
					...state,
					sites: { ...state.sites, [key]: command.spec },
					specSources: { ...state.specSources, [key]: command.source },
				},
				effects: [{ t: "Save", reason: "debounced" }],
			};
		}
		case "Tick":
			return { state: { ...state, time: advanceTime(state.time, command.amount) }, effects: [] };
		case "ChunkReady":
			return { state: markDiscovered(state, command.key), effects: [] };
		case "Error":
			return {
				state,
				effects: [{ t: "Log", level: "error", message: `${command.scope}: ${command.message}` }],
			};
	}
}

// --- movement ---------------------------------------------------------------

function move(
	state: GameState,
	facing: GameState["player"]["facing"],
	world: WorldProbe,
): Reduction {
	// Dialogue captures the arrow keys for choice navigation.
	if (state.dialogue) return { state, effects: [] };

	// Turning to face a new direction is free and does not advance time; this is
	// what lets the player look at a wall or a sign without walking into it.
	if (state.player.facing !== facing) {
		return { state: { ...state, player: { ...state.player, facing } }, effects: [] };
	}

	const [dx, dy] = facingDelta(facing);
	const nx = state.player.x + dx;
	const ny = state.player.y + dy;

	// Stepping onto a door moves between the world and an interior. Doing it on
	// movement rather than on an explicit action means a doorway behaves the way
	// a doorway should: you walk through it.
	if (state.player.inside) {
		if (world.isExit?.(nx, ny)) return leaveInterior(state);
	} else {
		const door = world.doorAt?.(nx, ny);
		if (door) return enterInterior(state, door, world);
	}

	// Walking into someone is how you talk to them. Doing it on movement rather
	// than only on SPACE also makes NPCs solid without a separate collision pass.
	//
	// Indoors as well as out. This was guarded on being outdoors back when interiors
	// held nobody, and the guard outlived the reason: once buildings had residents in
	// them the player walked straight through the people standing in them.
	const npc = world.npcAt(nx, ny);
	if (npc) return openDialogue(state, npc);

	if (!world.isLoaded(nx, ny)) {
		// Refuse to step into ungenerated ground and ask for it to be built.
		return { state, effects: [{ t: "EnsureChunk", cc: toChunk(nx, ny) }] };
	}
	if (!world.isPassable(nx, ny)) {
		return { state, effects: [] };
	}

	const moved: GameState = {
		...state,
		player: { ...state.player, x: nx, y: ny },
		time: advanceTime(state.time, 1),
	};

	if (state.player.inside) {
		return { state: moved, effects: [{ t: "Save", reason: "debounced" }] };
	}

	const cc = toChunk(nx, ny);
	const effects: Effect[] = [
		{ t: "PrefetchChunks", around: cc, radius: 2 },
		{ t: "RequestSpecs", around: cc },
		{ t: "Save", reason: "debounced" },
	];

	return { state: markDiscovered(moved, chunkKey(cc.cx, cc.cy)), effects };
}

function enterInterior(
	state: GameState,
	door: { interiorId: number; structure: string; name?: string },
	world: WorldProbe,
): Reduction {
	const entrance = world.interiorEntrance?.(door.interiorId);
	if (!entrance) return { state, effects: [] };
	return {
		state: {
			...state,
			player: {
				...state.player,
				x: entrance.x,
				y: entrance.y,
				facing: "up",
				inside: {
					interiorId: door.interiorId,
					structure: door.structure,
					...(door.name ? { name: door.name } : {}),
					returnX: state.player.x,
					returnY: state.player.y,
				},
			},
			time: advanceTime(state.time, 1),
		},
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

function leaveInterior(state: GameState): Reduction {
	const inside = state.player.inside;
	if (!inside) return { state, effects: [] };
	const { inside: _inside, ...player } = state.player;
	return {
		state: {
			...state,
			player: { ...player, x: inside.returnX, y: inside.returnY, facing: "down" },
			time: advanceTime(state.time, 1),
		},
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

function markDiscovered(state: GameState, key: string): GameState {
	if (state.discovered.includes(key)) return state;
	return { ...state, discovered: [...state.discovered, key] };
}

function advanceTime(time: WorldTime, ticks: number): WorldTime {
	return timeFromTick(time.tick + ticks);
}

// --- interaction ------------------------------------------------------------

function interact(state: GameState, world: WorldProbe): Reduction {
	if (state.dialogue) return advanceDialogue(state);

	const [dx, dy] = facingDelta(state.player.facing);
	const fx = state.player.x + dx;
	const fy = state.player.y + dy;

	// People first: walking up to someone and pressing SPACE should always talk to
	// them, even if they happen to be standing beside a crate.
	const npc = world.npcAt(fx, fy) ?? world.npcAt(state.player.x, state.player.y);
	if (npc) return openDialogue(state, npc);

	return search(state, world, fx, fy);
}

/**
 * Search whatever the player is facing.
 *
 * The only way anything entered the inventory used to be an NPC handing it over,
 * so every "go and find X" errand was impossible however well it was grounded.
 * A crate indoors and a patch of crops outdoors are the same gesture to the
 * player, so they are the same code here.
 *
 * Contents are a pure function of position, so nothing about the thing searched is
 * saved — only the fact that it has been emptied, as a single flag, which is what
 * stops it refilling when the chunk is evicted and regenerated.
 */
function search(state: GameState, world: WorldProbe, x: number, y: number): Reduction {
	const searchable = world.searchableAt?.(x, y);
	if (!searchable) return { state, effects: [] };

	const key = searchable.key;
	if (state.flags[key]) {
		return { state: { ...state, notice: searchable.emptyText }, effects: [] };
	}

	const found = searchable.contents;
	if (found.length === 0) {
		// Marked even when empty, so a fruitless search is not repeated forever and
		// the description settles on the truth.
		return {
			state: { ...state, notice: searchable.emptyText, flags: { ...state.flags, [key]: true } },
			effects: [],
		};
	}

	const notice = found
		.map((item) => (item.quantity > 1 ? `${item.quantity} ${item.name}` : item.name))
		.join(", ");

	// Applied here rather than returned as effects: `Reduction.effects` is the
	// side-effect channel for the runner, and picking something up is a state
	// change the reducer owns outright.
	let inventory = state.inventory;
	for (const item of found) inventory = addItem(inventory, item);

	return {
		state: {
			...state,
			inventory,
			flags: { ...state.flags, [key]: true },
			notice: `You find ${notice}.`,
		},
		// Worth a checkpoint: the player has gained something they would be annoyed
		// to lose, and searching is not on the movement path.
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

/**
 * Put something down.
 *
 * The world has no ground-item layer — a chunk is regenerated from its seed and
 * only player *changes* persist — so a dropped item is destroyed rather than
 * left on the floor. That is why this is worth a checkpoint and why the panel
 * confirms first: it cannot be undone by walking back.
 *
 * Matching is by name rather than by index so the command survives the list
 * being re-sorted between the keypress and the dispatch.
 */
function dropItem(state: GameState, name: string, quantity: number): Reduction {
	const lower = name.toLowerCase();
	const held = state.inventory.find((item) => item.name.toLowerCase() === lower);
	if (!held || quantity <= 0) return { state, effects: [] };

	const dropped = Math.min(quantity, held.quantity);
	const label = dropped > 1 ? `${dropped} ${held.name}` : held.name;
	return {
		state: {
			...state,
			inventory: removeItem(state.inventory, held.name, dropped),
			notice: `You leave ${label} behind.`,
		},
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

function openDialogue(
	state: GameState,
	npc: { readonly id: string; readonly name: string },
): Reduction {
	return {
		state: {
			...state,
			dialogue: {
				npcId: npc.id,
				npcName: npc.name,
				lines: [],
				cursor: 0,
				choiceIndex: 0,
				pending: true,
			},
		},
		effects: [{ t: "RunDialogueTurn", npcId: npc.id }],
	};
}

// --- dialogue ---------------------------------------------------------------

function withoutNotice(state: GameState): GameState {
	if (state.notice === undefined) return state;
	const { notice: _notice, ...rest } = state;
	return rest as GameState;
}

function withoutDialogue(state: GameState): GameState {
	if (!state.dialogue) return state;
	const { dialogue: _dialogue, ...rest } = state;
	return rest as GameState;
}

function advanceDialogue(state: GameState): Reduction {
	const dialogue = state.dialogue;
	if (!dialogue || dialogue.pending) return { state, effects: [] };

	// Step through queued lines first; only offer choices once they are read.
	if (dialogue.cursor < dialogue.lines.length - 1) {
		return {
			state: { ...state, dialogue: { ...dialogue, cursor: dialogue.cursor + 1 } },
			effects: [],
		};
	}
	if (dialogue.choices && dialogue.choices.length > 0) {
		return confirm(state);
	}
	return closeDialogue(state);
}

function closeDialogue(state: GameState): Reduction {
	const npcId = state.dialogue?.npcId;
	return {
		state: withoutDialogue(state),
		effects: npcId
			? [
					// Summarising happens after the panel closes so the player never
					// waits on it.
					{ t: "SummarizeNpcMemory", npcId },
					{ t: "Save", reason: "checkpoint" },
				]
			: [],
	};
}

function moveChoice(state: GameState, delta: number): Reduction {
	const dialogue = state.dialogue;
	if (!dialogue?.choices || dialogue.choices.length === 0) return { state, effects: [] };
	const count = dialogue.choices.length;
	const next = (dialogue.choiceIndex + delta + count) % count;
	return { state: { ...state, dialogue: { ...dialogue, choiceIndex: next } }, effects: [] };
}

function confirm(state: GameState): Reduction {
	const dialogue = state.dialogue;
	if (!dialogue || dialogue.pending) return { state, effects: [] };
	const choices = dialogue.choices;
	if (!choices || choices.length === 0) return closeDialogue(state);

	const chosen = choices[Math.min(dialogue.choiceIndex, choices.length - 1)];
	if (chosen === undefined) return closeDialogue(state);

	return {
		state: {
			...state,
			dialogue: {
				...dialogue,
				lines: [...dialogue.lines, { speaker: "You", text: chosen }],
				cursor: dialogue.lines.length,
				choices: undefined,
				choiceIndex: 0,
				pending: true,
			},
		},
		effects: [{ t: "RunDialogueTurn", npcId: dialogue.npcId, choice: chosen }],
	};
}

function receiveDialogueTurn(
	state: GameState,
	command: Extract<Command, { t: "DialogueTurn" }>,
): Reduction {
	const dialogue = state.dialogue;
	// A turn can arrive after the player closed the panel; drop it rather than
	// resurrecting a conversation they walked away from.
	if (!dialogue || dialogue.npcId !== command.npcId) return { state, effects: [] };

	const lines = [...dialogue.lines, { speaker: command.speaker, text: command.text }];
	return {
		state: {
			...state,
			dialogue: {
				...dialogue,
				lines,
				cursor: Math.max(0, lines.length - 1),
				choices: command.choices,
				choiceIndex: 0,
				pending: false,
			},
		},
		effects: [],
	};
}

// --- domain effects ---------------------------------------------------------

function applyEffects(state: GameState, effects: readonly DomainEffect[]): Reduction {
	let next = state;
	const followUp: Effect[] = [];
	for (const effect of effects) {
		next = applyEffect(next, effect);
	}
	if (next !== state) followUp.push({ t: "Save", reason: "debounced" });
	return { state: next, effects: followUp };
}

function applyEffect(state: GameState, effect: DomainEffect): GameState {
	switch (effect.t) {
		case "GrantItem":
			return { ...state, inventory: addItem(state.inventory, effect) };
		case "TakeItem":
			return { ...state, inventory: removeItem(state.inventory, effect.name, effect.quantity) };
		case "AdjustGold":
			return effect.amount >= 0
				? {
						...state,
						inventory: addItem(state.inventory, {
							name: "Gold",
							description: "A handful of coins.",
							quantity: effect.amount,
						}),
					}
				: { ...state, inventory: removeItem(state.inventory, "Gold", -effect.amount) };
		case "CreateQuest": {
			// Quest ids are the identity; re-issuing one is a no-op rather than a
			// duplicate, so a model that repeats itself cannot spam the log.
			if (state.quests.some((q) => q.id === effect.id)) return state;
			const quest: Quest = {
				id: effect.id,
				name: effect.name,
				description: effect.description,
				objectives: effect.objectives,
				progress: [],
				completed: false,
				...(effect.siteId === undefined ? {} : { siteId: effect.siteId }),
			};
			return {
				...state,
				quests: [...state.quests, quest],
				// Only completion used to be journalled, so a log read a week later showed
				// errands finishing that it never showed being given.
				journal: [
					...state.journal,
					{
						tick: state.time.tick,
						kind: "event",
						text: `New errand: ${quest.name}.`,
						source: quest.id,
					},
				],
			};
		}
		case "AdvanceQuest":
			return {
				...state,
				quests: state.quests.map((q) =>
					q.id === effect.id && !q.progress.includes(effect.note)
						? { ...q, progress: [...q.progress, effect.note] }
						: q,
				),
			};
		case "CompleteQuest":
			return {
				...state,
				quests: state.quests.map((q) => (q.id === effect.id ? { ...q, completed: true } : q)),
			};
		case "AbandonQuest":
			return { ...state, quests: state.quests.filter((q) => q.id !== effect.id) };
		case "SetFlag":
			return { ...state, flags: { ...state.flags, [effect.key]: effect.value } };
		case "ShowCard": {
			// Read once, ever. The flag goes down in the same step the card goes up, so
			// a beat re-applied after a partial save cannot show its card a second time.
			if (cardSeen(state.flags, effect.card.id)) return state;
			const card = tidyCard(effect.card);
			if (card.sections.length === 0 && !card.subtitle) return state;
			const flags = { ...state.flags, [cardKey(card.id)]: true };
			// Behind whatever is already up rather than over it. The flag is set either
			// way, because a queued card *will* be shown — it is the replacing that lost
			// one, not the queueing.
			if (state.card) {
				return { ...state, flags, pendingCards: [...(state.pendingCards ?? []), card] };
			}
			return { ...state, card, flags };
		}
		case "RecordJournal":
			return {
				...state,
				journal: [...state.journal, { ...effect.entry, tick: state.time.tick }],
			};
		case "Teleport":
			return { ...state, player: { ...state.player, x: effect.x, y: effect.y } };
		case "Damage":
			return {
				...state,
				player: { ...state.player, hp: Math.max(0, state.player.hp - effect.amount) },
			};
		case "Heal":
			return {
				...state,
				player: {
					...state.player,
					hp: Math.min(state.player.maxHp, state.player.hp + effect.amount),
				},
			};
		case "EndDialogue":
			return withoutDialogue(state);

		case "MeetNpc": {
			if (state.npcs[effect.npcId]) return state;
			const record = createNpcRecord({
				id: effect.npcId,
				name: effect.name,
				role: effect.role,
				siteId: effect.siteId,
				disposition: effect.disposition,
			});
			return { ...state, npcs: { ...state.npcs, [effect.npcId]: record } };
		}

		case "RecordTurn":
			return withNpc(state, effect.npcId, (record) => ({
				...record,
				recentTurns: [...record.recentTurns, effect.turn],
				totalTurns: record.totalTurns + 1,
				lastSeenTick: state.time.tick,
			}));

		case "SetNpcNode":
			return withNpc(state, effect.npcId, (record) => ({ ...record, node: effect.node }));

		case "FoldNpcMemory":
			return withNpc(state, effect.npcId, (record) => ({
				...record,
				summary: effect.summary,
				// Newest facts win the cap: a long acquaintance should drift rather
				// than freeze at whatever it learned first.
				facts: [...record.facts, ...effect.newFacts].slice(-MAX_FACTS),
				recentTurns: record.recentTurns.slice(effect.foldedTurns),
			}));

		case "AdjustDisposition":
			return withNpc(state, effect.npcId, (record) => ({
				...record,
				disposition: clampDisposition(record.disposition + effect.delta),
			}));

		case "AdjustReputation": {
			const current = state.reputation[effect.faction] ?? 0;
			return {
				...state,
				reputation: {
					...state.reputation,
					[effect.faction]: clampDisposition(current + effect.delta),
				},
			};
		}
	}
}

/** Apply a change to one NPC, leaving the state untouched if they are unknown. */
function withNpc(
	state: GameState,
	npcId: string,
	update: (record: NpcRecord) => NpcRecord,
): GameState {
	const record = state.npcs[npcId];
	if (!record) return state;
	const next = update(record);
	if (next === record) return state;
	return { ...state, npcs: { ...state.npcs, [npcId]: next } };
}

function addItem(
	inventory: readonly InventoryItem[],
	item: { name: string; description: string; quantity: number },
): readonly InventoryItem[] {
	const lower = item.name.toLowerCase();
	const index = inventory.findIndex((i) => i.name.toLowerCase() === lower);
	if (index === -1) {
		return [...inventory, { ...item, quantity: Math.max(1, item.quantity) }];
	}
	return inventory.map((existing, i) =>
		i === index ? { ...existing, quantity: existing.quantity + item.quantity } : existing,
	);
}

function removeItem(
	inventory: readonly InventoryItem[],
	name: string,
	quantity: number,
): readonly InventoryItem[] {
	const lower = name.toLowerCase();
	return inventory
		.map((item) =>
			item.name.toLowerCase() === lower
				? { ...item, quantity: Math.max(0, item.quantity - quantity) }
				: item,
		)
		.filter((item) => item.quantity > 0);
}
