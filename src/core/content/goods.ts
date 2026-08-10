/**
 * What there is to find, buy and gather, as data.
 *
 * Three tables that were compiled into three modules: what a building keeps in its
 * crates (`loot.ts`), what a shop sells (`shop.ts`), and what the ground gives up
 * (`forage.ts`). All three are prose about a *place*, and they are where a content pack's
 * illusion broke hardest — a Camelot smith renamed by the pack still sold the same
 * `Horseshoe` as every other world, because there was one catalogue and it was in the
 * program.
 *
 * **These are not cosmetic, and that is why they were not in the pack.** `pack.ts`
 * promises that a world opened with the wrong pack looks different but cannot become
 * unplayable, and goods are precisely what that promise was protecting: `obtainableItems`
 * reads all three to decide which item names a `have` objective may legitimately use, so
 * an emptied catalogue is an errand for a thing that does not exist.
 *
 * What changed is not the risk but the ability to check it. `obtainableItems` answers
 * "could the player ever hold this" from every source at once, `checkCompleteness` proves
 * the arc closes, and `repairUntilClean` fixes what it can — so a goods override is now
 * *verifiable* rather than merely trusted, which it was not when the cosmetic-only rule
 * was written. The rule still holds for every other table in a pack.
 */

/** A thing, and the one line that describes it. */
export type GoodsEntry = readonly [name: string, description: string];

/** A shop kind, and the words in a role that mean somebody keeps one. */
export interface Trade {
	readonly kind: string;
	readonly roles: readonly string[];
}

export interface GoodsTables {
	/**
	 * What a building of each kind keeps in its containers, keyed by structure kind.
	 *
	 * Weighted by listing order rather than by an explicit number: the first entries are
	 * the everyday stock and the last are the finds. `house` is the fallback.
	 */
	readonly stores: Readonly<Record<string, readonly GoodsEntry[]>>;
	/** What a shop of each kind sells. A kind listed here is a kind that trades. */
	readonly catalogue: Readonly<Record<string, readonly GoodsEntry[]>>;
	/**
	 * Which catalogue a role trades from, in the order the patterns are tried.
	 *
	 * An ordered list rather than a map, because the first match wins and object key
	 * order is a property of how a file happened to be written. Roles are prose the
	 * director wrote — "the village farrier" — so these are matched as words rather than
	 * required to be exact.
	 */
	readonly trades: readonly Trade[];
	/** What each kind of ground gives up, keyed by terrain key. */
	readonly yields: Readonly<Record<string, readonly GoodsEntry[]>>;
	/**
	 * How willing each ground is to give anything up, keyed by terrain key.
	 *
	 * Lower than a container's odds, and deliberately so: there is a great deal of grass
	 * in the world and a meadow that yielded on every tile would be a shop.
	 */
	readonly forageChance: Readonly<Record<string, number>>;
}

/** A pack's say over the goods. Every table is optional and merges by key. */
export interface GoodsOverride {
	readonly stores?: Readonly<Record<string, readonly GoodsEntry[]>>;
	readonly catalogue?: Readonly<Record<string, readonly GoodsEntry[]>>;
	readonly trades?: readonly Trade[];
	readonly yields?: Readonly<Record<string, readonly GoodsEntry[]>>;
	readonly forageChance?: Readonly<Record<string, number>>;
}

/**
 * Lay an override over the goods.
 *
 * Maps merge by key and the trade list replaces, which is `mergePack`'s pair of rules
 * for its reasons: changing what the smith sells should not silently empty the
 * apothecary, and writing `trades` means these are the trades.
 *
 * A pack rarely needs to write `trades` at all, because {@link Trade} is only the
 * *shortcut*: a role that is itself a catalogue key trades from it whether or not
 * anybody wrote a pattern. That is what makes adding a fletcher one table entry.
 */
export function mergeGoods(base: GoodsTables, override?: GoodsOverride): GoodsTables {
	if (!override) return base;
	return {
		stores: { ...base.stores, ...override.stores },
		catalogue: { ...base.catalogue, ...override.catalogue },
		trades: override.trades ?? base.trades,
		yields: { ...base.yields, ...override.yields },
		forageChance: { ...base.forageChance, ...override.forageChance },
	};
}

/** Lay one override over another, for a scenario that borrows a pack and adds to it. */
export function mergeGoodsOverride(
	base: GoodsOverride | undefined,
	over: GoodsOverride | undefined,
): GoodsOverride | undefined {
	if (!base) return over;
	if (!over) return base;
	return {
		stores: { ...base.stores, ...over.stores },
		catalogue: { ...base.catalogue, ...over.catalogue },
		...((over.trades ?? base.trades) ? { trades: over.trades ?? base.trades } : {}),
		yields: { ...base.yields, ...over.yields },
		forageChance: { ...base.forageChance, ...over.forageChance },
	};
}

/**
 * The goods a world runs on when nobody has said otherwise.
 *
 * Lifted verbatim from `loot.ts`, `shop.ts` and `forage.ts`, so a world with no goods
 * override finds, sells and gathers exactly what it always did.
 */
export const DEFAULT_GOODS: GoodsTables = {
	stores: {
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
		hall: [
			["Bottle of Ale", "Cloudy, and stoppered with a rag."],
			["Tallow Candles", "A bundle of six."],
			["Tally Stick", "Notched, split, and half of it kept elsewhere."],
		],
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
	},
	catalogue: {
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
	},
	trades: [
		{ kind: "smithy", roles: ["smith", "blacksmith", "farrier", "armourer", "armorer"] },
		{ kind: "apothecary", roles: ["apothecary", "herbalist", "healer", "physician"] },
		{ kind: "inn", roles: ["innkeep", "innkeeper", "inn", "tavern", "cook", "baker"] },
		{ kind: "stable", roles: ["stable", "ostler", "groom"] },
		{ kind: "warehouse", roles: ["factor", "warehouse", "quartermaster"] },
		{
			kind: "shop",
			roles: ["shop", "merchant", "trader", "pedlar", "peddler", "grocer", "chandler"],
		},
	],
	yields: {
		crops: [
			["Sheaf of Barley", "Cut green and tied with its own straw."],
			["Cushion Moss", "Grows thick at the foot of the stalks, where the shade sits."],
		],
		forestFloor: [
			["Cushion Moss", "Deep green, and damp all the way through."],
			["Wood Mushrooms", "Pale, and growing in a rough ring."],
			["Kindling", "Dry twigs, gathered by the handful."],
		],
		marsh: [
			["Sphagnum Moss", "Sodden, and it holds far more water than it looks able to."],
			["Bog Myrtle", "Bitter to the nose, and said to keep flies off."],
		],
		tallGrass: [
			["Meadow Herbs", "Whatever was worth taking from a hand's width of meadow."],
			["Seed Heads", "Shaken loose into a twist of cloth."],
		],
		reeds: [
			["Cut Reeds", "A bundle of them, still wet at the ends."],
			["Reed Mace", "The brown heads, which burn slowly and smell of nothing."],
		],
		bush: [
			["Bramble Berries", "Dark, and they stain everything they touch."],
			["Thorn Cuttings", "Springy, and awkward to carry."],
		],
		flowers: [["Wildflowers", "Picked with enough stem to be worth putting in water."]],
		deadTree: [["Kindling", "Split from a trunk that has been dead long enough to be dry."]],
		stump: [
			["Kindling", "Prised off a stump with a thumbnail."],
			["Tree Resin", "Amber beads, tacky in the warmth."],
		],
		rock: [
			["Flint", "It takes a hard edge and a harder spark."],
			["Loose Stone", "Heavier than it is useful."],
		],
		rubble: [["Loose Stone", "Somebody's wall, once."]],
		snow: [["Packed Snow", "It will not last, and it knows it."]],
	},
	forageChance: {
		crops: 0.3,
		forestFloor: 0.22,
		marsh: 0.28,
		tallGrass: 0.12,
		reeds: 0.3,
		bush: 0.3,
		flowers: 0.5,
		deadTree: 0.6,
		stump: 0.5,
		rock: 0.25,
		rubble: 0.2,
		snow: 0.1,
	},
};
