import type { DialogueTree } from "../ai/dialogue/tree.js";
import type { PackOverride } from "../core/content/pack.js";
import type { ScenarioArc } from "../core/rules/arc.js";
import type { WorldBounds } from "../core/world/bounds.js";
import type { ScenarioBrief } from "../core/world/brief.js";
import type { RegionSpec, SiteSpec, WorldLore } from "../core/world/spec.js";

/**
 * A whole world, authored ahead of time.
 *
 * Everything expensive has already happened: the premise, the regions, the towns
 * and the people in them are decided and written down, so a prebuilt scenario
 * makes no model call while the game is running. That is not merely a saving —
 * it removes a whole class of behaviour. In `live`, a spec that arrives after the
 * player has walked into a town is dropped, because a settlement rearranging
 * itself around a standing player is worse than one with a procedural name. Here
 * every spec is present before the first frame, so there is no late spec, no
 * rebuild, and no commitment race.
 */

export const ARTIFACT_VERSION = 1;

export interface ArtifactProvenance {
	/** Which model produced which call type. */
	readonly models: Readonly<Record<string, string>>;
	readonly calls: number;
	/** ISO timestamp. Informational only — nothing branches on it. */
	readonly at: string;
}

export interface ScenarioArtifact {
	readonly artifactVersion: typeof ARTIFACT_VERSION;
	/** Stable id. Also the filename stem and what a save records. */
	readonly id: string;
	readonly title: string;
	readonly blurb: string;
	readonly brief: ScenarioBrief;
	/**
	 * A pack in `.packs/`, by name.
	 *
	 * A reference rather than a copy so the pack and the scenario that uses it can be
	 * read as one thing and changed in one place — the first scenario written carried a
	 * verbatim duplicate of `thornwick.json`, every given name and family and trade,
	 * which is a second copy to keep in step by hand.
	 *
	 * Resolved when the file is read, and the *resolved* tables are what reach the save
	 * (see {@link readScenarioFile}). So the reference is an authoring convenience, not
	 * a runtime dependency: a pack deleted next month renames nobody who has already
	 * met them.
	 */
	readonly pack?: string;
	/**
	 * Flavour tables written into the scenario itself, laid over {@link pack}.
	 *
	 * Still worth having alongside the reference: a scenario that wants one household
	 * changed should not have to fork a whole pack to say so. A scenario with no `pack`
	 * and only this is the original shape and still loads.
	 */
	readonly content?: PackOverride;

	/**
	 * The seed this content was authored against. Authoritative.
	 *
	 * Site ids are `hash32(seed, 0x51e0, mx, my)`, so the specs below only mean
	 * anything paired with this exact seed: against a different one they would key
	 * to sites that do not exist, giving a world of correctly-named towns standing
	 * nowhere. `WORLD_SEED` is therefore ignored when a scenario is loaded, the
	 * same way a save's own seed already wins over the configured one.
	 */
	readonly seed: number;
	readonly spawn: { readonly x: number; readonly y: number };
	readonly bounds: WorldBounds;

	readonly lore: WorldLore;
	readonly regions: Readonly<Record<string, RegionSpec>>;
	readonly sites: Readonly<Record<string, SiteSpec>>;
	/**
	 * The story. Optional so a scenario can be a *place* with no plot in it, which
	 * is a legitimate thing to author and the shape the first artifacts had.
	 */
	readonly arc?: ScenarioArc;
	/**
	 * Authored conversations, keyed by `npcId(siteId, slot)`.
	 *
	 * Not persisted into the save, unlike the arc. These are static content that
	 * never changes, so re-reading them costs nothing — and if the file is gone,
	 * `cannedTurn` is a designed floor rather than a silent failure.
	 */
	readonly trees?: Readonly<Record<string, DialogueTree>>;

	readonly authoredWith: ArtifactProvenance;
}

/** Every site id the artifact claims to have authored. */
export function artifactSiteIds(artifact: ScenarioArtifact): number[] {
	return Object.keys(artifact.sites).map(Number);
}
