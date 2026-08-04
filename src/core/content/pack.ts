import type { WorldLore } from "../world/spec.js";

/**
 * The flavour of a world, as data.
 *
 * Everything here was a `const` table scattered across three modules: the name
 * syllables in `names.ts`, the outdoor trades in `fallback.ts`, the households and
 * their appearance lines in `residents.ts`. All of it is *taste* rather than
 * mechanism — nothing in this file changes what the engine builds, only what it is
 * called and who is standing in it — which is exactly the part worth making
 * swappable. A timber-levy road and a drowned archipelago want different names,
 * different trades and a different set of people at home.
 *
 * Two rules keep this from becoming a configuration language.
 *
 * It is *cosmetic only*. No table here decides whether a tile is passable, what a
 * container holds, or what a shop stocks — so a world opened with the wrong pack
 * looks different but cannot become unplayable, and a quest cannot start naming an
 * item that no longer generates.
 *
 * It is *owned by the world*. A pack override travels in the save and in the
 * artifact, like the brief, because the alternative is a reloaded world in which
 * everybody you have already met has a different name and the same memory.
 */

/** Mood buckets for place-name heads, chosen by biome. */
export type NameMood = "wet" | "green" | "cold" | "dry" | "high" | "plain";

export interface NameTables {
	readonly given: readonly string[];
	readonly family: readonly string[];
	/** Place-name first halves, per mood. Every mood must have at least one. */
	readonly heads: Readonly<Record<NameMood, readonly string[]>>;
	readonly tails: readonly string[];
	readonly ruinTails: readonly string[];
	readonly fortTails: readonly string[];
	readonly regionTails: readonly string[];
}

export interface Household {
	/** Inclusive range, rolled per building. `[0, 0]` means nobody lives here. */
	readonly count: readonly [number, number];
	readonly roles: readonly string[];
}

/** A trade worth standing outdoors, and the anchor they stand at. */
export interface OutdoorRole {
	readonly role: string;
	readonly placement: string;
}

export interface ContentPack {
	/** Names the pack in logs and in the save, so a mismatch can be reported. */
	readonly id: string;
	readonly names: NameTables;
	/** Keyed by structure kind. `house` is the fallback for any kind not listed. */
	readonly households: Readonly<Record<string, Household>>;
	/** Role → the one telling detail the examine verb prints. */
	readonly appearance: Readonly<Record<string, string>>;
	/** Role → what they will talk about, which the canned dialogue leans on. */
	readonly talksAbout: Readonly<Record<string, string>>;
	/** Structure kind → who stands outside it. */
	readonly outdoorRoles: Readonly<Record<string, OutdoorRole>>;
	/** People with no building of their own, for the square and the well. */
	readonly wanderers: readonly OutdoorRole[];
	/** The premise a world with no model runs on. */
	readonly lore: WorldLore;
	/** Ambient lines for a region nobody has written. */
	readonly ambient: readonly string[];
}

/**
 * A partial pack, as an author writes one.
 *
 * This is what travels in a save rather than the merged result, for two reasons.
 * It is small — a scenario usually overrides two or three tables — and the tests
 * that keep saves tiny are worth keeping. And the baked default is compiled in, so
 * merging at load needs no file to still be on disk.
 */
export interface PackOverride {
	readonly id?: string;
	readonly names?: {
		readonly given?: readonly string[];
		readonly family?: readonly string[];
		readonly heads?: Partial<Record<NameMood, readonly string[]>>;
		readonly tails?: readonly string[];
		readonly ruinTails?: readonly string[];
		readonly fortTails?: readonly string[];
		readonly regionTails?: readonly string[];
	};
	readonly households?: Readonly<Record<string, Household>>;
	readonly appearance?: Readonly<Record<string, string>>;
	readonly talksAbout?: Readonly<Record<string, string>>;
	readonly outdoorRoles?: Readonly<Record<string, OutdoorRole>>;
	readonly wanderers?: readonly OutdoorRole[];
	readonly lore?: WorldLore;
	readonly ambient?: readonly string[];
}

/**
 * Lay an override over a base pack.
 *
 * The two merge rules are different on purpose, and the difference is the whole
 * usability of the format.
 *
 * **Maps merge by key.** An author who wants a cooper to look different writes one
 * line, and every other trade keeps the default. Restating thirty appearance lines
 * to change one is how a format stops being used.
 *
 * **Lists replace.** Supplying `given` means "these are the given names in my
 * world" — appending to the default would leave the very names the author was
 * trying to get rid of, which is the opposite of what writing the list meant.
 */
export function mergePack(base: ContentPack, override?: PackOverride): ContentPack {
	if (!override) return base;
	return {
		id: override.id ?? base.id,
		names: {
			given: override.names?.given ?? base.names.given,
			family: override.names?.family ?? base.names.family,
			heads: { ...base.names.heads, ...(override.names?.heads ?? {}) },
			tails: override.names?.tails ?? base.names.tails,
			ruinTails: override.names?.ruinTails ?? base.names.ruinTails,
			fortTails: override.names?.fortTails ?? base.names.fortTails,
			regionTails: override.names?.regionTails ?? base.names.regionTails,
		},
		households: { ...base.households, ...(override.households ?? {}) },
		appearance: { ...base.appearance, ...(override.appearance ?? {}) },
		talksAbout: { ...base.talksAbout, ...(override.talksAbout ?? {}) },
		outdoorRoles: { ...base.outdoorRoles, ...(override.outdoorRoles ?? {}) },
		wanderers: override.wanderers ?? base.wanderers,
		lore: override.lore ?? base.lore,
		ambient: override.ambient ?? base.ambient,
	};
}

/** Whether an override actually asks for anything. */
export function isOverrideEmpty(override?: PackOverride): boolean {
	if (!override) return true;
	const { id: _id, ...tables } = override;
	return Object.values(tables).every(
		(value) =>
			value === undefined ||
			(Array.isArray(value) && value.length === 0) ||
			(typeof value === "object" && Object.keys(value as object).length === 0),
	);
}
