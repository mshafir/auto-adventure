import { MODELS } from "../../config.js";
import type { DomainEffect } from "../../core/rules/effects.js";
import { type NpcRecord, needsSummary, SUMMARY_BATCH } from "../../core/rules/npc.js";
import { type StockItem, shopStock, tradeKind } from "../../core/rules/shop.js";
import type { GameState } from "../../core/rules/state.js";
import type { Surroundings } from "../../core/rules/surroundings.js";
import type { RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import { weatherAt } from "../../core/world/weather.js";
import type { GameEngine } from "../../engine/engine.js";
import type { PlacedNpc } from "../../engine/npc-directory.js";
import { logger } from "../../utils/log.js";
import { aiAvailable, structured } from "../client.js";
import { mapActions } from "./actions.js";
import { cannedTurn } from "./canned.js";
import { dialoguePrompt, dialogueSystem, SUMMARY_SYSTEM, summaryPrompt } from "./persona.js";
import { DialogueTurnSchema, NpcSummarySchema } from "./schema.js";

export interface DialogueDeps {
	readonly seed: number;
	readonly lore: () => WorldLore;
	readonly regionSpec: (regionId: number) => RegionSpec | undefined;
	readonly siteSpec: (siteId: number) => SiteSpec | undefined;
	readonly disabled?: boolean;
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
		const placed = engine.getNpcs().byNpcId(npcId);
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
		const stock = stockFor(deps.seed, placed);
		// Assembled once and passed to both the prompt and the action boundary, so
		// what the NPC is allowed to promise and what the engine will accept are the
		// same list rather than two views that can disagree.
		const surroundings = engine.surroundingsFor(placed.siteId);
		const turn = enabled
			? await generateTurn(state, record, placed, site, stock, choice, surroundings)
			: cannedTurn(record, placed.spec, site, choice);

		const effects: DomainEffect[] = [
			{ t: "RecordTurn", npcId, turn: { role: "npc", text: turn.speech } },
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
			weather: weatherAt(deps.seed, state.time.tick, placed.x, placed.y),
		};

		const response = await structured({
			kind: "dialogue",
			model: MODELS.dialogue,
			schema: DialogueTurnSchema,
			system: dialogueSystem(input),
			prompt: dialoguePrompt(input, choice),
			temperature: 0.85,
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
