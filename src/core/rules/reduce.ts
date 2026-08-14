import { T, terrainDef } from "../tiles/terrain.js";
import {
	chunkKey,
	localIndex,
	toChunk,
	toChunkX,
	toChunkY,
	toLocalX,
	toLocalY,
} from "../world/coords.js";
import { arcEndEffects, arcOutline, beatEffects, beatsOpenedByState } from "./arc.js";
import { type Card, cardKey, cardSeen, tidyCard } from "./card.js";
import type { Command } from "./commands.js";
import { evaluate } from "./condition.js";
import { withCachedTurn } from "./dialogue-cache.js";
import { type DomainEffect, type Effect, facingDelta, type Reduction } from "./effects.js";
import { type Barrier, barrierKey, barrierOpen, type Lock } from "./lock.js";
import type { LootItem } from "./loot.js";
import { clampDisposition, createNpcRecord, MAX_FACTS, type NpcRecord } from "./npc.js";
import { describeObjective, verifyQuests } from "./quests.js";
import {
	advanceScene,
	beginScene,
	type SceneState,
	type StagedScene,
	type StagedStep,
} from "./scene.js";
import {
	type GameState,
	type InventoryItem,
	type JournalEntry,
	type Quest,
	timeFromTick,
	visitedKey,
	type WorldTime,
} from "./state.js";
import { MAX_TRIGGER_PASSES, pendingTriggers, triggerKey } from "./trigger.js";

/**
 * The world the reducer is allowed to ask about.
 *
 * Passing this in rather than importing a chunk store keeps `reduce` pure: the
 * same state and the same probe results always produce the same output, which
 * is what makes the whole rules layer testable without generating a world.
 */
/**
 * Where a portal tile leads.
 *
 * `exit` is the way back to the world; `level` is another storey of the same
 * interior, with the tile to land on already worked out.
 */
export type PortalTarget =
	| { readonly kind: "exit" }
	| { readonly kind: "level"; readonly level: number; readonly x: number; readonly y: number };

export interface WorldProbe {
	isPassable(x: number, y: number): boolean;
	isLoaded(x: number, y: number): boolean;
	npcAt(x: number, y: number): { readonly id: string; readonly name: string } | undefined;
	/** A door the player can pass through, and what lies behind it. */
	doorAt?(
		x: number,
		y: number,
	):
		| {
				readonly interiorId: number;
				readonly structure: string;
				readonly name?: string;
				/** What has to be true to get in. Absent means it simply opens. */
				readonly lock?: Lock;
		  }
		| undefined;
	/**
	 * A gate standing on this tile, whether or not it has been opened.
	 *
	 * Returns the barrier even once it is open, because the reducer decides that from
	 * the flags — the probe's job is to say what is *there*, and the answer must not
	 * depend on state the reducer already holds.
	 */
	barrierAt?(x: number, y: number): Barrier | undefined;
	/**
	 * A scene with its points resolved and its walks already pathfound.
	 *
	 * Staged by the engine, which has the world; the reducer only ever plays what it is
	 * handed. That is what keeps the scene machine pure and its tests free of a world, and
	 * it is why an unstageable scene is simply never opened rather than opened and then
	 * found to be impossible halfway through.
	 */
	stagedScene?(id: string): StagedScene | undefined;
	/** Where the player lands on entering an interior. */
	interiorEntrance?(interiorId: number): { readonly x: number; readonly y: number } | undefined;
	/**
	 * What lies on the other side of this tile, when the player is indoors.
	 *
	 * Covers the way out and the stairs with one question, because to the reducer they
	 * are the same thing: a tile you walk onto that puts you somewhere else. The engine
	 * resolves *where*, because that is geometry it owns and the reducer deliberately
	 * does not know.
	 */
	portalAt?(x: number, y: number): PortalTarget | undefined;
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
	// A scene has the world, and takes every command with it. Handled here rather than
	// guarded inside each case, because the list of things that must not happen mid-cutscene
	// is "all of them" — so a command added later joins that list by default rather than by
	// somebody remembering to add a check.
	if (state.scene) return duringScene(state, state.scene, command, world);

	// A notice reports what just happened, so whatever happens next clears it —
	// otherwise "You find 3 Timber." sits under the map for the rest of the game.
	const result = step(withoutNotice(state), command, world);

	const settled = settle(result.state, world);

	// Checked here rather than beside the beat that opened, because an arc can run out
	// of story on any of three unrelated acts: the last beat opening, the last
	// objective latching, or a conversation completing a quest outright. Asking once,
	// after everything else has settled, is the only place that catches all three.
	//
	// And checked *before* the no-change shortcut below. The command that opens the
	// final beat changes nothing about quests or arrivals, so an early return would
	// have skipped exactly the case this exists for.
	//
	// Not while a conversation is open, for the reason `takesTheScreen` gives at length: the
	// last beat's flag is set when its conversation *opens*, so the card announcing that the
	// story was over used to arrive before the person who ends it had said a word. This is a
	// condition over state, like a trigger, so skipping it costs nothing — it fires on the
	// command that closes the conversation.
	const ended = settled.state.dialogue
		? settled
		: applyEffects(
				settled.state,
				arcEndEffects(
					settled.state.arc,
					settled.state,
					arcOutline(settled.state.arc, settled.state),
				),
			);

	if (ended.state === result.state) return result;

	const notable = settled.notable || ended.state !== settled.state;
	return {
		state: ended.state,
		effects: notable ? [...result.effects, { t: "Save", reason: "checkpoint" }] : result.effects,
	};
}

/**
 * Let the consequences of a command finish happening.
 *
 * Three things run here and they are interleaved rather than sequenced, because
 * each can be what the next was waiting for: arriving somewhere sets the flag a
 * trigger watches, a trigger granting the ledger ticks a `have` objective, and an
 * errand closing is what another trigger was waiting for. Running them once each in
 * a fixed order would resolve one link of that chain per keypress — a card that
 * appears only after the player's *next* move reads as a bug, not as pacing.
 *
 * Bounded rather than run to a fixed point. A repeating trigger whose effects do not
 * change its own condition would otherwise spin here forever, taking the game with
 * it; {@link MAX_TRIGGER_PASSES} is past any chain worth writing.
 */
function settle(
	initial: GameState,
	world: WorldProbe,
): { readonly state: GameState; readonly notable: boolean } {
	let current = initial;
	let notable = false;
	const journal: JournalEntry[] = [];

	for (let pass = 0; ; pass++) {
		// Indoors the player's coordinates are interior-local, and an interior starts
		// at its own origin — so asking which settlement covers them is not merely
		// useless but wrong: coordinates like (6, 7) can land inside a town near the
		// world origin. The doorway the player came in by is where they actually are.
		const inside = current.player.inside;
		const placeName = inside
			? world.placeNameAt?.(inside.returnX, inside.returnY)
			: world.placeNameAt?.(current.player.x, current.player.y);

		const arrival = recordArrival(current, placeName);
		current = arrival.state;
		journal.push(...arrival.entries);

		// Objectives are checked after every command rather than only when a model
		// remembers to say so. This is what makes a quest something the world can
		// resolve — walk into the right town, carry the right thing, and it closes.
		const progress = verifyQuests(current, {
			placeName,
			insideName: current.player.inside?.name,
			insideKind: current.player.inside?.structure,
			talkedTo: current.dialogue?.npcName,
		});
		current = progress.state;

		journal.push(
			// Progress before outcome, so a log read newest-first still reads in order
			// within the turn that produced both.
			...progress.advanced.map((step) => ({
				tick: current.time.tick,
				kind: "event" as const,
				text: `${step.quest.name}: ${describeObjective(step.objective)} — done.`,
				source: step.quest.id,
			})),
			...progress.completed.map((quest) => ({
				tick: current.time.tick,
				kind: "event" as const,
				text: `Completed: ${quest.name}.`,
				source: quest.id,
			})),
		);

		if (
			arrival.entries.length > 0 ||
			progress.completed.length > 0 ||
			progress.advanced.length > 0
		) {
			notable = true;
		}

		// One pass beyond the limit, so the state the loop leaves behind has always had
		// its quests and arrivals checked *after* the last trigger fired.
		if (pass >= MAX_TRIGGER_PASSES) break;
		// Beats that open on their own come first, so a trigger written to react to a
		// beat opening sees it in this pass rather than the next.
		const due = [
			...beatsOpenedByState(current.arc, current).flatMap(beatEffects),
			...pendingTriggers(current.triggers, current),
		];
		const fired = applyEffects(current, due);

		// A scene opens *after* the pass that asked for it has been applied, so that
		// everything else that pass did — a flag set, a gate opened, an item granted — is
		// already true on the scene's first frame. Opening it needs the world, which the
		// effect layer has no access to, so it happens here where the probe is.
		// Broken out of rather than returned from, so the journal this pass collected is
		// still appended below.
		const opened = openScene(fired.state, due, world);
		if (opened) {
			current = opened;
			notable = true;
			break;
		}

		if (fired.state === current) break;
		current = fired.state;
		notable = true;
	}

	if (journal.length > 0) current = { ...current, journal: [...current.journal, ...journal] };
	return { state: current, notable };
}

/**
 * What a command means while a scene is playing.
 *
 * Three things get through. A frame advances it, the advance key gets past a line somebody
 * is saying, and a skip ends it. Everything else is dropped on the floor.
 *
 * No `Save` is emitted on any path but the last, which is the other half of the
 * interruption rule: a scene that is still running has written nothing to disk, so quitting
 * mid-cutscene replays it from the start next time rather than resuming a half-applied
 * middle.
 */
/**
 * Commands that are answers rather than actions.
 *
 * Every one of these is something the world told the game about after the fact — a model's
 * reply, a chunk that finished building, a name the director settled on. None of them is a
 * keypress, so none of them may be swallowed by anything whose job is to ignore keypresses.
 */
const ARRIVALS: ReadonlySet<Command["t"]> = new Set([
	"DialogueTurn",
	"DialogueStreaming",
	"ChunkReady",
	"LoreLearned",
	"RegionLearned",
	"SiteLearned",
	"Error",
]);

function duringScene(
	state: GameState,
	scene: SceneState,
	command: Command,
	world: WorldProbe,
): Reduction {
	const staged = world.stagedScene?.(scene.id);
	// A scene whose staging has gone is a scene that cannot be played. Ending it is the only
	// honest option available — leaving it up would lock the player out of their own game
	// with no way back — and its effects still apply, so the story does not stop here.
	if (!staged) {
		const rescued = applyEffects(closeScene(state, scene.id), remainingEffects(scene.step, []));
		return { state: rescued.state, effects: [{ t: "Save", reason: "checkpoint" }] };
	}

	// A scene's `Card` step puts a full screen of prose up, and the player has to be able to
	// put it down again — so this one command goes through to the ordinary handler. Everything
	// else stays swallowed, and the scene waits behind the card rather than playing on under it.
	if (state.card) {
		if (command.t === "DismissCard") return step(withoutNotice(state), command, world);
		return { state, effects: [] };
	}

	if (command.t === "SkipScene") {
		if (!staged.skippable) return { state, effects: [] };
		// Skipping skips the *prose*, never the consequences. A scene is where a chapter
		// turns, and a player who has read enough must not be left in a world where the turn
		// never happened.
		const applied = applyEffects(
			closeScene(state, scene.id),
			remainingEffects(scene.step, staged.steps),
		);
		return { state: applied.state, effects: [{ t: "Save", reason: "checkpoint" }] };
	}

	// Something that *arrived* rather than something that was pressed. The lock a scene puts
	// on the world is a lock on the player's hands, and a model's answer is not the player's
	// hands: swallowing one leaves the conversation it belongs to waiting for a reply that
	// has already been thrown away, which the player sees as a spinner that never stops.
	// That is exactly what happened — a beat's own trigger raised a scene while the beat's
	// opening line was still in flight — and while triggers now wait for a conversation to
	// close, an arrival must not be droppable by any future path either.
	if (ARRIVALS.has(command.t)) return step(state, command, world);

	// `Advance` and `Confirm` are both "yes, go on" elsewhere in the game, so both get past a
	// caption. Anything else is swallowed.
	const advance = command.t === "Advance" || command.t === "Confirm";
	if (command.t !== "SceneFrame" && !advance) return { state, effects: [] };

	const outcome = advanceScene(staged, scene, { advance });
	const applied = applyEffects(state, outcome.effects);
	if (outcome.scene) {
		return { state: { ...applied.state, scene: outcome.scene }, effects: [] };
	}
	return {
		state: closeScene(applied.state, scene.id),
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

/**
 * Open a scene one of these effects asked for, if the world can stage it.
 *
 * Returns undefined when nothing asked, when one is already playing, or when the scene
 * cannot be staged — a missing scene is logged by the engine that does the staging, and
 * refusing to open it here leaves the trigger unfired, so a corrected scenario plays it
 * next time rather than having silently skipped it.
 */
function openScene(
	state: GameState,
	effects: readonly DomainEffect[],
	world: WorldProbe,
): GameState | undefined {
	if (state.scene) return undefined;
	const asked = effects.find((effect) => effect.t === "PlayScene");
	if (!asked || asked.t !== "PlayScene") return undefined;
	const staged = world.stagedScene?.(asked.id);
	if (!staged) return undefined;
	return {
		...state,
		scene: beginScene(staged, { x: state.player.x, y: state.player.y }, state.player.facing),
	};
}

/**
 * Take the scene down and record that whatever opened it is done.
 *
 * The fired flag is written *here* rather than by `pendingTriggers`, so that only a scene
 * which actually reached its end counts as having happened. See {@link playsAScene}.
 */
function closeScene(state: GameState, sceneId: string): GameState {
	const flags = { ...state.flags };
	for (const trigger of state.triggers ?? []) {
		if (trigger.once === false) continue;
		if (trigger.effects.some((effect) => effect.t === "PlayScene" && effect.id === sceneId))
			flags[triggerKey(trigger.id)] = true;
	}
	const { scene: over, ...rest } = state;
	void over;
	return { ...rest, flags };
}

/** Every effect a scene has not applied yet, from this step onwards. */
function remainingEffects(from: number, steps: readonly StagedStep[]): DomainEffect[] {
	const effects: DomainEffect[] = [];
	for (const step of steps.slice(from)) {
		for (const action of step.do) {
			if (action.t === "Effects") effects.push(...action.effects);
			if (action.t === "Card") effects.push({ t: "ShowCard", card: action.card });
		}
	}
	return effects;
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
	const key = visitedKey(placeName);
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
			return { state: withoutDialogue(keepWhatWasSaid(state)), effects: [] };
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
		case "DialogueStreaming":
			return { state: previewDialogue(state, command.npcId, command.text), effects: [] };
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
			return { state: { ...state, time: advanceTime(state, command.amount) }, effects: [] };
		case "SceneFrame":
		case "SkipScene":
			// Both are handled by `duringScene`, which `reduce` reaches first whenever a scene
			// is playing — so arriving here means one turned up when there was no scene to
			// advance or skip. The UI only dispatches frames while `state.scene` is set, and a
			// stray one is nothing to report.
			return { state, effects: [] };
		case "ChunkReady": {
			// Folded rather than mapped, so a batch in which nothing is new returns the
			// state it was given and costs no render at all.
			let next = state;
			for (const key of command.keys) next = markDiscovered(next, key);
			return { state: next, effects: [] };
		}
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
		const portal = world.portalAt?.(nx, ny);
		if (portal?.kind === "exit") return leaveInterior(state);
		if (portal?.kind === "level") return changeLevel(state, portal);
	} else {
		// A gate before a door, because a gatehouse is both: the tile is a barrier on
		// the route and there may be a building behind it, and being told the way is
		// barred is more use than being silently refused entry to a guardroom.
		const barrier = world.barrierAt?.(nx, ny);
		if (barrier && !barrierOpen(state.flags, barrier.id)) {
			if (!evaluate(barrier.opensWhen, state)) {
				return { state: { ...state, notice: barrier.lockedText }, effects: [] };
			}
			// Opened, not walked through. The step costs the turn it takes to unbar the
			// thing, and the player then walks in — which reads better than sliding
			// through a gate in the same instant it gives way, and means the notice
			// announcing it is on screen while the gate is still in front of them.
			const opened = applyEffects(state, [{ t: "OpenBarrier", id: barrier.id }]);
			return {
				state: {
					...opened.state,
					...(barrier.opensText ? { notice: barrier.opensText } : {}),
					time: advanceTime(state, 1),
				},
				effects: [...opened.effects, { t: "Save", reason: "checkpoint" }],
			};
		}

		const door = world.doorAt?.(nx, ny);
		if (door) {
			if (door.lock && !evaluate(door.lock.opensWhen, state)) {
				return { state: { ...state, notice: door.lock.lockedText }, effects: [] };
			}
			return enterInterior(state, door, world);
		}
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
		time: advanceTime(state, 1),
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
			time: advanceTime(state, 1),
		},
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

/**
 * Move between storeys of the same interior.
 *
 * Not `leaveInterior` followed by `enterInterior`: the player never returns to the
 * world, so `returnX`/`returnY` must survive untouched. Coming out of the top of a
 * tower onto the doorstep of the building you went into is the whole of what this
 * has to get right.
 */
function changeLevel(
	state: GameState,
	to: { readonly level: number; readonly x: number; readonly y: number },
): Reduction {
	const inside = state.player.inside;
	if (!inside) return { state, effects: [] };
	return {
		state: {
			...state,
			player: {
				...state.player,
				x: to.x,
				y: to.y,
				inside: { ...inside, level: to.level },
			},
			time: advanceTime(state, 1),
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
			time: advanceTime(state, 1),
		},
		effects: [{ t: "Save", reason: "checkpoint" }],
	};
}

function markDiscovered(state: GameState, key: string): GameState {
	if (state.discovered.includes(key)) return state;
	return { ...state, discovered: [...state.discovered, key] };
}

/**
 * Move the action counter on, and re-derive the calendar from it.
 *
 * Takes the whole state rather than just its `time` because the calendar depends on the
 * world's clock settings, which live on `world` — and a world with the clock frozen has
 * to keep counting ticks while its hour stays put. Deriving from the tick every time,
 * rather than incrementing the hour, is what makes that a matter of not doing the
 * arithmetic instead of a second code path.
 */
function advanceTime(state: GameState, ticks: number): WorldTime {
	return timeFromTick(state.time.tick + ticks, state.world.time);
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

/**
 * Keep the words of a conversation that moved the story on.
 *
 * Every direction this game gives arrives in one of two places — a full screen of prose, or
 * somebody's mouth — and until now both were gone the moment they were dismissed. The
 * journal held a one-line summary written by the author, which is the right thing in a list
 * and no help at all an hour later when the player has forgotten which of three names the
 * ferryman told them to ask for.
 *
 * Attached to the last entry rather than added as a new one, because it is not a separate
 * event: it is what that event *was*. A beat writes its entry the moment its conversation
 * opens, and nothing else may write one while a conversation is open — a trigger's card and
 * the arc's ending both wait now — so the last entry is this conversation's, or there is no
 * entry to attach to and this does nothing.
 *
 * Ordinary chat is therefore silent, which is the point. A villager with nothing to do with
 * the story never opened a beat, so nothing here has anywhere to write.
 */
function keepWhatWasSaid(state: GameState): GameState {
	const lines = state.dialogue?.lines ?? [];
	if (lines.length === 0) return state;

	// `arc:` is what `beatClueSource` writes — a beat's own clue, which is the only journal
	// entry a conversation produces.
	const last = state.journal.at(-1);
	if (!last?.source?.startsWith("arc:") || last.detail) return state;

	const said = lines.map((line) => `${line.speaker}: ${line.text}`);
	return {
		...state,
		journal: [...state.journal.slice(0, -1), { ...last, detail: said }],
	};
}

/**
 * A card, as a journal entry.
 *
 * The title is the line in the list and the prose is what the reader opens. Headings go in
 * because a card's sections are how it is organised — "Where you are", "What you know" — and
 * stripping them would run three separate things into one paragraph.
 *
 * The card's own id is the source, which is what keeps a card that is somehow shown twice
 * from writing itself into the journal twice: `ShowCard` refuses a card already read, so
 * reaching here at all means this is the first time.
 */
function cardEntry(card: Card, tick: number): JournalEntry {
	const detail = card.sections.flatMap((section) =>
		section.heading ? [`${section.heading}: ${section.body}`] : [section.body],
	);
	return {
		tick,
		kind: "lore",
		text: card.subtitle ? `${card.title} — ${card.subtitle}` : card.title,
		source: cardKey(card.id),
		...(detail.length > 0 ? { detail } : {}),
	};
}

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

/**
 * Show the reply so far, without making it part of the conversation.
 *
 * Guarded the same way `receiveDialogueTurn` is, and for the same reason: a stream still
 * arriving for somebody the player has walked away from must not reopen their panel. Also
 * ignored once the turn is no longer pending, so a late chunk cannot paint a preview over
 * a reply that has already landed.
 */
function previewDialogue(state: GameState, npcId: string, text: string): GameState {
	const dialogue = state.dialogue;
	if (!dialogue || dialogue.npcId !== npcId || !dialogue.pending) return state;
	if (dialogue.preview === text) return state;
	return { ...state, dialogue: { ...dialogue, preview: text } };
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
	// `preview` is dropped rather than cleared to the empty string: the committed line is
	// the same sentence finished, so leaving a stale copy of it in the state would show
	// the reply twice for one frame.
	const { preview: _preview, ...rest } = dialogue;
	return {
		state: {
			...state,
			dialogue: {
				...rest,
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
			// The three fields, not the effect. Spreading the effect wrote its own `t`
			// into the inventory entry and then into the save, where an item carried a
			// field describing the message that produced it.
			return {
				...state,
				inventory: addItem(state.inventory, {
					name: effect.name,
					description: effect.description,
					quantity: effect.quantity,
				}),
			};
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
				...(effect.parentId === undefined ? {} : { parentId: effect.parentId }),
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
			// Kept, because a card is read once and gone. Everything the game says on a full
			// screen — the opening, a chapter turning, the end — is prose the player was meant
			// to act on, and it used to survive exactly as long as it took to press SPACE.
			const journal = [...state.journal, cardEntry(card, state.time.tick)];
			// Behind whatever is already up rather than over it. The flag is set either
			// way, because a queued card *will* be shown — it is the replacing that lost
			// one, not the queueing.
			if (state.card) {
				return {
					...state,
					flags,
					journal,
					pendingCards: [...(state.pendingCards ?? []), card],
				};
			}
			return { ...state, card, flags, journal };
		}
		case "RecordJournal":
			return {
				...state,
				journal: [...state.journal, { ...effect.entry, tick: state.time.tick }],
			};

		case "OpenBarrier":
			return openBarrier(state, effect.id);
		case "PlayScene":
			// Nothing here. Opening a scene means staging it against the world, and this layer
			// has no probe — `openScene`, called from `settle`, is where it happens.
			return state;
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

		case "RememberTurn":
			return {
				...state,
				dialogueCache: withCachedTurn(state.dialogueCache, effect.key, effect.turn),
			};

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

/**
 * Record a gate as open, in the two places that have to agree.
 *
 * The flag is what a condition reads; the delta is what the generator stamps back
 * over the tile next time the chunk is built, and therefore what the renderer draws
 * and what `isPassable` answers. Writing only the flag would leave a gate the player
 * has opened still barred on screen after the chunk was evicted; writing only the
 * delta would leave nothing for a later condition to ask about.
 *
 * Idempotent on the flag, so re-applying the effect — which a partially-saved turn
 * can do — appends nothing to the delta a second time.
 */
function openBarrier(state: GameState, id: string): GameState {
	if (state.flags[barrierKey(id)]) return state;
	const barrier = state.barriers?.find((candidate) => candidate.id === id);
	if (!barrier) return state;

	const gate = terrainDef(T.gateOpen);
	const deltas: Record<string, GameState["deltas"][string]> = { ...state.deltas };
	// A gate spans as many tiles as the road is wide, and they lift together — so the
	// whole span is written here rather than the one tile the player happened to face.
	for (const tile of barrier.tiles) {
		const key = chunkKey(toChunkX(tile.x), toChunkY(tile.y));
		const index = localIndex(toLocalX(tile.x), toLocalY(tile.y));
		const existing = deltas[key];
		deltas[key] = {
			...existing,
			tiles: [...(existing?.tiles ?? []), index, gate.id, gate.flags],
		};
	}

	return { ...state, flags: { ...state.flags, [barrierKey(id)]: true }, deltas };
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
