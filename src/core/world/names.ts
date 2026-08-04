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

const HEADS: Readonly<Record<string, readonly string[]>> = {
	wet: ["mire", "fen", "marl", "sedge", "bog", "reed", "silt", "drift"],
	green: ["thorn", "brack", "elder", "haw", "brier", "wold", "bram", "willow"],
	cold: ["frost", "cold", "rime", "hoar", "snow", "bleak", "grim", "north"],
	dry: ["ash", "dust", "scald", "kiln", "ember", "sun", "barren", "salt"],
	high: ["crag", "stone", "scar", "tor", "iron", "grey", "cliff", "pike"],
	plain: ["hart", "oak", "wheat", "gold", "long", "fair", "bell", "mill"],
};

const TAILS: readonly string[] = [
	"ford",
	"hollow",
	"reach",
	"barrow",
	"gate",
	"mere",
	"stead",
	"combe",
	"march",
	"row",
	"wick",
	"holt",
	"crest",
	"bridge",
];

const RUIN_TAILS: readonly string[] = ["barrow", "cairn", "wrack", "ruin", "hush", "remnant"];
const FORT_TAILS: readonly string[] = ["keep", "watch", "hold", "bastion", "gate", "ward"];

const GIVEN: readonly string[] = [
	"Alder",
	"Bryn",
	"Cass",
	"Doryn",
	"Elke",
	"Fenn",
	"Garrow",
	"Hale",
	"Isa",
	"Joral",
	"Kest",
	"Lune",
	"Marrow",
	"Nessa",
	"Orrin",
	"Pell",
	"Quill",
	"Rhoswen",
	"Sable",
	"Tam",
	"Ulric",
	"Vess",
	"Wren",
	"Yarrow",
];

const FAMILY: readonly string[] = [
	"Ashdown",
	"Barrowmoor",
	"Coldwick",
	"Dunmere",
	"Emberly",
	"Fallowend",
	"Grimsby",
	"Harrowgate",
	"Larkspur",
	"Marchbank",
	"Netherfield",
	"Oakhame",
	"Quillon",
	"Ridderhelm",
	"Stonecarve",
	"Thistlewood",
];

function moodFor(biome: BiomeId): keyof typeof HEADS {
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
export function placeName(seed: number, siteId: number, kind: SiteKind, biome: BiomeId): string {
	const rng = rngFor(seed, "name:place", siteId, 0);
	const head = pick(rng, HEADS[moodFor(biome)] ?? HEADS.plain ?? []);
	const tails = kind === "ruins" ? RUIN_TAILS : kind === "fort" ? FORT_TAILS : TAILS;
	const tail = pick(rng, tails);

	// A two-word name reads as grander than a compound, so the larger the place
	// the more likely it is to get one.
	const grand = kind === "town" ? 0.45 : kind === "village" || kind === "fort" ? 0.25 : 0.1;
	if (rng.chance(grand)) return `${capitalize(head)} ${capitalize(tail)}`;
	return capitalize(head + tail);
}

/** A region name. Regions are large, so they read as "the ..." in prose. */
export function regionName(seed: number, regionId: number, biome: BiomeId): string {
	const rng = rngFor(seed, "name:region", regionId, 0);
	const head = pick(rng, HEADS[moodFor(biome)] ?? HEADS.plain ?? []);
	const tail = pick(rng, ["moor", "wold", "reach", "vale", "expanse", "marches", "downs", "waste"]);
	return `${capitalize(head)} ${capitalize(tail)}`;
}

/** A person's name, stable for a given NPC id. */
export function personName(seed: number, siteId: number, slot: number): string {
	const rng = rngFor(seed, "name:person", siteId, slot);
	return `${pick(rng, GIVEN)} ${pick(rng, FAMILY)}`;
}
