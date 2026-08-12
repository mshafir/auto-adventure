import { MODELS } from "../../config.js";
import type { Duration } from "../../core/world/brief.js";
import { logger } from "../../utils/log.js";
import { structured } from "../client.js";
import { PITCH_SYSTEM, pitchPrompt } from "./prompts.js";
import { PitchesSchema } from "./schemas.js";

/**
 * Four worlds to choose between, before one is paid for.
 *
 * With nothing typed, the lore pass invents a premise as a field of the world's lore — so
 * the first thing a player learns about the world they just bought four minutes of is that
 * they did not choose it. This turns that into a decision, for one call on the cheap side
 * of a bill that is about to be sixty.
 *
 * The *prose* model, not the fast one, and that is the whole reason this is its own call
 * rather than a cheap aside: the player reads every word of these and picks between them on
 * the strength of the writing. It is the same tier the lore pass uses, for the same reason.
 *
 * Deliberately knows nothing about surveys, worlds or seeds. It cannot: the premise decides
 * the scenario's id and the id decides the seed, so this runs before any of that exists.
 */

export interface Pitch {
	readonly title: string;
	readonly tone: string;
	readonly premise: string;
}

export interface PitchRequest {
	readonly duration: Duration;
	/** Whatever the player has typed so far, if anything. Followed rather than embellished. */
	readonly hint?: string;
	readonly count?: number;
	/** Titles already offered and passed over, so "more" produces more rather than again. */
	readonly avoid?: readonly string[];
	readonly signal?: AbortSignal;
}

/** Four fits a short terminal without scrolling, and is enough to see a range in. */
export const DEFAULT_PITCH_COUNT = 4;

/**
 * Long enough for a reasoning model to answer, short enough that a player who pressed a key
 * on a launcher screen is not left looking at a spinner wondering if it hung. Shorter than
 * the authoring passes get, because this one has somebody watching it in real time.
 */
const PITCH_TIMEOUT_MS = 45_000;

export async function suggestPitches(input: PitchRequest): Promise<readonly Pitch[]> {
	const count = input.count ?? DEFAULT_PITCH_COUNT;
	const response = await structured({
		kind: "pitch",
		model: MODELS.bible,
		schema: PitchesSchema,
		system: PITCH_SYSTEM,
		prompt: pitchPrompt({
			duration: input.duration,
			count,
			...(input.hint ? { hint: input.hint } : {}),
			...(input.avoid && input.avoid.length > 0 ? { avoid: input.avoid } : {}),
		}),
		// Higher than the authoring passes run at. These are meant to differ from one another
		// and from the last four, which is the one job a low temperature is bad at.
		temperature: 1,
		timeoutMs: PITCH_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});

	if (!response) {
		// No throw and no fallback of our own. The page offers the player the text field they
		// would have used anyway, which is a better answer than four worlds we invented
		// procedurally and presented as if a model had written them.
		logger.warn("no premises came back; the player types their own");
		return [];
	}
	return response.pitches.slice(0, count);
}
