import { DEFAULT_GOODS, type GoodsTables } from "../content/goods.js";
import type { StructureKind } from "../gen/features/patch.js";
import { hashString } from "../rand/hash.js";
import { rngFor } from "../rand/rng.js";

/**
 * Prices, decided by the engine.
 *
 * The model may *say* anything about a price; what the player actually pays is
 * computed here. That distinction is the whole design: an NPC who offers a
 * "special deal" is roleplaying, not editing the economy. Haggling exists, but
 * only inside a band the engine sets, and only as a function of disposition —
 * which is what makes being liked worth something.
 */

export interface StockItem {
	readonly name: string;
	readonly description: string;
	readonly price: number;
}

/** Keywords that move an item's value, checked against name and description. */
const VALUE_HINTS: readonly (readonly [RegExp, number])[] = [
	[/\b(gold|silver|jewel|gem|ruby|pearl|silk|relic|heirloom)\b/i, 6],
	[/\b(steel|iron|sword|axe|armou?r|shield|lantern|lock|key)\b/i, 3],
	[/\b(map|charter|deed|letter|book|scroll|ledger)\b/i, 2.2],
	[/\b(rope|nail|cloth|oil|candle|flint|tool)\b/i, 1.2],
	[/\b(bread|apple|turnip|cheese|ale|water|herb|straw)\b/i, 0.4],
];

const BASE = 6;

/**
 * What a thing is worth, from its name alone.
 *
 * Items are invented by the model at runtime, so there is no catalogue to look
 * them up in. Hashing the name gives a stable, arbitrary-but-consistent price;
 * the keyword hints stop a loaf of bread costing more than a sword.
 */
export function basePrice(name: string, description = ""): number {
	const text = `${name} ${description}`;
	let multiplier = 1;
	for (const [pattern, weight] of VALUE_HINTS) {
		if (pattern.test(text)) {
			multiplier = weight;
			break;
		}
	}
	// A little deterministic spread so two mundane items are not both worth 6.
	const spread = 0.75 + ((hashString(name.toLowerCase()) >>> 0) % 51) / 100;
	return Math.max(1, Math.round(BASE * multiplier * spread));
}

/**
 * What this shopkeeper charges you specifically.
 *
 * Disposition moves the price by at most a quarter in either direction. Wide
 * enough that being liked is noticeable, narrow enough that nothing is ever
 * free — an NPC cannot be talked into ruining themselves.
 */
export function buyPrice(base: number, disposition: number): number {
	const adjustment = 1 - Math.max(-100, Math.min(100, disposition)) / 400;
	return Math.max(1, Math.round(base * adjustment));
}

/** What they will pay you. Always well under what they charge. */
export function sellPrice(base: number, disposition: number): number {
	const adjustment = 0.4 + Math.max(-100, Math.min(100, disposition)) / 500;
	return Math.max(1, Math.round(base * adjustment));
}

/**
 * Structure kinds that hold stock at all.
 *
 * A kind with a catalogue is a kind that trades, rather than six names written down
 * again. The default tables list exactly those six, so nothing about an ordinary world
 * changes — but a pack that adds a `fletcher` catalogue now gets a fletcher who sells
 * things, where before this said no and there was nowhere to say otherwise.
 */
export function sellsGoods(
	kind: StructureKind | string,
	goods: GoodsTables = DEFAULT_GOODS,
): boolean {
	return goods.catalogue[kind] !== undefined;
}

/**
 * What this shop has today.
 *
 * Deterministic in `(seed, siteId, slot)`, so the stock is the same every time
 * the player walks in and the same after a reload — the shop is part of the
 * world, not a roll made when the panel opens.
 */
export function shopStock(
	seed: number,
	siteId: number,
	slot: number,
	kind: string,
	goods: GoodsTables = DEFAULT_GOODS,
): StockItem[] {
	const catalogue = goods.catalogue[kind] ?? goods.catalogue.shop ?? [];
	if (catalogue.length === 0) return [];

	const rng = rngFor(seed, "shop:stock", siteId, slot);
	const available = [...catalogue];
	const count = Math.min(available.length, 3 + rng.int(2));
	const stock: StockItem[] = [];

	for (let i = 0; i < count; i++) {
		const index = rng.int(available.length);
		const entry = available.splice(index, 1)[0];
		if (!entry) break;
		stock.push({ name: entry[0], description: entry[1], price: basePrice(entry[0], entry[1]) });
	}
	// Stable order regardless of draw order, so the list does not shuffle.
	return stock.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The shop catalogue a role trades from, or `undefined` if they sell nothing.
 *
 * Roles are prose written by the director ("the village farrier"), so this reads
 * them rather than requiring an exact kind. It lives beside the catalogue because
 * both the dialogue layer, which prices what an NPC offers, and the engine, which
 * has to know which item names exist before a quest may ask for one, need the same
 * answer — and two copies of this mapping would drift.
 */
export function tradeKind(role: string, goods: GoodsTables = DEFAULT_GOODS): string | undefined {
	const words = new Set(
		role
			.toLowerCase()
			.split(/[^a-z]+/)
			.filter(Boolean),
	);
	for (const trade of goods.trades) {
		if (trade.roles.some((word) => words.has(word))) return trade.kind;
	}
	// A role that names a catalogue outright trades from it, whether or not anybody
	// wrote a pattern for it. This is the half that was missing: the old fall-back
	// tested the *whole* role string against six hard-coded kinds, so "the village
	// fletcher" matched nothing even in a pack that had gone to the trouble of writing a
	// fletcher's catalogue — the fletcher sold nothing, and because `obtainableItems`
	// reads shop stock, no errand could name their wares either. A pack adds a trade by
	// adding a catalogue, which is the one thing it was always going to do anyway.
	for (const word of words) if (goods.catalogue[word]) return word;
	return undefined;
}
