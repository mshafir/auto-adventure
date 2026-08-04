import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoArtifact } from "../../test/fixtures/scenario.js";
import type { DialogueTree } from "../ai/dialogue/tree.js";
import { npcId } from "../core/world/spec.js";
import { buildSession } from "../session.js";

/**
 * Authored conversation, in a running game.
 *
 * The walker is unit-tested; this is the wiring — that the written words reach the
 * panel instead of a canned line, that the cursor survives, and that a node's
 * actions become real effects through the same `mapActions` a live model uses.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-trees-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const ROPE = "Coil of rope";

function treeFor(anchor: string): DialogueTree {
	return {
		npcId: anchor,
		entry: ["hello"],
		revisit: ["again"],
		nodes: {
			hello: {
				id: "hello",
				speech: "You will be wanting the rope, then.",
				choices: [
					{ text: "What happened to the barge?", goto: "barge" },
					{ text: "Nothing. Good day.", goto: null },
				],
			},
			barge: {
				id: "barge",
				speech: "It went down in the narrows. Here, take this coil, it is all that floated.",
				actions: [
					{
						kind: "giveItem",
						item: ROPE,
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
				choices: [{ text: "Thank you.", goto: null }],
			},
			again: {
				id: "again",
				speech: "Back again.",
				choices: [{ text: "Just passing.", goto: null }],
			},
		},
	};
}

function start(withTrees = true) {
	const artifact = demoArtifact();
	const siteId = Number(Object.keys(artifact.sites)[0]);
	const anchor = npcId(siteId, 0);
	const spec = artifact.sites[String(siteId)]?.npcs[0];
	if (!spec) throw new Error("fixture has no anchor npc");

	const session = buildSession(
		{
			worldId: "trees",
			seed: 0,
			flavour: "prebuilt",
			scenario: withTrees ? { ...artifact, trees: { [anchor]: treeFor(anchor) } } : artifact,
		},
		{ saveDebounceMs: 0 },
	);

	// Read the framing card first, the way a player does. It blocks conversation on
	// purpose, so a test that skipped it would be testing a state no player is in.
	session.engine.dispatch({ t: "DismissCard" });

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const talkTo = async () => {
		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await settle();
	};
	const say = async (text: string) => {
		const state = session.engine.getState();
		const index = state.dialogue?.choices?.indexOf(text) ?? -1;
		if (index < 0) throw new Error(`"${text}" was not offered: ${state.dialogue?.choices}`);
		for (let i = 0; i < index; i++) session.engine.dispatch({ t: "ChoiceDown" });
		session.engine.dispatch({ t: "Confirm" });
		await settle();
	};

	return { session, anchor, talkTo, say };
}

describe("authored conversation in play", () => {
	it("speaks the written line rather than a canned one", async () => {
		const { session, talkTo } = start();
		await talkTo();
		const dialogue = session.engine.getState().dialogue;
		expect(dialogue?.lines.at(-1)?.text).toBe("You will be wanting the rope, then.");
		expect(dialogue?.choices).toEqual(["What happened to the barge?", "Nothing. Good day."]);
		session.dispose();
	});

	it("follows the tree when the player answers", async () => {
		const { session, talkTo, say } = start();
		await talkTo();
		await say("What happened to the barge?");
		expect(session.engine.getState().dialogue?.lines.at(-1)?.text).toContain("down in the narrows");
		session.dispose();
	});

	it("performs a node's actions through the ordinary effect path", async () => {
		// No new machinery: the node's `giveItem` is the same shape a live model emits,
		// so `mapActions` lowers it identically.
		const { session, talkTo, say } = start();
		await talkTo();
		await say("What happened to the barge?");
		const rope = session.engine.getState().inventory.find((item) => item.name === ROPE);
		expect(rope?.quantity).toBe(1);
		session.dispose();
	});

	it("remembers where the conversation got to", async () => {
		const { session, anchor, talkTo, say } = start();
		await talkTo();
		expect(session.engine.getState().npcs[anchor]?.node).toBe("hello");
		await say("What happened to the barge?");
		expect(session.engine.getState().npcs[anchor]?.node).toBe("barge");
		session.dispose();
	});

	it("closes without a blank line when a reply ends the talk", async () => {
		const { session, talkTo, say } = start();
		await talkTo();
		await say("Nothing. Good day.");
		const state = session.engine.getState();
		expect(state.dialogue).toBeUndefined();
		// A node that closed on the previous line has nothing to add; an empty speech
		// would have gone into the record as a turn.
		expect(state.npcs[Object.keys(state.npcs)[0] as string]?.recentTurns.at(-1)?.text).not.toBe("");
		session.dispose();
	});

	it("greets a returning player from the revisit opening", async () => {
		const { session, talkTo, say } = start();
		await talkTo();
		await say("Nothing. Good day.");
		await talkTo();
		expect(session.engine.getState().dialogue?.lines.at(-1)?.text).toBe("Back again.");
		session.dispose();
	});

	it("falls through to a real conversation when nobody wrote one", async () => {
		// The floor: an artifact with no trees is still playable, and the canned tree
		// knows what this person knows.
		const { session, talkTo } = start(false);
		await talkTo();
		const dialogue = session.engine.getState().dialogue;
		expect(dialogue?.lines.at(-1)?.text?.length ?? 0).toBeGreaterThan(0);
		expect(dialogue?.choices?.length ?? 0).toBeGreaterThan(0);
		session.dispose();
	});

	it("greets a first meeting as a first meeting, even when it opens the story", async () => {
		// The beat's flag is set on the same turn the beat opens, so reading the flags
		// after opening it meant a greeting gated on that flag fired on first contact —
		// the character said "you already have my count" before handing anything over,
		// and the first-meeting line was unreachable in every playthrough.
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const anchor = npcId(siteId, 0);
		const spec = artifact.sites[String(siteId)]?.npcs[0];
		if (!spec) throw new Error("fixture has no anchor npc");

		const tree: DialogueTree = {
			npcId: anchor,
			entry: ["knowing", "hello"],
			nodes: {
				hello: {
					id: "hello",
					speech: "You will be wanting the rope, then.",
					choices: [{ text: "Good day.", goto: null }],
				},
				knowing: {
					id: "knowing",
					speech: "You have heard about the barge already, I see.",
					requires: ["arc:met"],
					choices: [{ text: "Good day.", goto: null }],
				},
			},
		};

		const session = buildSession(
			{
				worldId: "first-meeting",
				seed: 0,
				flavour: "prebuilt",
				scenario: {
					...artifact,
					trees: { [anchor]: tree },
					arc: {
						title: "The Tithe",
						premise: "Somebody has to pay for the rope.",
						beats: [
							{
								id: "met",
								order: 0,
								siteId,
								npcSlot: 0,
								requires: [],
								setsFlag: "arc:met",
								journal: "Ilse mentioned the barge.",
							},
						],
					},
				},
			},
			{ saveDebounceMs: 0 },
		);

		session.engine.dispatch({ t: "DismissCard" });
		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await new Promise((resolve) => setTimeout(resolve, 0));

		const state = session.engine.getState();
		// The beat still opened — the flag is set and the journal written…
		expect(state.flags["arc:met"]).toBe(true);
		// …but the line the player heard is the one written for meeting a stranger.
		expect(state.dialogue?.lines.at(-1)?.text).toBe("You will be wanting the rope, then.");
		session.dispose();
	});

	it("keeps the cursor across a reload", async () => {
		const { session, anchor, talkTo, say } = start();
		await talkTo();
		await say("What happened to the barge?");
		session.engine.dispatch({ t: "CloseDialogue" });
		session.saves.schedule(session.engine.getState());
		session.saves.flush();
		session.dispose();

		const resumed = buildSession(
			{ worldId: "trees", seed: 0, flavour: "prebuilt", mustExist: true },
			{ saveDebounceMs: 0 },
		);
		expect(resumed.engine.getState().npcs[anchor]?.node).toBe("barge");
		resumed.dispose();
	});
});
