import { rngFor } from "../rand/rng.js";
import { D, type DecorId, decorDef } from "../tiles/decor.js";

/**
 * What is inside the crates.
 *
 * Until now nothing in the world could be picked up: the only routes into the
 * inventory were an NPC handing something over and buying it, so any errand of
 * the form "go and find X" was impossible to finish however well it was grounded.
 * The generator was already placing crates, barrels, chests and shelves in every
 * interior — they were simply inert scenery.
 *
 * Contents are a pure function of `(seed, place, position)`, exactly like terrain,
 * so a barrel holds the same thing however many times the chunk is evicted and
 * rebuilt, and no container state has to be saved. What *is* saved is the fact
 * that a container has been emptied, which is a single flag.
 */

export interface LootItem {
	readonly name: string;
	readonly description: string;
	readonly quantity: number;
}

/** Decor worth searching. Furniture the player cannot open is not a container. */
const CONTAINERS: ReadonlySet<DecorId> = new Set([D.chest, D.crate, D.barrel, D.shelf]);

export function isContainer(decor: DecorId): boolean {
	return CONTAINERS.has(decor);
}

/**
 * The goods a building keeps, by what the building is for.
 *
 * This is the catalogue a `have` objective can legitimately name, so it is also
 * why a mill can be asked for timber and a temple cannot. Weighted by listing
 * order rather than by an explicit number: the first entries are the everyday
 * stock and the last are the finds.
 */
const STORES: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
	mill: [
		["Sack of Flour", "Coarse-ground, and still warm from the stones."],
		["Sack of Grain", "Unmilled, with the chaff still in it."],
		["Timber", "Rough-sawn planks, stacked and banded."],
		["Millstone Grit", "Swept up from under the runner stone."],
	],
	barn: [
		["Bale of Hay", "Tight-bound and dusty."],
		["Sack of Grain", "Unmilled, with the chaff still in it."],
		["Timber", "Rough-sawn planks, stacked and banded."],
	],
	warehouse: [
		["Timber", "Rough-sawn planks, stacked and banded."],
		["Bolt of Cloth", "Undyed linen, wound on a wooden core."],
		["Barrel of Salt", "Heavy, and worth more than it looks."],
		["Iron Nails", "A twist of paper holding two dozen."],
	],
	smithy: [
		["Iron Ore", "Rust-red lumps, unsmelted."],
		["Charcoal", "A sack of it, light as nothing."],
		["Scrap Iron", "Offcuts and failures, kept for remelting."],
	],
	stable: [
		["Feed Sack", "Oats, mostly."],
		["Leather Harness", "Supple, and recently oiled."],
	],
	inn: [
		["Bottle of Ale", "Cloudy, and stoppered with a rag."],
		["Wheel of Cheese", "Rinded and heavy."],
		["Tallow Candles", "A bundle of six."],
	],
	shop: [
		["Bolt of Cloth", "Undyed linen, wound on a wooden core."],
		["Tallow Candles", "A bundle of six."],
		["Coil of Rope", "Forty feet of it, waxed against the wet."],
	],
	apothecary: [
		["Dried Herbs", "Bundled and labelled in a small hand."],
		["Clay Vial", "Empty, and stoppered with wax."],
	],
	temple: [["Beeswax Candles", "Better than tallow, and kept for feast days."]],
	barracks: [
		["Iron Nails", "A twist of paper holding two dozen."],
		["Whetstone", "Worn hollow in the middle."],
	],
	ruin: [
		["Tarnished Coins", "Old currency, of a mint nobody here uses."],
		["Rusted Key", "It fits something. Not this."],
	],
	farmhouse: [
		["Sack of Grain", "Unmilled, with the chaff still in it."],
		["Preserved Fruit", "In a sealed crock, and still good."],
	],
	house: [
		["Tallow Candles", "A bundle of six."],
		["Woollen Blanket", "Patched, and clean."],
	],
};

/** Falls back to the plainest household goods rather than to nothing. */
function storeFor(structure: string): readonly (readonly [string, string])[] {
	return STORES[structure] ?? STORES.house ?? [];
}

/**
 * Every item name a building of this kind could yield.
 *
 * The engine hands this to the quest resolver, which is what makes "fetch me
 * timber" a legal request in a milling town and an illegal one in a fishing
 * village — without either the model or the resolver hardcoding a list.
 */
export function itemsStoredIn(structure: string): readonly string[] {
	return storeFor(structure).map(([name]) => name);
}

/**
 * A stable identity for one container, for remembering that it was emptied.
 *
 * Keyed on the interior and the local position rather than on anything mutable,
 * so it survives the chunk being evicted and regenerated.
 */
export function lootKey(place: number | undefined, x: number, y: number, level = 0): string {
	// The ground floor keeps the key it always had, so a save made before interiors
	// had storeys still knows which crates it emptied. Anything above it is a distinct
	// grid that happens to share coordinates, and sharing the key would mean looting a
	// chest on the ground floor emptied the one directly above it.
	const floor = level === 0 ? "" : `:${level}`;
	return `looted:${place ?? "world"}${floor}:${x},${y}`;
}

/**
 * What this container holds, or nothing if it is empty by nature.
 *
 * A chest is worth more than a shelf, so the roll is per decor kind: chests
 * always hold something, everyday storage usually holds nothing, and that is what
 * keeps a warehouse of fourteen crates from being fourteen free items.
 */
export function containerContents(
	seed: number,
	place: number,
	x: number,
	y: number,
	decor: DecorId,
	structure: string,
	level = 0,
): readonly LootItem[] {
	if (!isContainer(decor)) return [];

	const store = storeFor(structure);
	if (store.length === 0) return [];

	// The level joins the stream only above the ground floor, for the same reason it
	// joins the key only above it: a chest on level 0 must roll what it always rolled.
	const rng =
		level === 0 ? rngFor(seed, "loot", place, x, y) : rngFor(seed, "loot", place, x, y, level);

	// A chest is a find; a crate is furniture that happens to have a lid.
	const chance = decor === D.chest ? 1 : decor === D.barrel ? 0.45 : 0.35;
	if (!rng.chance(chance)) return [];

	// Weighted toward the front of the list, so the everyday stock is common and
	// the last entry is a find. Squaring a uniform roll is enough of a curve.
	const roll = rng.float();
	const index = Math.min(store.length - 1, Math.floor(roll * roll * store.length));
	const entry = store[index];
	if (!entry) return [];

	const quantity = decor === D.chest ? 1 + rng.int(2) : 1;
	return [{ name: entry[0], description: entry[1], quantity }];
}

/** How the container reads when the player searches it and finds nothing. */
export function emptyMessage(decor: DecorId): string {
	return `The ${decorDef(decor).name} is empty.`;
}
