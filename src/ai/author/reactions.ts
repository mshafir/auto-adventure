import { MODELS } from "../../config.js";
import type { ScenarioArc, ScenarioBeat } from "../../core/rules/arc.js";
import type { DomainEffect } from "../../core/rules/effects.js";
import type { AuthoredBarrier } from "../../core/rules/lock.js";
import type { Trigger } from "../../core/rules/trigger.js";
import type { WorldLore } from "../../core/world/spec.js";
import { structured } from "../client.js";
import { REACTIONS_SYSTEM, reactionsPrompt } from "./prompts.js";
import { type ReactionsResponse, ReactionsSchema } from "./schemas.js";

/**
 * What the world does about the story.
 *
 * Measured against the two hand-written scenarios, every generated world scored zero for
 * triggers and zero for barriers — not few, none — because no authoring pass had ever
 * been asked for one. Both have been in the artifact format since before the generator
 * existed. The effect on a playthrough is precise and not subtle: nothing the player does
 * changes anything they can see outside the conversation they did it in, and no door in
 * the world is ever shut. A map with a conversation on it.
 *
 * Runs after the arc and reads only what the arc produced, which is the property that
 * makes it safe. Every condition here is a flag some beat definitely sets, chosen by
 * index into a list, so an unsatisfiable trigger is not something this pass can express —
 * the same rule that stops a beat being anchored to a person who does not exist.
 */

export interface CastleOnStage {
	readonly siteId: number;
	readonly name: string;
	readonly description: string;
}

export interface ReactionsInput {
	readonly lore: WorldLore;
	readonly arc: ScenarioArc;
	/** Castles in this world, if any. The only gates that can be barred. */
	readonly castles: readonly CastleOnStage[];
	readonly signal?: AbortSignal;
}

export interface Reactions {
	readonly triggers: readonly Trigger[];
	readonly barriers: readonly AuthoredBarrier[];
}

const EMPTY: Reactions = { triggers: [], barriers: [] };

/** As long as the rest of the offline passes get. See `AUTHOR_TIMEOUT_MS`. */
const REACTIONS_TIMEOUT_MS = 180_000;

export async function authorReactions(
	input: ReactionsInput,
): Promise<{ reactions: Reactions; called: boolean }> {
	// Nothing to react to. A world with no story has no flags worth watching, and a
	// trigger conditioned on nothing would fire on the first step.
	if (input.arc.beats.length === 0) return { reactions: EMPTY, called: false };

	const beats = [...input.arc.beats].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
	const response = await structured({
		kind: "site",
		model: MODELS.director,
		schema: ReactionsSchema,
		system: REACTIONS_SYSTEM,
		prompt: reactionsPrompt({
			lore: input.lore,
			beats: beats.map((beat) => ({
				id: beat.id,
				summary: beat.journal ?? beat.quest?.description ?? beat.quest?.name ?? beat.id,
			})),
			castles: input.castles.map((castle) => ({
				name: castle.name,
				description: castle.description,
			})),
		}),
		temperature: 0.9,
		// The same generous ceiling every other authoring pass runs on: nothing is
		// waiting on this, and the client's twenty-second default is tuned for the live
		// director, where something is.
		timeoutMs: REACTIONS_TIMEOUT_MS,
		...(input.signal ? { signal: input.signal } : {}),
	});
	if (!response) return { reactions: EMPTY, called: true };
	return { reactions: lowerReactions(response, beats, input.castles), called: true };
}

/**
 * Turn the model's indices into real flags and real sites.
 *
 * Same shape as `lowerArc`, and the same rule: an index outside the list it was shown is
 * dropped rather than guessed at. That is what makes it impossible for this pass to
 * produce a trigger that never fires or a gate that stands nowhere — the two faults which,
 * unlike a thin description, are invisible until somebody plays the world to the end.
 */
export function lowerReactions(
	response: ReactionsResponse,
	beats: readonly ScenarioBeat[],
	castles: readonly CastleOnStage[],
): Reactions {
	const triggers: Trigger[] = [];
	const seen = new Set<string>();

	for (const raw of response.triggers) {
		const beat = beats[raw.afterBeat];
		if (!beat || seen.has(raw.id)) continue;
		const effects: DomainEffect[] = [];
		if (raw.journal) {
			effects.push({
				t: "RecordJournal",
				entry: { kind: "event", text: raw.journal, source: `trigger:${raw.id}` },
			});
		}
		if (raw.cardTitle && raw.cardBody) {
			effects.push({
				t: "ShowCard",
				card: {
					id: `trigger:${raw.id}`,
					title: raw.cardTitle,
					sections: [{ heading: "What has changed", body: raw.cardBody }],
				},
			});
		}
		// A trigger with no effects is a flag set for nobody's benefit, and it would show
		// up in `flagsWritten` as a writer — making a condition on it look satisfiable
		// while nothing observable ever happens.
		if (effects.length === 0) continue;
		seen.add(raw.id);
		triggers.push({ id: raw.id, when: { flag: beat.setsFlag }, effects });
	}

	const barriers: AuthoredBarrier[] = [];
	for (const raw of response.barriers) {
		const castle = castles[raw.castle];
		const opener = beats[raw.opensAfterBeat];
		if (!castle || !opener || seen.has(raw.id)) continue;
		// The one way a gate can strand a story: the beat that opens it happens behind it.
		// Castles are not story sites today, so this cannot currently arise — which is
		// exactly why it is worth refusing here rather than discovering later.
		if (opener.siteId === castle.siteId) continue;
		seen.add(raw.id);
		barriers.push({
			id: raw.id,
			tiles: { siteId: castle.siteId, at: "gate" },
			opensWhen: { flag: opener.setsFlag },
			lockedText: raw.lockedText,
			...(raw.opensText ? { opensText: raw.opensText } : {}),
		});
	}

	return { triggers, barriers };
}
