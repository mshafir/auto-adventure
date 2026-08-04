import type { NpcRecord } from "../../core/rules/npc.js";
import type { GameState } from "../../core/rules/state.js";
import type { ActionResponse, DialogueTurnResponse } from "./schema.js";

/**
 * A conversation someone wrote down.
 *
 * The shape is chosen so that nothing new has to happen at runtime. A node's
 * actions are `ActionResponse` values — the same things a live model asks for —
 * so `mapActions` lowers them the same way, and a scripted NPC can give an item,
 * open a quest or adjust reputation without a single new effect. The walker
 * returns a `DialogueTurnResponse`, the same shape `cannedTurn` returns, so the
 * dialogue service does not care which produced it.
 *
 * The honest limitation: this cannot react to arbitrary state the way a live call
 * can. Gated choices and alternative openings cover the cases worth covering; a
 * player who does something genuinely strange gets a stiff conversation. That is
 * the price of the mode, and it is why `live` stays the default.
 */

export interface DialogueChoice {
	readonly text: string;
	/** Where answering leads. Null ends the conversation. */
	readonly goto: string | null;
	/** Flags that must be set for this reply to be offered at all. */
	readonly requires?: readonly string[];
}

export interface DialogueNode {
	readonly id: string;
	readonly speech: string;
	/** Flags required for this node to be eligible as an opening. */
	readonly requires?: readonly string[];
	readonly choices: readonly DialogueChoice[];
	readonly actions?: readonly ActionResponse[];
}

export interface DialogueTree {
	readonly npcId: string;
	/**
	 * Openings for a first meeting, most specific first.
	 *
	 * A list rather than one id so a character can greet the player differently once
	 * the story has moved — the first candidate whose flags are all set wins.
	 */
	readonly entry: readonly string[];
	/** Openings for every meeting after the first. Falls back to `entry`. */
	readonly revisit?: readonly string[];
	readonly nodes: Readonly<Record<string, DialogueNode>>;
}

function satisfied(state: GameState, requires: readonly string[] | undefined): boolean {
	return (requires ?? []).every((flag) => Boolean(state.flags[flag]));
}

/** The first listed node that exists and whose flags are set. */
function pickNode(
	tree: DialogueTree,
	state: GameState,
	candidates: readonly string[],
): DialogueNode | undefined {
	for (const id of candidates) {
		const node = tree.nodes[id];
		if (node && satisfied(state, node.requires)) return node;
	}
	return undefined;
}

/** Where a conversation with this person starts now. */
export function openingNode(
	tree: DialogueTree,
	state: GameState,
	record: NpcRecord | undefined,
): DialogueNode | undefined {
	const returning = (record?.totalTurns ?? 0) > 0;
	if (returning && tree.revisit) {
		const node = pickNode(tree, state, tree.revisit);
		if (node) return node;
	}
	return pickNode(tree, state, tree.entry);
}

/**
 * Where answering leads.
 *
 * Matched on the reply's text because that is what the UI sent back, and the
 * choices the player was shown were generated from this same tree a moment ago.
 * A reply that does not match — a stale panel, a hand-edited save, a tree changed
 * under a save — resolves to undefined so the caller can fall back rather than
 * pretending.
 */
export function nodeAfter(
	tree: DialogueTree,
	state: GameState,
	from: DialogueNode,
	answered: string,
): { readonly node?: DialogueNode; readonly ended: boolean } | undefined {
	const choice = visibleChoices(state, from).find((option) => option.text === answered);
	if (!choice) return undefined;
	if (choice.goto === null) return { ended: true };
	const node = tree.nodes[choice.goto];
	// A `goto` pointing nowhere is an authoring error, and `verifyArtifact` refuses
	// such a tree; if one still arrives, ending the conversation beats a dead panel.
	if (!node) return { ended: true };
	return { node, ended: false };
}

export function visibleChoices(state: GameState, node: DialogueNode): readonly DialogueChoice[] {
	return node.choices.filter((choice) => satisfied(state, choice.requires));
}

/**
 * A node, as a turn the dialogue service can dispatch.
 *
 * Four choices is the panel's limit; beyond that a conversation reads as a list.
 */
export function nodeAsTurn(state: GameState, node: DialogueNode): DialogueTurnResponse {
	const choices = visibleChoices(state, node).slice(0, 4);
	return {
		speech: node.speech,
		choices: choices.map((choice) => choice.text),
		actions: [...(node.actions ?? [])],
		endsConversation: choices.length === 0,
	};
}

/** Every node id a tree refers to but does not define. */
export function danglingTargets(tree: DialogueTree): string[] {
	const missing = new Set<string>();
	for (const id of [...tree.entry, ...(tree.revisit ?? [])]) {
		if (!tree.nodes[id]) missing.add(id);
	}
	for (const node of Object.values(tree.nodes)) {
		for (const choice of node.choices) {
			if (choice.goto !== null && !tree.nodes[choice.goto]) missing.add(choice.goto);
		}
	}
	return [...missing];
}

/**
 * Node ids no conversation can arrive at.
 *
 * Not an error — a node kept for a beat that has not been written yet is harmless
 * — but worth reporting, because the usual cause is a `goto` that was renamed on
 * one side only.
 */
export function unreachableNodes(tree: DialogueTree): string[] {
	const seen = new Set<string>();
	const queue = [...tree.entry, ...(tree.revisit ?? [])];
	while (queue.length > 0) {
		const id = queue.pop() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		const node = tree.nodes[id];
		if (!node) continue;
		for (const choice of node.choices) {
			if (choice.goto !== null) queue.push(choice.goto);
		}
	}
	return Object.keys(tree.nodes).filter((id) => !seen.has(id));
}
