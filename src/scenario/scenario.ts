import type { ScenarioBrief } from "../core/world/brief.js";

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

/** Whether this flavour is allowed to talk to a model while the game is running. */
export function usesLiveModel(flavour: Flavour): boolean {
	return flavour === "live";
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
	/**
	 * Refuse to create the slot, failing instead if it is absent.
	 *
	 * The launcher's "resume" entries set this: a save that vanished between the
	 * list being drawn and the player choosing it should report that, not silently
	 * generate a different world under the same name.
	 */
	readonly mustExist?: boolean;
}
