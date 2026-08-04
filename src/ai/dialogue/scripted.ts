import type { DomainEffect } from "../../core/rules/effects.js";
import type { NpcRecord } from "../../core/rules/npc.js";
import type { GameState } from "../../core/rules/state.js";
import type { NpcSpec, SiteSpec } from "../../core/world/spec.js";
import { cannedTurn } from "./canned.js";
import type { DialogueTurnResponse } from "./schema.js";
import { type DialogueTree, nodeAfter, nodeAsTurn, openingNode } from "./tree.js";

/**
 * A turn of authored conversation.
 *
 * Whatever cannot be answered from the tree falls through to `cannedTurn`, which
 * knows the same facts and builds a real dialogue tree out of them. That is not
 * damage control — it is the same floor `NO_AI` stands on, and it is why an
 * incomplete set of trees degrades one character at a time rather than leaving a
 * blank panel.
 */

export interface ScriptedTurn {
	readonly turn: DialogueTurnResponse;
	/** Where the conversation now is, to be persisted against the NPC. */
	readonly effects: readonly DomainEffect[];
}

export function scriptedTurn(input: {
	readonly tree: DialogueTree | undefined;
	readonly state: GameState;
	readonly record: NpcRecord;
	readonly spec: NpcSpec | undefined;
	readonly site: SiteSpec | undefined;
	/** What the player just said, or undefined on the opening turn. */
	readonly answered: string | undefined;
}): ScriptedTurn {
	const { tree, state, record, spec, site, answered } = input;
	const fallback = (): ScriptedTurn => ({
		turn: cannedTurn(record, spec, site, answered),
		effects: [],
	});
	if (!tree) return fallback();

	if (answered === undefined) {
		const node = openingNode(tree, state, record);
		if (!node) return fallback();
		return { turn: nodeAsTurn(state, node), effects: [cursor(record.id, node.id)] };
	}

	// Mid-conversation, so the tree has to know where it was. A record with no
	// cursor means the opening turn did not come from the tree either.
	const current = record.node ? tree.nodes[record.node] : undefined;
	if (!current) return fallback();

	const next = nodeAfter(tree, state, current, answered);
	if (!next) return fallback();
	if (next.ended || !next.node) {
		return {
			turn: { speech: "", choices: [], actions: [], endsConversation: true },
			effects: [],
		};
	}
	return { turn: nodeAsTurn(state, next.node), effects: [cursor(record.id, next.node.id)] };
}

function cursor(npcId: string, node: string): DomainEffect {
	return { t: "SetNpcNode", npcId, node };
}

/**
 * Whether a scripted farewell should be shown at all.
 *
 * A node that ends the conversation with `goto: null` has already had its say in
 * the previous line, so the closing turn carries no speech. Dispatching an empty
 * line would put a blank row in the panel.
 */
export function isSilentEnd(turn: DialogueTurnResponse): boolean {
	return turn.endsConversation && turn.speech.length === 0;
}
