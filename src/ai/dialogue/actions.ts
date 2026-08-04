import type { DomainEffect } from "../../core/rules/effects.js";
import { basePrice, buyPrice, type StockItem, sellPrice } from "../../core/rules/shop.js";
import type { GameState, QuestObjective } from "../../core/rules/state.js";
import { itemCount } from "../../core/rules/state.js";
import type { ActionResponse } from "./schema.js";

/**
 * Turn what an NPC asked for into what actually happens.
 *
 * This is the security boundary of the whole AI layer, and it is a pure
 * function so it can be tested exhaustively against recorded and deliberately
 * malformed input. Two rules:
 *
 * 1. **Missing or nonsensical fields drop the action**, they never throw and
 *    never half-apply. A model that returns `{kind:'giveItem'}` with no item
 *    gets nothing, not an item called "undefined".
 * 2. **The engine has the last word on what the player owns.** An NPC may ask
 *    to take three Gold; if the player has one, one is taken. The model is
 *    never trusted with arithmetic it cannot see the inputs to.
 */

export interface ActionContext {
	readonly state: GameState;
	readonly npcId: string;
	readonly npcName: string;
	/** What this NPC has for sale, if they are a trader. */
	readonly stock?: readonly StockItem[];
	/** Their regard for the player, which moves prices inside a fixed band. */
	readonly disposition?: number;
}

/** Bounds on a single action, so one bad turn cannot rewrite the save. */
const MAX_ITEM_QUANTITY = 99;
const MAX_GOLD = 500;
const MAX_HEAL = 20;
const MAX_DISPOSITION_STEP = 15;

export function mapActions(
	actions: readonly ActionResponse[],
	context: ActionContext,
): DomainEffect[] {
	const effects: DomainEffect[] = [];
	// Track gold and items as we go, so two takeItem actions in one turn cannot
	// each spend the same coin.
	const spent = new Map<string, number>();

	for (const action of actions) {
		const mapped = mapOne(action, context, spent);
		if (mapped) effects.push(...mapped);
	}
	return effects;
}

function mapOne(
	action: ActionResponse,
	context: ActionContext,
	spent: Map<string, number>,
): DomainEffect[] | undefined {
	switch (action.kind) {
		case "giveItem": {
			const name = clean(action.item);
			if (!name) return undefined;
			return [
				{
					t: "GrantItem",
					name,
					description: clean(action.description) ?? "Given to you.",
					quantity: quantityOf(action.quantity, 1, MAX_ITEM_QUANTITY, 1),
				},
			];
		}

		case "takeItem": {
			const name = clean(action.item);
			if (!name) return undefined;
			const available = held(context.state, name, spent);
			if (available <= 0) return undefined;
			const wanted = quantityOf(action.quantity, 1, MAX_ITEM_QUANTITY, 1);
			const quantity = Math.min(wanted, available);
			record(spent, name, quantity);
			return [{ t: "TakeItem", name, quantity }];
		}

		case "adjustGold": {
			const amount = quantityOf(action.quantity, -MAX_GOLD, MAX_GOLD, 0);
			if (amount === 0) return undefined;
			if (amount < 0) {
				// Never leave the player owing money they do not have.
				const available = held(context.state, "Gold", spent);
				const taken = Math.min(-amount, available);
				if (taken <= 0) return undefined;
				record(spent, "Gold", taken);
				return [{ t: "AdjustGold", amount: -taken }];
			}
			return [{ t: "AdjustGold", amount }];
		}

		case "createQuest": {
			const id = slug(action.questId ?? action.questName);
			const name = clean(action.questName);
			if (!id || !name) return undefined;
			return [
				{
					t: "CreateQuest",
					id,
					name,
					description: clean(action.description) ?? name,
					objectives: mapObjectives(action.objectives),
				},
			];
		}

		case "advanceQuest": {
			const id = slug(action.questId);
			const note = clean(action.note);
			if (!id || !note) return undefined;
			return [{ t: "AdvanceQuest", id, note }];
		}

		case "completeQuest": {
			const id = slug(action.questId);
			if (!id) return undefined;
			return [{ t: "CompleteQuest", id }];
		}

		case "setFlag": {
			const key = slug(action.key);
			if (!key) return undefined;
			return [{ t: "SetFlag", key, value: clean(action.value) ?? true }];
		}

		case "adjustDisposition": {
			const delta = quantityOf(action.quantity, -MAX_DISPOSITION_STEP, MAX_DISPOSITION_STEP, 0);
			if (delta === 0) return undefined;
			return [{ t: "AdjustDisposition", npcId: context.npcId, delta }];
		}

		case "recordJournal": {
			const text = clean(action.note) ?? clean(action.description);
			if (!text) return undefined;
			return [
				{
					t: "RecordJournal",
					entry: { kind: "rumor", text, source: context.npcName },
				},
			];
		}

		case "heal": {
			// Zero is the floor here, so a heal with no amount stated heals nothing
			// rather than being clamped up into a free point of health.
			const amount = quantityOf(action.quantity, 0, MAX_HEAL, 0);
			if (amount <= 0) return undefined;
			return [{ t: "Heal", amount }];
		}

		case "adjustReputation": {
			const faction = clean(action.key) ?? clean(action.value);
			const delta = quantityOf(action.quantity, -MAX_DISPOSITION_STEP, MAX_DISPOSITION_STEP, 0);
			if (!faction || delta === 0) return undefined;
			return [{ t: "AdjustReputation", faction, delta }];
		}

		case "buy": {
			// The model names the goods; the engine names the price and checks the
			// purse. An NPC cannot sell what they do not stock, at a price they
			// invented, to a player who cannot pay.
			const name = clean(action.item);
			if (!name) return undefined;
			const item = findStock(context.stock, name);
			if (!item) return undefined;

			const wanted = quantityOf(action.quantity, 1, MAX_ITEM_QUANTITY, 1);
			const unit = buyPrice(item.price, context.disposition ?? 0);
			const purse = held(context.state, "Gold", spent);
			const affordable = Math.min(wanted, Math.floor(purse / unit));
			if (affordable <= 0) return undefined;

			const cost = affordable * unit;
			record(spent, "Gold", cost);
			return [
				{ t: "AdjustGold", amount: -cost },
				{
					t: "GrantItem",
					name: item.name,
					description: item.description,
					quantity: affordable,
				},
			];
		}

		case "sell": {
			const name = clean(action.item);
			if (!name) return undefined;
			const carried = context.state.inventory.find(
				(i) => i.name.toLowerCase() === name.toLowerCase(),
			);
			// Selling the purse itself is not a trade.
			if (!carried || carried.name.toLowerCase() === "gold") return undefined;

			const available = held(context.state, carried.name, spent);
			const quantity = Math.min(quantityOf(action.quantity, 1, MAX_ITEM_QUANTITY, 1), available);
			if (quantity <= 0) return undefined;

			const unit = sellPrice(
				basePrice(carried.name, carried.description),
				context.disposition ?? 0,
			);
			record(spent, carried.name, quantity);
			return [
				{ t: "TakeItem", name: carried.name, quantity },
				{ t: "AdjustGold", amount: unit * quantity },
			];
		}
	}
}

/** Match a requested purchase against the shelf, tolerantly. */
function findStock(stock: readonly StockItem[] | undefined, name: string): StockItem | undefined {
	if (!stock || stock.length === 0) return undefined;
	const wanted = name.toLowerCase();
	return (
		stock.find((item) => item.name.toLowerCase() === wanted) ??
		stock.find(
			(item) =>
				item.name.toLowerCase().includes(wanted) || wanted.includes(item.name.toLowerCase()),
		)
	);
}

function mapObjectives(objectives: ActionResponse["objectives"]): readonly QuestObjective[] {
	if (!objectives) return [];
	const mapped: QuestObjective[] = [];
	for (const objective of objectives) {
		const target = clean(objective.target);
		if (!target) continue;
		mapped.push({
			kind: objective.kind,
			target,
			...(objective.quantity ? { quantity: quantityOf(objective.quantity, 1, 99, 1) } : {}),
			done: false,
		});
	}
	return mapped;
}

function held(state: GameState, name: string, spent: Map<string, number>): number {
	return itemCount(state, name) - (spent.get(name.toLowerCase()) ?? 0);
}

function record(spent: Map<string, number>, name: string, quantity: number): void {
	const key = name.toLowerCase();
	spent.set(key, (spent.get(key) ?? 0) + quantity);
}

function clean(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** Quest ids and flag keys are identities, so they are normalised rather than
 * trusted: `Find the Lamp` and `find-the-lamp` must be the same quest. */
function slug(value: string | null | undefined): string | undefined {
	const trimmed = clean(value);
	if (!trimmed) return undefined;
	const slugged = trimmed
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return slugged || undefined;
}

/**
 * Coerce a model-supplied number into range.
 *
 * Missing and `NaN` fall back to `fallback` rather than to a bound — clamping a
 * missing value up to `min` is how an action with no quantity quietly becomes an
 * action with quantity 1, which is the wrong answer for anything the player
 * would notice. Infinities saturate, because a model that says "infinite gold"
 * means "as much as you'll allow".
 */
function quantityOf(
	value: number | null | undefined,
	min: number,
	max: number,
	fallback: number,
): number {
	if (value === null || value === undefined || Number.isNaN(value)) return fallback;
	if (value === Number.POSITIVE_INFINITY) return max;
	if (value === Number.NEGATIVE_INFINITY) return min;
	return Math.max(min, Math.min(max, Math.trunc(value)));
}
