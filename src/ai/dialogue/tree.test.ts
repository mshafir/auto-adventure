import { describe, expect, it } from "vitest";
import { hashString } from "../../core/rand/hash.js";
import { createNpcRecord, type NpcRecord } from "../../core/rules/npc.js";
import { createInitialState, type GameState } from "../../core/rules/state.js";
import {
	type DialogueNode,
	type DialogueTree,
	danglingTargets,
	nodeAfter,
	nodeAsTurn,
	openingNode,
	unreachableNodes,
	visibleChoices,
} from "./tree.js";

const NPC = "npc:1234:0";

function node(id: string, overrides: Partial<DialogueNode> = {}): DialogueNode {
	return { id, speech: `line ${id}`, choices: [], ...overrides };
}

function tree(overrides: Partial<DialogueTree> = {}): DialogueTree {
	return {
		npcId: NPC,
		entry: ["hello"],
		nodes: {
			hello: node("hello", {
				choices: [
					{ text: "Ask about the rope.", goto: "rope" },
					{ text: "Farewell.", goto: null },
				],
			}),
			rope: node("rope", { choices: [{ text: "Farewell.", goto: null }] }),
		},
		...overrides,
	};
}

function stateWith(flags: Record<string, boolean> = {}): GameState {
	const base = createInitialState(
		{ id: "t", name: "t", seed: hashString("tree-test"), createdAt: "2026-01-01T00:00:00.000Z" },
		{ x: 0, y: 0 },
	);
	return { ...base, flags };
}

function record(overrides: Partial<NpcRecord> = {}): NpcRecord {
	return {
		...createNpcRecord({ id: NPC, name: "Ilse", role: "innkeeper", siteId: 1234 }),
		...overrides,
	};
}

describe("openingNode", () => {
	it("starts at the entry node", () => {
		expect(openingNode(tree(), stateWith(), record())?.id).toBe("hello");
	});

	it("uses the revisit opening once they have met", () => {
		const t = tree({
			revisit: ["again"],
			nodes: { ...tree().nodes, again: node("again", { choices: [] }) },
		});
		expect(openingNode(t, stateWith(), record())?.id).toBe("hello");
		expect(openingNode(t, stateWith(), record({ totalTurns: 4 }))?.id).toBe("again");
	});

	it("prefers the first opening whose flags are set", () => {
		// This is how a character greets the player differently once the story moved.
		const t = tree({
			entry: ["after-rope", "hello"],
			nodes: {
				...tree().nodes,
				"after-rope": node("after-rope", { requires: ["arc:rope"], choices: [] }),
			},
		});
		expect(openingNode(t, stateWith(), record())?.id).toBe("hello");
		expect(openingNode(t, stateWith({ "arc:rope": true }), record())?.id).toBe("after-rope");
	});

	it("falls back to entry when no revisit opening qualifies", () => {
		const t = tree({
			revisit: ["locked"],
			nodes: { ...tree().nodes, locked: node("locked", { requires: ["never"], choices: [] }) },
		});
		expect(openingNode(t, stateWith(), record({ totalTurns: 4 }))?.id).toBe("hello");
	});

	it("is undefined when no opening exists at all", () => {
		expect(openingNode(tree({ entry: ["missing"] }), stateWith(), record())).toBeUndefined();
	});
});

describe("visibleChoices", () => {
	it("hides a reply whose flags are not set", () => {
		const gated = node("x", {
			choices: [
				{ text: "Always.", goto: null },
				{ text: "Only once you know.", goto: null, requires: ["arc:rope"] },
			],
		});
		expect(visibleChoices(stateWith(), gated).map((c) => c.text)).toEqual(["Always."]);
		expect(visibleChoices(stateWith({ "arc:rope": true }), gated)).toHaveLength(2);
	});
});

describe("nodeAfter", () => {
	const t = tree();
	const hello = t.nodes.hello as DialogueNode;

	it("follows the reply the player picked", () => {
		expect(nodeAfter(t, stateWith(), hello, "Ask about the rope.")?.node?.id).toBe("rope");
	});

	it("ends on a null goto", () => {
		expect(nodeAfter(t, stateWith(), hello, "Farewell.")).toEqual({ ended: true });
	});

	it("is undefined for a reply that was never offered", () => {
		// A stale panel, or a tree changed under a save. The caller falls back rather
		// than pretending the player said something they could not have.
		expect(nodeAfter(t, stateWith(), hello, "Draw your sword.")).toBeUndefined();
	});

	it("is undefined for a reply that is currently hidden", () => {
		const gated = node("g", {
			choices: [{ text: "Only later.", goto: "rope", requires: ["arc:rope"] }],
		});
		expect(nodeAfter(t, stateWith(), gated, "Only later.")).toBeUndefined();
		expect(nodeAfter(t, stateWith({ "arc:rope": true }), gated, "Only later.")?.node?.id).toBe(
			"rope",
		);
	});

	it("ends rather than hanging when a goto points nowhere", () => {
		const broken = node("b", { choices: [{ text: "Go.", goto: "nowhere" }] });
		expect(nodeAfter(t, stateWith(), broken, "Go.")).toEqual({ ended: true });
	});
});

describe("nodeAsTurn", () => {
	it("produces the same shape a model or the canned tree would", () => {
		const turn = nodeAsTurn(stateWith(), tree().nodes.hello as DialogueNode);
		expect(turn.speech).toBe("line hello");
		expect(turn.choices).toEqual(["Ask about the rope.", "Farewell."]);
		expect(turn.endsConversation).toBe(false);
	});

	it("ends a node with nothing left to say", () => {
		const turn = nodeAsTurn(stateWith(), node("dead-end"));
		expect(turn.endsConversation).toBe(true);
		expect(turn.choices).toEqual([]);
	});

	it("caps replies at the four the panel can show", () => {
		const many = node("m", {
			choices: Array.from({ length: 6 }, (_, i) => ({ text: `Option ${i}`, goto: null })),
		});
		expect(nodeAsTurn(stateWith(), many).choices).toHaveLength(4);
	});

	it("carries actions through for mapActions to lower", () => {
		// The reason a scripted NPC needs no new machinery to hand over an item.
		const giving = node("g", {
			actions: [
				{
					kind: "giveItem",
					item: "Coil of rope",
					description: "Tarred and heavy.",
					quantity: 1,
					questId: null,
					questName: null,
					note: null,
					objectives: null,
					key: null,
					value: null,
				},
			],
		});
		expect(nodeAsTurn(stateWith(), giving).actions).toHaveLength(1);
	});
});

describe("danglingTargets", () => {
	it("is empty for a sound tree", () => {
		expect(danglingTargets(tree())).toEqual([]);
	});

	it("finds a goto that points nowhere", () => {
		const broken = tree({
			nodes: { hello: node("hello", { choices: [{ text: "Go.", goto: "gone" }] }) },
		});
		expect(danglingTargets(broken)).toEqual(["gone"]);
	});

	it("finds a missing opening", () => {
		expect(danglingTargets(tree({ entry: ["absent"] }))).toContain("absent");
	});
});

describe("unreachableNodes", () => {
	it("is empty when every node can be arrived at", () => {
		expect(unreachableNodes(tree())).toEqual([]);
	});

	it("finds an orphan", () => {
		// Usually a goto renamed on one side only.
		const orphaned = tree({ nodes: { ...tree().nodes, stranded: node("stranded") } });
		expect(unreachableNodes(orphaned)).toEqual(["stranded"]);
	});
});
