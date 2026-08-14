import type { DialogueTree } from "../ai/dialogue/tree.js";
import type { PackOverride } from "../core/content/pack.js";
import type { ScenarioArc } from "../core/rules/arc.js";
import type { TimeOptions } from "../core/rules/clock.js";
import type { AuthoredBarrier } from "../core/rules/lock.js";
import type { Placement } from "../core/rules/placement.js";
import type { Scene } from "../core/rules/scene.js";
import type { Sign } from "../core/rules/signage.js";
import type { Trigger } from "../core/rules/trigger.js";
import type { WorldBounds } from "../core/world/bounds.js";
import type { ScenarioBrief } from "../core/world/brief.js";
import { type WorldRecipe, type WorldSeed, worldSeed } from "../core/world/recipe.js";
import type { RegionSpec, SiteSpec, WorldLore } from "../core/world/spec.js";
import type { Phase } from "./phase.js";
import type { TerraformEdit } from "./terraform.js";

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

/**
 * Version two: a scenario is a directory rather than a file.
 *
 * There is deliberately no migration from version one. Every scenario written by the
 * pipeline that produced them has been deleted along with it, so a migration would be code
 * with nothing to convert — and the shape it converted *from* described a world whose story
 * and whose contents were assembled by different passes that argued with each other.
 */
export const ARTIFACT_VERSION = 2;

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
	 * (see {@link readScenarioAt}). So the reference is an authoring convenience, not
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
	 * The tile pack this scenario is meant to be seen in, by name.
	 *
	 * A reference, like `pack` above, and for the same reason — except that this one
	 * genuinely is a runtime dependency: the art lives in `.packs/tiles/<name>/` and is
	 * far too large to inline. A missing pack falls back to the built-in look, so the
	 * scenario still plays; it just looks like every other one.
	 */
	readonly tiles?: string;

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
	/**
	 * How the world is generated, beyond the seed.
	 *
	 * The other half of "authoritative" above. Site ids depend on the seed alone, but
	 * where those sites *are* — and what biome, how thick the trees, whether there is a
	 * town in that cell at all — depends on this too, so an artifact carrying specs and
	 * placements without the recipe they were written against is as broken as one
	 * carrying the wrong seed. Absent means the built-in defaults.
	 */
	readonly recipe?: WorldRecipe;
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
	 * What this world reacts to.
	 *
	 * Optional, and a scenario with none is the shape every artifact had before this
	 * existed. Persisted into the save alongside the arc, because a world that stops
	 * reacting to the player fails silently — see `GameState.triggers`.
	 */
	readonly triggers?: readonly Trigger[];
	/** Gates across the world, and what opens them. */
	readonly barriers?: readonly AuthoredBarrier[];
	/** Particular things in particular places. */
	readonly placements?: readonly Placement[];
	/**
	 * Boards on posts, telling the player which way the next place is.
	 *
	 * The one authored thing whose *content* is derived: an arm names a site and the
	 * bearing is computed from where that site really is, so a signpost cannot drift out
	 * of step with the map the way a hand-copied coordinate can. See `core/rules/signage.ts`.
	 */
	readonly signs?: readonly Sign[];
	/**
	 * Authored changes to the ground, laid over what the generator made.
	 *
	 * The base chapter's, only. A later phase's edits live on the phase, so that entering it
	 * can invalidate exactly the chunks whose ground has changed.
	 */
	readonly terraform?: readonly TerraformEdit[];
	/**
	 * Cutscenes, by id.
	 *
	 * Raised by a trigger's `PlayScene`, which is the only thing that starts one. Persisted
	 * into the save with the arc and the triggers, because a trigger whose scene has gone
	 * missing fails silently.
	 */
	readonly scenes?: Readonly<Record<string, Scene>>;
	/**
	 * Later chapters, in the order they are laid over the base.
	 *
	 * `world/` is the first chapter and has no entry here — every phase in this list carries
	 * a `when`. The asymmetry earns something: a world at its opening composes to the base
	 * content object itself, so the engine's identity check finds nothing to rebuild rather
	 * than allocating a fresh copy after every command.
	 */
	readonly phases?: readonly Phase[];
	/**
	 * Whether this world has a clock, and what it drives.
	 *
	 * Absent means the ordinary day/night cycle, which is every scenario written so
	 * far. A single-afternoon mystery or a dungeon crawl says `{ enabled: false }` and
	 * stops having a time of day, lamplight and schedules along with it.
	 */
	readonly time?: TimeOptions;
	/**
	 * Whether a model may improvise during play, for anyone with no written tree.
	 *
	 * Absent means no, which is what "prebuilt" meant when it was the only kind of
	 * authored world: nothing arrives late, nothing costs anything, and the same
	 * playthrough happens twice. A scenario generated with this asked for is still
	 * prebuilt in every other sense — the map, the towns, the people and the plot are all
	 * decided before the first frame — and merely allows a conversation nobody wrote to
	 * happen rather than falling back to the canned menu.
	 *
	 * On the artifact rather than only on the launch, so the answer survives a reload: a
	 * world generated to improvise should not fall silent because it was reopened, and one
	 * generated not to should not start spending money because a key turned up.
	 */
	readonly liveInGame?: boolean;
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

/**
 * The world this artifact was authored against.
 *
 * One call rather than `worldSeed(a.seed, a.recipe)` spelled out at each of the
 * dozen places that need it, because forgetting the second argument is a silent
 * bug: the world still generates, just not the one the content describes.
 */
export function artifactWorld(artifact: ScenarioArtifact): WorldSeed {
	return worldSeed(artifact.seed, artifact.recipe);
}

/** Every site id the artifact claims to have authored. */
export function artifactSiteIds(artifact: ScenarioArtifact): number[] {
	return Object.keys(artifact.sites).map(Number);
}
