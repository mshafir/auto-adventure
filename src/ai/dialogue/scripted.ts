import type { DomainEffect } from "../../core/rules/effects.js";
import type { NpcRecord } from "../../core/rules/npc.js";
import type { GameState } from "../../core/rules/state.js";
import type { DialogueTurnResponse } from "./schema.js";
import { type DialogueTree, nodeAfter, nodeAsTurn, openingNode } from "./tree.js";

/**
 * A turn of authored conversation, or nothing when nobody wrote one.
 *
 * "Nothing" is the important half, and it used to be missing: this returned a canned
 * turn whenever the tree could not answer, which reads as a sensible floor and is
 * really a decision taken in the wrong place. A conversation nobody wrote is not
 * automatically a conversation nobody can have — it is the exact case a world with
 * `liveInGame` set has paid a model to cover. Answering it here meant a scenario with
 * *any* trees at all silenced improvisation for *everyone*, since the caller only
 * asked whether a scripted turn came back and one always did.
 *
 * So the fall-through is the caller's to make. It knows whether a model is available
 * and whether this particular person is allowed to use one; all this knows is whether
 * an author wrote the line.
 */

export interface ScriptedTurn {
	/** Absent when the tree had nothing to say and the caller must decide. */
	readonly turn?: DialogueTurnResponse;
	/** Where the conversation now is, to be persisted against the NPC. */
	readonly effects: readonly DomainEffect[];
}

export function scriptedTurn(input: {
	readonly tree: DialogueTree | undefined;
	readonly state: GameState;
	readonly record: NpcRecord;
	/** What the player just said, or undefined on the opening turn. */
	readonly answered: string | undefined;
}): ScriptedTurn {
	const { tree, state, record, answered } = input;
	const fallback = (): ScriptedTurn => ({ effects: [] });
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
