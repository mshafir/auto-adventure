import { DEFAULT_PACK } from "../content/default.js";
import type { ContentPack, NameMood } from "../content/pack.js";
import { type Rng, rngFor } from "../rand/rng.js";
import type { BiomeId } from "./biome.js";
import type { SiteKind } from "./macro.js";

/**
 * Deterministic naming, used when no director has spoken.
 *
 * Every LLM-authored field needs a fallback that is good enough to ship, not
 * merely good enough to not crash: `--no-ai` is a supported way to play, and a
 * world of places called "Village (3,-2)" is not a world. Syllable assembly
 * biased by biome gets surprisingly far — "Mirefen", "Coldhollow", "Ashreach" —
 * and costs nothing.
 */

function moodFor(biome: BiomeId): NameMood {
	switch (biome) {
		case "marsh":
			return "wet";
		case "forest":
		case "rainforest":
			return "green";
		case "taiga":
		case "alpine":
		case "glacier":
			return "cold";
		case "desert":
		case "badlands":
		case "savanna":
			return "dry";
		case "highland":
		case "moor":
			return "high";
		default:
			return "plain";
	}
}

function pick<T>(rng: Rng, table: readonly T[]): T {
	return table[rng.int(table.length)] as T;
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A place name for a site, biased by the biome it sits in. */
export function placeName(
	seed: number,
	siteId: number,
	kind: SiteKind,
	biome: BiomeId,
	pack: ContentPack = DEFAULT_PACK,
): string {
	const rng = rngFor(seed, "name:place", siteId, 0);
	const names = pack.names;
	const head = pick(rng, names.heads[moodFor(biome)] ?? names.heads.plain);
	const tails =
		kind === "ruins" ? names.ruinTails : kind === "fort" ? names.fortTails : names.tails;
	const tail = pick(rng, tails);

	// A two-word name reads as grander than a compound, so the larger the place
	// the more likely it is to get one.
	const grand = kind === "town" ? 0.45 : kind === "village" || kind === "fort" ? 0.25 : 0.1;
	if (rng.chance(grand)) return `${capitalize(head)} ${capitalize(tail)}`;
	return capitalize(head + tail);
}

/** A region name. Regions are large, so they read as "the ..." in prose. */
export function regionName(
	seed: number,
	regionId: number,
	biome: BiomeId,
	pack: ContentPack = DEFAULT_PACK,
): string {
	const rng = rngFor(seed, "name:region", regionId, 0);
	const head = pick(rng, pack.names.heads[moodFor(biome)] ?? pack.names.heads.plain);
	const tail = pick(rng, pack.names.regionTails);
	return `${capitalize(head)} ${capitalize(tail)}`;
}

/** A person's name, stable for a given NPC id. */
export function personName(
	seed: number,
	siteId: number,
	slot: number,
	pack: ContentPack = DEFAULT_PACK,
): string {
	const rng = rngFor(seed, "name:person", siteId, slot);
	return `${pick(rng, pack.names.given)} ${pick(rng, pack.names.family)}`;
}
