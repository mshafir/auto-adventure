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

/** Structure kinds that hold stock at all. */
export function sellsGoods(kind: StructureKind | string): boolean {
	return (
		kind === "shop" ||
		kind === "smithy" ||
		kind === "apothecary" ||
		kind === "inn" ||
		kind === "stable" ||
		kind === "warehouse"
	);
}

const CATALOGUE: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
	shop: [
		["Coil of Rope", "Forty feet of it, waxed against the wet."],
		["Tallow Candles", "A bundle of six. They smell of the rendering shed."],
		["Tin Lantern", "Dented, but the shutter still works."],
		["Travelling Cloak", "Heavy wool, patched at one shoulder."],
		["Iron Nails", "A twist of paper holding two dozen."],
		["Flint and Steel", "Struck often enough to have worn a groove."],
	],
	smithy: [
		["Hand Axe", "Well balanced, meant for wood rather than war."],
		["Iron Knife", "Plain, sharp, and honestly made."],
		["Horseshoe", "Fitted for a heavy animal."],
		["Steel Sword", "Second-hand. Somebody's initials are on the pommel."],
		["Chain Shirt", "Rust has been scoured off it more than once."],
	],
	apothecary: [
		["Bitterroot Salve", "Smells terrible. Closes a cut in a day."],
		["Fever Draught", "Cloudy, and warm to the touch."],
		["Dried Yarrow", "A paper packet, tied with thread."],
		["Sleeping Tincture", "Three drops. No more, the label insists."],
	],
	inn: [
		["Loaf and Cheese", "Yesterday's bread, today's cheese."],
		["Skin of Ale", "Thin, but cold."],
		["Bowl of Stew", "Mostly turnip. Filling."],
		["A Bed for the Night", "Straw mattress, shared room, no questions."],
	],
	stable: [
		["Bag of Oats", "Enough for a week on the road."],
		["Leather Halter", "Softened with use."],
		["Saddle Blanket", "Faded to no colour at all."],
	],
	warehouse: [
		["Crate of Salt", "Heavy, and worth carrying anyway."],
		["Bolt of Linen", "Unbleached. Sold by the ell."],
		["Barrel Hoops", "Six of them, banded together."],
	],
};

/**
 * What this shop has today.
 *
 * Deterministic in `(seed, siteId, slot)`, so the stock is the same every time
 * the player walks in and the same after a reload — the shop is part of the
 * world, not a roll made when the panel opens.
 */
export function shopStock(seed: number, siteId: number, slot: number, kind: string): StockItem[] {
	const catalogue = CATALOGUE[kind] ?? CATALOGUE.shop ?? [];
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
