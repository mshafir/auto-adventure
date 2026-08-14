import { escalationModel, MODELS } from "../../config.js";
import { beatEffects, beatOpenedBy, storyNpcIds } from "../../core/rules/arc.js";
import { weatherRuns } from "../../core/rules/clock.js";
import { cachedTurn, turnKey } from "../../core/rules/dialogue-cache.js";
import type { DomainEffect } from "../../core/rules/effects.js";
import { type NpcRecord, needsSummary, SUMMARY_BATCH } from "../../core/rules/npc.js";
import { type StockItem, shopStock, tradeKind } from "../../core/rules/shop.js";
import type { GameState } from "../../core/rules/state.js";
import type { Surroundings } from "../../core/rules/surroundings.js";
import type { WorldSeed } from "../../core/world/recipe.js";
import type { RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import { weatherAt } from "../../core/world/weather.js";
import type { GameEngine } from "../../engine/engine.js";
import type { PlacedNpc } from "../../engine/npc-directory.js";
import { logger } from "../../utils/log.js";
import { aiAvailable, streamed, structured } from "../client.js";
import { mapActions } from "./actions.js";
import { cannedTurn } from "./canned.js";
import { dialoguePrompt, dialogueSystem, SUMMARY_SYSTEM, summaryPrompt } from "./persona.js";
import { DialogueTurnSchema, NpcSummarySchema } from "./schema.js";
import { isSilentEnd, scriptedTurn } from "./scripted.js";
import type { DialogueTree } from "./tree.js";

export interface DialogueDeps {
	readonly world: WorldSeed;
	readonly lore: () => WorldLore;
	readonly regionSpec: (regionId: number) => RegionSpec | undefined;
	readonly siteSpec: (siteId: number) => SiteSpec | undefined;
	readonly disabled?: boolean;
	/**
	 * Authored conversations, by npc id. Supplied for a prebuilt scenario.
	 *
	 * Takes precedence over a live call when present, which is the whole point of
	 * the flavour: the words were written and paid for already. Anyone without a
	 * tree still falls through to the deterministic one.
	 */
	readonly tree?: (npcId: string) => DialogueTree | undefined;
}

/**
 * Whether a model may speak for this person at all.
 *
 * Opt-in for an authored cast, and unchanged for everybody else. The old rule was "anyone the
 * author did not write a conversation for", which made improvisation the *default* for
 * everybody the author had not reached yet — so a half-written town was a town full of people
 * inventing facts about a story they had never been told, and the launcher's toggle read as
 * "anyone I forgot" rather than as a decision.
 *
 * A world with no authored spec for this site is a live or procedural one, where derived
 * residents are exactly who improvisation is for and nothing changes.
 */
function mayImprovise(site: SiteSpec | undefined, slot: number): boolean {
	const authored = site?.npcs.find((npc) => npc.slot === slot);
	return authored ? authored.live === true : true;
}

/**
 * One turn of conversation, and the memory that outlives it.
 *
 * The service owns no state. It reads the engine's, produces effects, and
 * dispatches them — so a turn that arrives after the player walked away is
 * simply a `DialogueTurn` command the reducer drops, not a write that lands in
 * a closed conversation.
 */
export function createDialogueService(deps: DialogueDeps) {
	const enabled = !deps.disabled && aiAvailable();

	async function runDialogueTurn(
		npcId: string,
		choice: string | undefined,
		engine: GameEngine,
	): Promise<void> {
		// Covers residents as well as the people standing outdoors. A resident is only
		// resolvable while the player is in their building, which is also the only time a
		// conversation with one can be open.
		const placed = engine.personById(npcId);
		if (!placed) {
			engine.dispatch({
				t: "DialogueTurn",
				npcId,
				speaker: "",
				text: "There is nobody here.",
			});
			return;
		}

		// Meeting someone creates their memory record; it must exist before the
		// turn is recorded against it.
		ensureRecord(engine, placed);
		// Then the story, before the line is written, so a live NPC given the quest in
		// its prompt can mention it.
		//
		// Only on the opening turn. Beats gate on flags set by earlier beats, so
		// checking every turn would let one conversation walk the entire story —
		// answer a question, open beat two, answer again, open beat three.
		//
		// The state as it was *before* the beat opened is kept for the scripted path.
		// A written tree greets by flag, and the flag a beat sets is set on the same
		// turn the beat opens — so reading it afterwards means "you already did this"
		// greets the player on first contact, and the first-meeting node the author
		// wrote is never reachable at all.
		const beforeBeat = engine.getState();
		if (!choice) openBeat(engine, npcId);
		if (choice) {
			engine.dispatch({
				t: "ApplyEffects",
				effects: [{ t: "RecordTurn", npcId, turn: { role: "player", text: choice } }],
			});
		}

		const state = engine.getState();
		const record = state.npcs[npcId];
		if (!record) return;

		const site = deps.siteSpec(placed.siteId);
		const stock = stockFor(deps.world.seed, placed);
		// Assembled once and passed to both the prompt and the action boundary, so
		// what the NPC is allowed to promise and what the engine will accept are the
		// same list rather than two views that can disagree.
		const surroundings = engine.surroundingsFor(placed.siteId);

		// Written words first. A prebuilt scenario has already paid for this
		// conversation, so there is nothing to gain by asking a model to improvise
		// over the top of it.
		const scripted = deps.tree
			? scriptedTurn({
					tree: deps.tree(npcId),
					state: choice ? state : beforeBeat,
					record,
					answered: choice,
				})
			: undefined;

		// Whether this person is allowed to improvise at all.
		//
		// The people the story hangs on are not, ever. Talking to one *is* the story
		// moving — the beat above has already opened, the errand is already in the log —
		// and a model asked to greet the player will write a perfectly good line about the
		// weather while the quest it was supposed to hand over sits behind it unmentioned.
		// That is precisely the failure this guards: errands appearing in the journal with
		// no conversation that could have produced them.
		//
		// The floor for them is `cannedTurn`, which is built from what this person knows
		// and what the site's hooks say — the same material a model would be given, minus
		// the licence to invent. Not silence, and not an error state.
		const fixed = storyNpcIds(state.arc).has(npcId) || !mayImprovise(site, placed.spec.slot);

		// A remembered reply is read whether or not a model is available, and that
		// asymmetry with *writing* is deliberate. Once these words exist they are content
		// this world owns, exactly like an authored tree — so a world played once with a
		// key and then opened without one keeps the conversations it already paid for
		// rather than falling back to the canned menu. Only generating needs a model.
		//
		// A scripted turn still wins: an author's words outrank a model's, and a written
		// tree is already the same every time, so there would be nothing to remember. Nor
		// is there anything to remember for somebody who never improvises.
		const key = scripted?.turn || fixed ? undefined : turnKey(state, npcId);
		const remembered = key ? cachedTurn(state, key) : undefined;
		if (remembered) logger.debug(`dialogue: replaying a remembered reply from ${record.name}`);
		if (fixed && !scripted?.turn) {
			logger.debug(`dialogue: ${record.name} anchors the story; answering without a model`);
		}

		const turn =
			scripted?.turn ??
			remembered ??
			(enabled && !fixed
				? await generateTurn(state, record, placed, site, stock, choice, surroundings, engine)
				: cannedTurn(record, placed.spec, site, choice));

		// A node that closed with `goto: null` said its piece on the previous line, so
		// there is nothing to add; dispatching it would put a blank row in the panel.
		// Only the tree writes one of these — a canned or generated turn that ends the
		// conversation still says goodbye.
		if (scripted?.turn && isSilentEnd(turn)) {
			engine.dispatch({ t: "CloseDialogue" });
			return;
		}

		const effects: DomainEffect[] = [
			{ t: "RecordTurn", npcId, turn: { role: "npc", text: turn.speech } },
			// Written only when a model actually wrote it. A replayed turn is already in the
			// cache, and re-storing it would refresh its eviction stamp on every reading —
			// which would slowly turn a "drop what has not been revisited" rule into its
			// opposite. A canned turn is a pure function of the state and gains nothing from
			// being remembered, so caching it would only be a way to pin a stale one.
			...(key && !remembered && enabled
				? [
						{
							t: "RememberTurn" as const,
							key,
							turn: {
								speech: turn.speech,
								choices: turn.choices,
								actions: turn.actions,
								endsConversation: turn.endsConversation,
								at: state.time.tick,
							},
						},
					]
				: []),
			...(scripted?.effects ?? []),
			...mapActions(turn.actions, {
				state: engine.getState(),
				npcId,
				npcName: record.name,
				stock,
				disposition: record.disposition,
				surroundings,
				siteId: placed.siteId,
				onDropped: (kind, target) =>
					logger.info(
						`dialogue: ${record.name} named a ${kind} target that does not exist here: ${target}`,
					),
			}),
		];

		engine.dispatch({
			t: "DialogueTurn",
			npcId,
			speaker: record.name,
			text: turn.speech,
			...(turn.endsConversation || turn.choices.length === 0
				? {}
				: { choices: turn.choices.slice(0, 4) }),
		});
		engine.dispatch({ t: "ApplyEffects", effects });
	}

	async function generateTurn(
		state: GameState,
		record: NpcRecord,
		placed: PlacedNpc,
		site: SiteSpec | undefined,
		stock: StockItem[] | undefined,
		choice: string | undefined,
		surroundings: Surroundings,
		engine: GameEngine,
	) {
		const region = deps.regionSpec(placed.regionId);
		const input = {
			lore: deps.lore(),
			...(region ? { region } : {}),
			...(site ? { site } : {}),
			spec: placed.spec,
			record,
			state,
			...(stock?.length ? { stock } : {}),
			surroundings,
			// Omitted entirely for a world with no sky, so the persona has nothing to
			// remark on rather than a description of weather that is not happening.
			...(weatherRuns(state.world.time)
				? { weather: weatherAt(deps.world, state.time.tick, placed.x, placed.y) }
				: {}),
		};

		// Streamed rather than awaited whole, so the line appears as it is written instead
		// of arriving all at once after a pause. The preview is cosmetic — the resolved
		// object below is still the only thing that becomes a turn — so a stream that
		// fails halfway leaves a partial sentence on screen that the fallback then
		// replaces, rather than a conversation in a bad state.
		const response = await streamed({
			kind: "dialogue",
			model: MODELS.dialogue,
			schema: DialogueTurnSchema,
			system: dialogueSystem(input),
			prompt: dialoguePrompt(input, choice),
			temperature: 0.85,
			/*
			 * One retry here, not the usual two, and it goes straight to the dearer model.
			 *
			 * This is the only model call in the game a player is actually sitting and
			 * waiting on, and the retry policy that is right for offline authoring is
			 * wrong here: three attempts at twenty seconds each is a minute of somebody
			 * staring at a name and a spinner, which is worse than the canned line they
			 * would have got immediately. So the wait is bounded at two attempts, and the
			 * second is spent on the model most likely to end it.
			 */
			retries: 1,
			...(escalationModel() ? { escalateTo: escalationModel() as string } : {}),
			onPartial: (partial) => {
				if (typeof partial.speech === "string" && partial.speech.length > 0) {
					engine.dispatch({ t: "DialogueStreaming", npcId: placed.id, text: partial.speech });
				}
			},
		});

		// A failed call must not end the conversation with an error message; the
		// deterministic tree knows the same facts and can carry it.
		if (!response) return cannedTurn(record, placed.spec, site, choice);
		return response;
	}

	/**
	 * Fold the oldest turns into the rolling summary.
	 *
	 * Runs after the panel closes, as an effect, so the player never waits on it.
	 * Without a model this simply trims, which keeps the record bounded — memory
	 * that grows forever would eventually be the largest thing in the save.
	 */
	async function summarizeNpc(npcId: string, engine: GameEngine): Promise<void> {
		const record = engine.getState().npcs[npcId];
		if (!record || !needsSummary(record)) return;

		const folding = record.recentTurns
			.slice(0, SUMMARY_BATCH)
			.map((turn) => (turn.role === "player" ? `Traveller: ${turn.text}` : `You: ${turn.text}`));

		if (!enabled) {
			engine.dispatch({
				t: "ApplyEffects",
				effects: [
					{
						t: "FoldNpcMemory",
						npcId,
						summary: record.summary,
						newFacts: [],
						foldedTurns: SUMMARY_BATCH,
					},
				],
			});
			return;
		}

		const response = await structured({
			kind: "summary",
			model: MODELS.summary,
			schema: NpcSummarySchema,
			system: SUMMARY_SYSTEM,
			prompt: summaryPrompt(record, folding),
			temperature: 0.4,
		});
		if (!response) {
			logger.debug(`summary for ${npcId} failed; keeping the previous one`);
			return;
		}

		const effects: DomainEffect[] = [
			{
				t: "FoldNpcMemory",
				npcId,
				summary: response.summary,
				newFacts: response.newFacts,
				foldedTurns: SUMMARY_BATCH,
			},
		];
		if (response.dispositionDelta !== 0) {
			effects.push({ t: "AdjustDisposition", npcId, delta: response.dispositionDelta });
		}
		engine.dispatch({ t: "ApplyEffects", effects });
	}

	return { runDialogueTurn, summarizeNpc };
}

/**
 * Advance the story, if this is the person who advances it.
 *
 * Talking to someone is the trigger because it is the one thing the player does
 * deliberately to a *specific* named character. Walking into a place is too easy to
 * do by accident, and picking something up is too easy to do without noticing.
 */
function openBeat(engine: GameEngine, npcId: string): void {
	const state = engine.getState();
	const beat = beatOpenedBy(state.arc, state, npcId);
	if (!beat) return;
	logger.debug(`arc: opening beat ${beat.id} at ${npcId}`);
	engine.dispatch({ t: "ApplyEffects", effects: beatEffects(beat) });
}

function ensureRecord(engine: GameEngine, placed: PlacedNpc): void {
	if (engine.getState().npcs[placed.id]) return;
	engine.dispatch({
		t: "ApplyEffects",
		effects: [
			{
				t: "MeetNpc",
				npcId: placed.id,
				name: placed.name,
				role: placed.role,
				siteId: placed.siteId,
				disposition: placed.spec.disposition,
			},
		],
	});
}

/**
 * What this person has to sell.
 *
 * Derived from their role and their slot in the settlement, so a blacksmith's
 * shelf is the same shelf every time the player comes back — and the same after
 * a reload, because nothing about it is stored.
 */
function stockFor(seed: number, placed: PlacedNpc): StockItem[] | undefined {
	const kind = tradeKind(placed.role);
	if (!kind) return undefined;
	return shopStock(seed, placed.siteId, placed.spec.slot, kind);
}
