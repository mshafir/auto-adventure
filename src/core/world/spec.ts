import type { AnchorKind } from "../gen/features/patch.js";
import type { SettlementSpec } from "../gen/features/settlement.js";
import type { Condition } from "../rules/condition.js";

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
	/**
	 * What has to be true for this person to be here at all.
	 *
	 * Absent means always, which is everybody in a procedural or live world — this
	 * only exists for authored casts. Someone gated out is not standing somewhere
	 * else: they are not in the world, cannot be walked into and cannot be talked to,
	 * which is the difference between a courier who has not arrived yet and one who
	 * has and is hiding.
	 */
	readonly requires?: Condition;
	/**
	 * Keep them at their own anchor at every hour, rather than sending them to the
	 * square in the evening and home at night.
	 *
	 * For the two or three people a story actually sends the player to find. Schedules
	 * are the cheapest thing in the game that makes a village feel inhabited, and they
	 * are exactly wrong for the lord an errand names: the player arrives at dusk, he is
	 * elsewhere, and nothing on screen says the game has hours. The alternative was
	 * turning the clock off for the whole world, which costs every other village its
	 * evening in order to pin one man.
	 */
	readonly stays?: boolean;
	/**
	 * Stand inside {@link structureName} rather than outdoors.
	 *
	 * Every authored person stood in the street, because that is where the anchors are
	 * — so a locked door led to an empty box, a cave with three levels under it was
	 * scenery, and a scene could only ever happen in the open. There was already an
	 * indoor cast (`InteriorPeople`) with ids, memory, dialogue and rendering; what was
	 * missing was any way for a *scenario* to put somebody into it.
	 *
	 * Their id stays `npc:<siteId>:<slot>`, which is the whole trick: beats, dialogue
	 * trees and `talk` objectives key exactly as they do for anyone outdoors, and a beat
	 * that happens in a room needs no new beat machinery at all.
	 */
	readonly indoors?: boolean;
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
