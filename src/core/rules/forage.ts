import { DEFAULT_GOODS, type GoodsTables } from "../content/goods.js";
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

export function isForageable(terrain: TerrainId, goods: GoodsTables = DEFAULT_GOODS): boolean {
	return goods.yields[terrainDef(terrain).key] !== undefined;
}

/**
 * Everything this kind of ground can ever give, for grounding an errand.
 *
 * The engine unions this across the ground actually present near a settlement, so
 * an NPC standing beside a barley field may ask for moss and one in a fishing
 * village may not.
 */
export function forageYields(
	terrain: TerrainId,
	goods: GoodsTables = DEFAULT_GOODS,
): readonly string[] {
	return (goods.yields[terrainDef(terrain).key] ?? []).map(([name]) => name);
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
	goods: GoodsTables = DEFAULT_GOODS,
): readonly LootItem[] {
	const key = terrainDef(terrain).key;
	const table = goods.yields[key];
	if (!table || table.length === 0) return [];

	const rng = rngFor(seed, "forage", x, y);
	if (!rng.chance(goods.forageChance[key] ?? 0.2)) return [];

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
