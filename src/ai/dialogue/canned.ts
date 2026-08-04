import type { NpcRecord } from "../../core/rules/npc.js";
import type { NpcSpec, SiteSpec } from "../../core/world/spec.js";
import type { DialogueTurnResponse } from "./schema.js";

/**
 * Conversation with no model behind it.
 *
 * Built from the same material the LLM would be given — what this person knows,
 * what is going on locally — arranged as a small deterministic dialogue tree.
 * It is not a substitute for a written character, but it is a real conversation
 * with real information in it, which is what `--no-ai` has to be for the
 * offline path to be a supported way to play rather than a degraded mode.
 */

const FAREWELL = "Good day to you.";

export function cannedTurn(
	record: NpcRecord,
	spec: NpcSpec | undefined,
	site: SiteSpec | undefined,
	playerSaid: string | undefined,
): DialogueTurnResponse {
	const topics = buildTopics(spec, site);

	// The player picked a topic: answer it and offer the rest.
	if (playerSaid) {
		const chosen = topics.find((topic) => topic.choice === playerSaid);
		if (!chosen) {
			return { speech: FAREWELL, choices: [], actions: [], endsConversation: true };
		}
		const remaining = topics.filter((topic) => topic !== chosen);
		return {
			speech: chosen.answer,
			choices: remaining.length > 0 ? [...remaining.map((t) => t.choice), "Farewell."] : [],
			actions: [],
			endsConversation: remaining.length === 0,
		};
	}

	return {
		speech: greeting(record, spec),
		choices: topics.length > 0 ? [...topics.map((t) => t.choice), "Farewell."] : [],
		actions: [],
		endsConversation: topics.length === 0,
	};
}

function greeting(record: NpcRecord, spec: NpcSpec | undefined): string {
	if (record.totalTurns > 0) return `Back again. What is it?`;
	if (spec?.appearance) return `${spec.appearance} They look up as you approach.`;
	return `You find ${record.name}, the ${record.role}, at their work.`;
}

interface Topic {
	readonly choice: string;
	readonly answer: string;
}

function buildTopics(spec: NpcSpec | undefined, site: SiteSpec | undefined): Topic[] {
	const topics: Topic[] = [];

	for (const known of spec?.knows ?? []) {
		topics.push({ choice: `Ask about ${subject(known)}.`, answer: known });
	}
	for (const hook of site?.hooks ?? []) {
		topics.push({ choice: `Ask what troubles the town.`, answer: hook });
	}
	if (site?.description && topics.length < 3) {
		topics.push({ choice: "Ask about this place.", answer: site.description });
	}
	if (spec?.role && topics.length < 3) {
		topics.push({
			choice: `Ask about their work.`,
			answer: `"${spec.persona || `I am the ${spec.role}. It keeps me busy enough.`}"`,
		});
	}

	// Three is enough for a menu; more reads as a list rather than a conversation.
	return topics.slice(0, 3);
}

/** Compress a fact into something short enough to be a menu entry. */
function subject(text: string): string {
	const firstClause = text.split(/[.,;:]/)[0] ?? text;
	const words = firstClause.trim().split(/\s+/).slice(0, 6).join(" ");
	return words.toLowerCase().replace(/[^a-z0-9 '-]/g, "") || "the road";
}
