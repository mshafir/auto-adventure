import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoArtifact } from "../../../test/fixtures/scenario.js";
import { turnKey } from "../../core/rules/dialogue-cache.js";
import { npcId } from "../../core/world/spec.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import { buildSession } from "../../session.js";

/**
 * A remembered reply, in a running game.
 *
 * The cache itself is unit-tested; this is the wiring, and the wiring is where the
 * interesting question lives: a reply that has already been written is content this world
 * owns, so it has to reach the panel on a path that does not involve a model at all. That
 * is what these tests can check without a key, and it is also the property that makes a
 * world playable offline after one session with one.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-cache-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

const REMEMBERED = "I remember telling you: the mill wheel is seized.";

/**
 * The fixture's cast, allowed to improvise.
 *
 * Improvisation is opt-in per person for an authored cast, and the cache only exists for
 * people who improvise — there is nothing to remember about somebody whose words were
 * written down. So a test about the cache has to mark somebody first.
 */
function improvising(artifact: ScenarioArtifact): ScenarioArtifact {
	return {
		...artifact,
		sites: Object.fromEntries(
			Object.entries(artifact.sites).map(([key, site]) => [
				key,
				{ ...site, npcs: site.npcs.map((npc) => ({ ...npc, live: true })) },
			]),
		),
	};
}

function start() {
	const artifact = improvising(demoArtifact());
	const siteId = Number(Object.keys(artifact.sites)[0]);
	const anchor = npcId(siteId, 0);
	const spec = artifact.sites[String(siteId)]?.npcs[0];
	if (!spec) throw new Error("fixture has no anchor npc");

	// No `trees`, so nothing is scripted and the cache is what decides.
	const session = buildSession(
		{ worldId: "cache", seed: 0, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0 },
	);
	session.engine.dispatch({ t: "DismissCard" });

	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
	const talk = async () => {
		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await settle();
	};
	const spoken = () => session.engine.getState().dialogue?.lines.at(-1)?.text;
	return { session, anchor, spec, talk, spoken, settle };
}

describe("a reply that has already been written", () => {
	it("is spoken instead of a fresh one, with no model involved", async () => {
		const { session, anchor, talk, spoken } = start();

		// Seeded against the state the opening turn will be keyed from: no player lines
		// yet, and whatever flags the scenario opens with.
		const key = turnKey(session.engine.getState(), anchor);
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "RememberTurn",
					key,
					turn: {
						speech: REMEMBERED,
						choices: ["Whose is it?"],
						actions: [],
						endsConversation: false,
						at: 0,
					},
				},
			],
		});

		await talk();
		expect(spoken()).toBe(REMEMBERED);
		expect(session.engine.getState().dialogue?.choices).toEqual(["Whose is it?"]);
		session.dispose();
	});

	it("survives a save and a reload", async () => {
		// The whole point of putting it in the save rather than in memory: the second
		// session must be able to say what the first one paid for.
		const first = start();
		const key = turnKey(first.session.engine.getState(), first.anchor);
		first.session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "RememberTurn",
					key,
					turn: {
						speech: REMEMBERED,
						choices: [],
						actions: [],
						endsConversation: true,
						at: 0,
					},
				},
			],
		});
		first.session.saves.flush();
		first.session.dispose();

		const second = buildSession(
			{ worldId: "cache", seed: 0, flavour: "prebuilt", scenario: demoArtifact() },
			{ saveDebounceMs: 0 },
		);
		second.engine.dispatch({ t: "DismissCard" });
		expect(second.engine.getState().dialogueCache?.[key]?.speech).toBe(REMEMBERED);
		second.dispose();
	});

	it("does not answer a different question with it", async () => {
		// The key is the guard against the cache being a single answer per person. A turn
		// stored under one point in a conversation must not surface at another.
		const { session, anchor, talk, spoken } = start();
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "RememberTurn",
					key: `${anchor}:not-this-moment`,
					turn: {
						speech: REMEMBERED,
						choices: [],
						actions: [],
						endsConversation: false,
						at: 0,
					},
				},
			],
		});
		await talk();
		expect(spoken()).not.toBe(REMEMBERED);
		session.dispose();
	});

	it("carries the improvise flag onto the world, and back off a save", async () => {
		// `prebuilt` used to mean both "authored ahead of time" and "never calls a model",
		// and a generated scenario has split those apart. The world has to remember which
		// it is, or reopening it would silently change what its people can say.
		const first = buildSession(
			{
				worldId: "live-flag",
				seed: 0,
				flavour: "prebuilt",
				scenario: { ...demoArtifact(), liveInGame: true },
			},
			{ saveDebounceMs: 0 },
		);
		expect(first.engine.getState().world.liveInGame).toBe(true);
		first.saves.flush();
		first.dispose();

		// Resumed without the artifact saying so a second time: the save is what remembers.
		const second = buildSession(
			{ worldId: "live-flag", seed: 0, flavour: "prebuilt", scenario: demoArtifact() },
			{ saveDebounceMs: 0 },
		);
		expect(second.engine.getState().world.liveInGame).toBe(true);
		second.dispose();
	});

	it("yields to an author's words", async () => {
		// A written tree outranks a remembered reply: the author wrote theirs on purpose.
		const artifact = improvising(demoArtifact());
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const anchor = npcId(siteId, 0);
		const spec = artifact.sites[String(siteId)]?.npcs[0];
		if (!spec) throw new Error("fixture has no anchor npc");

		const session = buildSession(
			{
				worldId: "cache",
				seed: 0,
				flavour: "prebuilt",
				scenario: {
					...artifact,
					trees: {
						[anchor]: {
							npcId: anchor,
							entry: ["written"],
							revisit: ["written"],
							nodes: {
								written: { id: "written", speech: "What the author wrote.", choices: [] },
							},
						},
					},
				},
			},
			{ saveDebounceMs: 0 },
		);
		session.engine.dispatch({ t: "DismissCard" });
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "RememberTurn",
					key: turnKey(session.engine.getState(), anchor),
					turn: {
						speech: REMEMBERED,
						choices: [],
						actions: [],
						endsConversation: false,
						at: 0,
					},
				},
			],
		});

		session.engine.dispatch({ t: "DialogueOpened", npcId: anchor, npcName: spec.name });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.engine.getState().dialogue?.lines.at(-1)?.text).toBe("What the author wrote.");
		session.dispose();
	});
});
