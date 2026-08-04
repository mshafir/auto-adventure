import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoArtifact } from "../../test/fixtures/scenario.js";
import { arcOutline, type ScenarioArc } from "../core/rules/arc.js";
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
	// Read the framing card, the way a player does before anything else. It blocks
	// conversation on purpose, so a test that skipped it would be testing a state no
	// player is ever in.
	session.engine.dispatch({ t: "DismissCard" });

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

describe("a beat that frames itself", () => {
	it("puts a full screen in front of the player as the beat opens", async () => {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const anchor = npcId(siteId, 0);
		const spec = artifact.sites[String(siteId)]?.npcs[0];
		if (!spec) throw new Error("fixture has no anchor npc");

		const session = buildSession(
			{
				worldId: "beat-card",
				seed: 0,
				flavour: "prebuilt",
				scenario: {
					...artifact,
					arc: {
						title: "The Tithe",
						premise: "Somebody has to pay for the rope.",
						beats: [
							{
								id: "the-barge",
								order: 0,
								siteId,
								npcSlot: 0,
								requires: [],
								setsFlag: "arc:the-barge",
								journal: "The barge went down with every coil aboard.",
								card: {
									title: "The narrows",
									sections: [
										{ heading: "What she tells you", body: "It went down in the narrows." },
									],
								},
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
		expect(state.card?.id).toBe("beat:the-barge");
		expect(state.card?.title).toBe("The narrows");
		// And what it describes is already true behind it.
		expect(state.journal.some((entry) => entry.text.includes("every coil aboard"))).toBe(true);

		// This is the only beat and it carries no errand, so the story also ends here —
		// and the ending waits its turn behind the revelation rather than replacing it.
		expect(state.pendingCards?.map((card) => card.id)).toEqual(["arc:end"]);
		session.engine.dispatch({ t: "DismissCard" });
		expect(session.engine.getState().card?.id).toBe("arc:end");

		// Read once. Dismissing and reopening the conversation must not raise it again.
		session.engine.dispatch({ t: "DismissCard" });
		session.engine.dispatch({ t: "CloseDialogue" });
		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.engine.getState().card).toBeUndefined();
		session.dispose();
	});
});

describe("a story that runs out of story", () => {
	/** Two beats on one anchor: the first hands out an errand, the second is the end. */
	function endingArc(siteId: number, ending?: ScenarioArc["ending"]): ScenarioArc {
		return {
			title: "The Tithe",
			premise: "Somebody has to pay for the rope.",
			...(ending ? { ending } : {}),
			beats: [
				{
					id: "the-rope",
					order: 0,
					siteId,
					npcSlot: 0,
					requires: [],
					setsFlag: "arc:the-rope",
					quest: {
						id: "rope",
						name: "Find the season's rope",
						description: "It went down in the narrows.",
						objectives: [{ kind: "have", target: ROPE, done: false }],
					},
				},
				{
					id: "the-reckoning",
					order: 1,
					siteId,
					npcSlot: 0,
					requires: ["arc:the-rope"],
					setsFlag: "arc:the-reckoning",
					journal: "So that is where it went.",
				},
			],
		};
	}

	async function playToTheEnd(ending?: ScenarioArc["ending"]) {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const anchor = npcId(siteId, 0);
		const spec = artifact.sites[String(siteId)]?.npcs[0];
		if (!spec) throw new Error("fixture has no anchor npc");

		const session = buildSession(
			{
				worldId: `ending-${ending ? "written" : "assembled"}`,
				seed: 0,
				flavour: "prebuilt",
				scenario: { ...artifact, arc: endingArc(siteId, ending) },
			},
			{ saveDebounceMs: 0 },
		);
		const engine = session.engine;
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		const talk = async () => {
			// Cards first, and *before* speaking: a card blocks `DialogueOpened`, so the
			// opening one left up would make every conversation in this test a no-op.
			for (let i = 0; i < 8 && engine.getState().card; i++) engine.dispatch({ t: "DismissCard" });
			engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
			await settle();
			for (let i = 0; i < 8 && engine.getState().dialogue; i++) {
				engine.dispatch({ t: "CloseDialogue" });
				await settle();
			}
		};

		// Beat one, its errand finished, then beat two — which is the last, so the story
		// ends as it opens.
		await talk();
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "GrantItem", name: ROPE, description: "Tarred.", quantity: 1 }],
		});
		return { session, engine, talk };
	}

	it("says so in the journal, once, in the words the player would ask in", async () => {
		// The complaint this answers: a finished scenario's last log line was an errand
		// name, and the player could not tell whether that was the end.
		const { session, engine, talk } = await playToTheEnd();
		expect(arcOutline(engine.getState().arc, engine.getState())?.finished).toBe(false);

		await talk();
		const state = engine.getState();
		expect(arcOutline(state.arc, state)?.finished).toBe(true);
		expect(state.journal.map((entry) => entry.text)).toContain(
			"The Tithe: the story is told. Nothing is waiting on you now.",
		);
		expect(state.flags["arc:complete"]).toBe(true);
		session.dispose();
	});

	it("closes on a card assembled from what the player actually did", async () => {
		// So a scenario that never wrote an ending still ends rather than stopping.
		const { session, engine, talk } = await playToTheEnd();
		await talk();

		const card = engine.getState().card;
		expect(card?.id).toBe("arc:end");
		expect(card?.subtitle).toBe("the story is told");
		const headings = card?.sections.map((section) => section.heading) ?? [];
		expect(headings).toEqual(["What you set out to do", "What you did", "And now"]);
		expect(card?.sections.find((s) => s.heading === "What you did")?.body).toContain(
			"Find the season's rope",
		);
		session.dispose();
	});

	it("prefers a written ending over the assembled one", async () => {
		const { session, engine, talk } = await playToTheEnd({
			title: "The hand you know",
			subtitle: "by one lamp",
			sections: [{ heading: "The ledger", body: "Every figure is in your sister's hand." }],
		});
		await talk();

		const card = engine.getState().card;
		expect(card?.id).toBe("arc:end");
		expect(card?.title).toBe("The hand you know");
		expect(card?.sections.map((section) => section.heading)).toEqual(["The ledger"]);
		session.dispose();
	});

	it("says it once, however many commands follow", async () => {
		const { session, engine, talk } = await playToTheEnd();
		await talk();
		engine.dispatch({ t: "DismissCard" });
		for (let i = 0; i < 6; i++) engine.dispatch({ t: "Move", facing: "down" });

		const told = engine
			.getState()
			.journal.filter((entry) => entry.text.includes("the story is told"));
		expect(told).toHaveLength(1);
		// And it does not come back up as a card either.
		expect(engine.getState().card).toBeUndefined();
		session.dispose();
	});
});
