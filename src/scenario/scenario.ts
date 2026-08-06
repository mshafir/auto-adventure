import type { PackOverride } from "../core/content/pack.js";
import type { ScenarioBrief } from "../core/world/brief.js";
import type { ScenarioArtifact } from "./artifact.js";

/**
 * How a world's content gets authored.
 *
 * The three differ only in *when* the model runs, which is why they share one
 * engine, one save format and one director rather than being three modes:
 *
 * - `procedural` — never. Deterministic fallbacks name every place and build
 *   real dialogue trees from what people know. A supported way to play.
 * - `live` — during play, in the background, never on the movement path.
 * - `prebuilt` — ahead of time, into an artifact. No model call during play at
 *   all, and therefore no late spec and no settlement rebuilding itself around a
 *   standing player.
 */
export type Flavour = "procedural" | "live" | "prebuilt";

export function isFlavour(value: string): value is Flavour {
	return value === "procedural" || value === "live" || value === "prebuilt";
}

/**
 * Whether a world is allowed to talk to a model while it is being played.
 *
 * Two inputs rather than one, because `prebuilt` used to mean both "authored ahead of
 * time" and "never calls a model", and those have come apart. A generated scenario is
 * prebuilt — its towns, people and story are all written down before the first frame —
 * and may still be asked to improvise a conversation with somebody the author never
 * wrote a tree for. The artifact decides, so the answer survives a save and a reload.
 */
export function usesLiveModel(flavour: Flavour, liveInGame?: boolean): boolean {
	return flavour === "live" || liveInGame === true;
}

/**
 * What to start, decided before the engine exists.
 *
 * Produced either from the environment (the bare `npm start` path) or from the
 * launcher. Deliberately flat rather than a union: the launcher needs to build one
 * up field by field as the player moves through its screens, and every field is
 * meaningful for more than one flavour.
 */
export interface LaunchChoice {
	/** Save slot. Also the world's id and display name. */
	readonly worldId: string;
	/** Used only when the slot does not exist yet; a save carries its own. */
	readonly seed: number;
	readonly flavour: Flavour;
	readonly brief?: ScenarioBrief;
	/** A pack override to offer a new world. A world with one of its own keeps it. */
	readonly content?: PackOverride;
	/**
	 * The authored world, for `prebuilt`.
	 *
	 * Supplies the seed, the spawn, the bounds and every spec, so the fields above
	 * that would otherwise decide those are ignored — the artifact's seed in
	 * particular, since its specs mean nothing paired with any other.
	 */
	readonly scenario?: ScenarioArtifact;
	/**
	 * Refuse to create the slot, failing instead if it is absent.
	 *
	 * The launcher's "resume" entries set this: a save that vanished between the
	 * list being drawn and the player choosing it should report that, not silently
	 * generate a different world under the same name.
	 */
	readonly mustExist?: boolean;
	/**
	 * Let a model improvise during play, even for a world that was authored in advance.
	 *
	 * Persisted onto `world` so a resumed save keeps the answer: a scenario generated with
	 * live dialogue asked for should not fall silent because it was reopened, and one
	 * generated without it should not start spending money because a key turned up.
	 */
	readonly liveInGame?: boolean;
}

/**
 * What the player asked a new scenario to be, before there is one.
 *
 * The launcher's config page fills this in and `pickLaunch` spends it. Separate from
 * `LaunchChoice` because it describes a world that does not exist yet — there is no seed
 * to resume, no slot to write to and no artifact to read, and every field here stops
 * mattering the moment generation finishes and a real `LaunchChoice` exists.
 */
export interface GenerateRequest {
	readonly brief: ScenarioBrief;
	/** A directory under `.packs/tiles/`. Absent means the built-in look. */
	readonly tiles?: string;
	/** A pack under `.packs/`. Absent means the built-in tables. */
	readonly pack?: string;
	/** Whether the hour advances, the sky changes and people keep to a routine. */
	readonly dayAndNight: boolean;
	/** Whether a model runs during play, for conversations nobody wrote a tree for. */
	readonly liveInGame: boolean;
}
