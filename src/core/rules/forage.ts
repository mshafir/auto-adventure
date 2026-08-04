import { rngFor } from "../rand/rng.js";
import { type TerrainId, terrainDef } from "../tiles/terrain.js";
import type { LootItem } from "./loot.js";

/**
 * Gathering from the land.
 *
 * The world was full of crops, bushes, reeds, flowers and forest floor, and none
 * of it could be touched: searching only ever worked on a container inside a
 * building. So a perfectly sensible errand — fetch moss from the crops near the
 * forest — named things the player could see and walk up to and had no way to
 * pick, and the objective was refused for naming an item that existed nowhere.
 *
 * Yields are a pure function of `(seed, position)`, like everything else about a
 * tile, so a patch holds the same thing however often its chunk is evicted. Once
 * gathered a tile stays gathered: the world is infinite and there is always more
 * moss, so regrowth would be bookkeeping for its own sake.
 */

/** What each kind of ground gives up, keyed by terrain. */
const YIELDS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
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
};

/**
 * How willing each ground is to give anything up.
 *
 * Lower than a container's odds, and deliberately so: there is a great deal of
 * grass in the world and a meadow that yielded on every tile would be a shop.
 * Crops and forest floor are the generous ones because they are what an errand is
 * most likely to name.
 */
const CHANCE: Readonly<Record<string, number>> = {
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
};

export function isForageable(terrain: TerrainId): boolean {
	return YIELDS[terrainDef(terrain).key] !== undefined;
}

/**
 * Everything this kind of ground can ever give, for grounding an errand.
 *
 * The engine unions this across the ground actually present near a settlement, so
 * an NPC standing beside a barley field may ask for moss and one in a fishing
 * village may not.
 */
export function forageYields(terrain: TerrainId): readonly string[] {
	return (YIELDS[terrainDef(terrain).key] ?? []).map(([name]) => name);
}

/** A stable identity for one gathered tile. */
export function forageKey(x: number, y: number): string {
	return `gathered:${x},${y}`;
}

export function forageAt(
	seed: number,
	x: number,
	y: number,
	terrain: TerrainId,
): readonly LootItem[] {
	const key = terrainDef(terrain).key;
	const table = YIELDS[key];
	if (!table || table.length === 0) return [];

	const rng = rngFor(seed, "forage", x, y);
	if (!rng.chance(CHANCE[key] ?? 0.2)) return [];

	// Weighted to the front, so the first entry is the ordinary find and the last
	// is the lucky one.
	const roll = rng.float();
	const entry = table[Math.min(table.length - 1, Math.floor(roll * roll * table.length))];
	if (!entry) return [];
	return [{ name: entry[0], description: entry[1], quantity: 1 }];
}

/** How the ground reads once there is nothing left worth taking. */
export function pickedOverMessage(terrain: TerrainId): string {
	return `Nothing more worth taking from the ${terrainDef(terrain).name}.`;
}
