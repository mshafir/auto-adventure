import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoArtifact } from "../../test/fixtures/scenario.js";
import type { ScenarioArc } from "../core/rules/arc.js";
import { npcId } from "../core/world/spec.js";
import { buildSession } from "../session.js";

/**
 * The arc, in a running game.
 *
 * The unit tests cover the lowering; this covers the wiring — that talking to the
 * anchor really does open the beat, that the quest lands where the journal panel
 * will find it, and that it completes through `verifyQuests` rather than needing
 * anybody to declare it done.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-arc-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const ROPE = "Coil of rope";

function arcFor(siteId: number): ScenarioArc {
	return {
		title: "The Tithe",
		premise: "Somebody has to pay for the rope.",
		beats: [
			{
				id: "meet-ilse",
				order: 0,
				siteId,
				npcSlot: 0,
				requires: [],
				setsFlag: "arc:met-ilse",
				quest: {
					id: "find-rope",
					name: "Find the season's rope",
					description: "It went down with the barge.",
					objectives: [{ kind: "have", target: ROPE, done: false }],
				},
				journal: "Ilse says the barge went down with every coil aboard.",
			},
			{
				id: "the-clerk",
				order: 1,
				siteId,
				npcSlot: 0,
				requires: ["arc:met-ilse"],
				setsFlag: "arc:clerk",
				journal: "The toll clerk has not been seen since.",
			},
		],
	};
}

function start() {
	const artifact = demoArtifact();
	const siteId = Number(Object.keys(artifact.sites)[0]);
	const session = buildSession(
		{
			worldId: "arc",
			seed: 0,
			flavour: "prebuilt",
			scenario: { ...artifact, arc: arcFor(siteId) },
		},
		{ saveDebounceMs: 0 },
	);
	const anchor = npcId(siteId, 0);
	const spec = artifact.sites[String(siteId)]?.npcs[0];
	if (!spec) throw new Error("fixture has no anchor npc");

	/**
	 * Start a conversation the way the game does — through the command alphabet,
	 * so the reducer emits `RunDialogueTurn` and the effect runner performs it.
	 * Dialogue is async, so let the microtask queue drain before asserting.
	 */
	const talkTo = async () => {
		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await new Promise((resolve) => setTimeout(resolve, 0));
	};

	/** Pick the highlighted reply, staying in the same conversation. */
	const reply = async () => {
		session.engine.dispatch({ t: "Confirm" });
		await new Promise((resolve) => setTimeout(resolve, 0));
	};

	return { session, siteId, anchor, talkTo, reply };
}

describe("an arc in play", () => {
	it("is carried into the world from the artifact", () => {
		const { session } = start();
		expect(session.engine.getState().arc?.title).toBe("The Tithe");
		session.dispose();
	});

	it("opens nothing before anybody has been spoken to", () => {
		const { session } = start();
		const state = session.engine.getState();
		expect(state.quests).toHaveLength(0);
		expect(state.flags["arc:met-ilse"]).toBeUndefined();
		session.dispose();
	});

	it("opens the first beat when the anchor is spoken to", async () => {
		const { session, talkTo } = start();
		await talkTo();
		const state = session.engine.getState();
		expect(state.flags["arc:met-ilse"]).toBe(true);
		expect(state.quests.map((q) => q.id)).toEqual(["find-rope"]);
		expect(state.journal.some((entry) => entry.text.includes("barge went down"))).toBe(true);
		session.dispose();
	});

	it("advances one beat per conversation, not the whole story", async () => {
		const { session, talkTo } = start();
		await talkTo();
		expect(session.engine.getState().flags["arc:clerk"]).toBeUndefined();
		// Both beats share an anchor, so only the gate keeps them apart.
		session.engine.dispatch({ t: "CloseDialogue" });
		await talkTo();
		expect(session.engine.getState().flags["arc:clerk"]).toBe(true);
		session.dispose();
	});

	it("does not walk the whole story inside one conversation", async () => {
		// Beats gate on flags earlier beats set, so checking on every turn rather than
		// only on the opening one would let a single chat open beat two, then three.
		const { session, talkTo, reply } = start();
		await talkTo();
		expect(session.engine.getState().flags["arc:met-ilse"]).toBe(true);
		await reply();
		await reply();
		expect(session.engine.getState().flags["arc:clerk"]).toBeUndefined();
		session.dispose();
	});

	it("completes the quest when the player actually has the thing", async () => {
		// Through `verifyQuests`, not because anything declared it done — which is the
		// failure mode that made quests sit open forever in the old design.
		const { session, talkTo } = start();
		await talkTo();
		expect(session.engine.getState().quests[0]?.completed).toBe(false);

		session.engine.dispatch({ t: "CloseDialogue" });
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "GrantItem", name: ROPE, description: "Tarred and heavy.", quantity: 1 }],
		});
		expect(session.engine.getState().quests[0]?.completed).toBe(true);
		session.dispose();
	});

	it("keeps its progress across a reload", async () => {
		const { session, talkTo } = start();
		await talkTo();
		session.engine.dispatch({ t: "CloseDialogue" });
		session.saves.schedule(session.engine.getState());
		session.saves.flush();
		session.dispose();

		// Resumed without the artifact: the arc travels with the save precisely so a
		// missing scenario file cannot silently end the story.
		const resumed = buildSession(
			{ worldId: "arc", seed: 0, flavour: "prebuilt", mustExist: true },
			{ saveDebounceMs: 0 },
		);
		const state = resumed.engine.getState();
		expect(state.arc?.beats).toHaveLength(2);
		expect(state.flags["arc:met-ilse"]).toBe(true);
		expect(state.quests.map((q) => q.id)).toEqual(["find-rope"]);
		resumed.dispose();
	});
});
