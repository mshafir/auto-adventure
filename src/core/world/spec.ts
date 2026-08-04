import type { AnchorKind } from "../gen/features/patch.js";
import type { SettlementSpec } from "../gen/features/settlement.js";

/**
 * Authored content: everything the engine does *not* decide.
 *
 * The engine decides where a town is, how big it is, how many buildings fit and
 * where their doors face. These types carry the other half — what the place is
 * called, who lives there and why the player should care. Nothing here can move
 * a wall; the settlement layout is a function of the site and the structure
 * roster, and a roster is all the director gets to supply.
 *
 * They live in `core` rather than `ai` because the deterministic fallback
 * produces the same shapes, and the game must be fully playable with no
 * director at all.
 */

export interface WorldLore {
	readonly title: string;
	readonly premise: string;
	readonly era: string;
	readonly tone: string;
	readonly factions: readonly string[];
	readonly deities: readonly string[];
}

export interface RegionSpec {
	/** `String(regionId)` — regions are hashed from position, not numbered. */
	readonly id: string;
	readonly name: string;
	readonly blurb: string;
	readonly tone: string;
	readonly culture: string;
	readonly factionName?: string;
	readonly lore: readonly string[];
	/** Flavour lines shown as the player crosses the region. */
	readonly ambient: readonly string[];
}

export interface NpcSpec {
	/** 0-based index within the site. Part of the NPC's stable id. */
	readonly slot: number;
	readonly name: string;
	readonly role: string;
	/** Single ASCII letter, drawn on the map. */
	readonly glyph: string;
	readonly appearance: string;
	readonly persona: string;
	/** -100..100. Where the relationship starts. */
	readonly disposition: number;
	/** Which kind of anchor this NPC stands at. */
	readonly placement: AnchorKind;
	/** Name of the structure they belong to, matched loosely against buildings. */
	readonly structureName?: string;
	readonly knows: readonly string[];
}

export interface SiteSpec {
	readonly siteId: number;
	readonly name: string;
	readonly shortName: string;
	readonly description: string;
	readonly settlement: SettlementSpec;
	readonly npcs: readonly NpcSpec[];
	/** Story hooks the dialogue layer can hand to an NPC as something to raise. */
	readonly hooks: readonly string[];
}

/**
 * Where a spec came from.
 *
 * Committed once and never flipped: a chunk the player has already walked
 * through must not rearrange itself because a slow director call finally
 * landed. `fallback` here means "permanently fallback", not "not yet asked".
 */
export type SpecSource = "llm" | "fallback";

export function npcId(siteId: number, slot: number): string {
	return `npc:${siteId >>> 0}:${slot}`;
}
