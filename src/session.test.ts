import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demoArtifact } from "../test/fixtures/scenario.js";
import { hashString } from "./core/rand/hash.js";
import type { ScenarioBrief } from "./core/world/brief.js";
import type { LaunchChoice } from "./scenario/scenario.js";
import { buildSession, MissingSaveError, resolveBrief } from "./session.js";

const SEED = hashString("session-test");
let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-session-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	// Assigning undefined would set the literal string "undefined".
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function choice(overrides: Partial<LaunchChoice> = {}): LaunchChoice {
	return { worldId: "test", seed: SEED, flavour: "procedural", ...overrides };
}

/**
 * Play one action so the debounced save actually lands on disk.
 *
 * Two moves, not one: the first press of a new direction only turns, so a single
 * dispatch would leave the player standing where they started.
 */
function saveNow(session: ReturnType<typeof buildSession>) {
	// The opening card blocks movement until it has been read, which is the point of
	// it — so a test that walks has to read it first, like a player.
	session.engine.dispatch({ t: "DismissCard" });
	session.engine.dispatch({ t: "Move", facing: "down" });
	session.engine.dispatch({ t: "Move", facing: "down" });
	session.saves.schedule(session.engine.getState());
	session.saves.flush();
}

describe("resolveBrief", () => {
	const saved: ScenarioBrief = { premise: "a drowned archipelago" };
	const offered: ScenarioBrief = { premise: "a desert of glass towers" };

	it("keeps the brief a world already has", () => {
		expect(resolveBrief(saved, offered)).toEqual({ brief: saved, ignored: true });
	});

	it("adopts an offered brief when the world has none", () => {
		expect(resolveBrief(undefined, offered)).toEqual({ brief: offered, ignored: false });
	});

	it("does not report an offer that was never made as ignored", () => {
		// The bug this pins: a new world's brief *is* the offered one, so reporting
		// on the resolved value rather than the saved one warned that every briefed
		// new world was ignoring its own brief.
		expect(resolveBrief(saved, undefined)).toEqual({ brief: saved, ignored: false });
		expect(resolveBrief(undefined, undefined)).toEqual({ brief: undefined, ignored: false });
	});
});

describe("buildSession", () => {
	it("creates a world when the slot is empty", () => {
		const session = buildSession(choice(), { saveDebounceMs: 0 });
		expect(session.state.world.seed).toBe(SEED);
		expect(session.state.world.id).toBe("test");
		session.dispose();
	});

	it("resumes a world instead of regenerating it", () => {
		const first = buildSession(choice(), { saveDebounceMs: 0 });
		saveNow(first);
		const moved = first.engine.getState().player;
		first.dispose();

		// A different seed must not move the player or rebuild the terrain: the save
		// carries its own seed and wins.
		const second = buildSession(choice({ seed: hashString("something-else") }), {
			saveDebounceMs: 0,
		});
		expect(second.state.world.seed).toBe(SEED);
		expect(second.state.player.x).toBe(moved.x);
		expect(second.state.player.y).toBe(moved.y);
		second.dispose();
	});

	it("refuses to invent a world the launcher expected to find", () => {
		expect(() => buildSession(choice({ worldId: "ghost", mustExist: true }))).toThrow(
			MissingSaveError,
		);
	});

	it("persists an offered brief into a new world", () => {
		const brief: ScenarioBrief = { premise: "a drowned archipelago" };
		const session = buildSession(choice({ brief }), { saveDebounceMs: 0 });
		expect(session.state.brief).toEqual(brief);
		saveNow(session);
		session.dispose();

		const resumed = buildSession(choice(), { saveDebounceMs: 0 });
		expect(resumed.state.brief).toEqual(brief);
		resumed.dispose();
	});

	it("lets an unbriefed world adopt a brief without being restarted", () => {
		const first = buildSession(choice(), { saveDebounceMs: 0 });
		expect(first.state.brief).toBeUndefined();
		saveNow(first);
		first.dispose();

		const brief: ScenarioBrief = { premise: "a desert of glass towers" };
		const second = buildSession(choice({ brief }), { saveDebounceMs: 0 });
		expect(second.state.brief).toEqual(brief);
		saveNow(second);
		second.dispose();

		const third = buildSession(choice(), { saveDebounceMs: 0 });
		expect(third.state.brief).toEqual(brief);
		third.dispose();
	});

	it("will not re-brief a world that already has one", () => {
		const original: ScenarioBrief = { premise: "a drowned archipelago" };
		const first = buildSession(choice({ brief: original }), { saveDebounceMs: 0 });
		saveNow(first);
		first.dispose();

		const second = buildSession(choice({ brief: { premise: "a desert of glass towers" } }), {
			saveDebounceMs: 0,
		});
		expect(second.state.brief).toEqual(original);
		second.dispose();
	});

	it("is idempotent on dispose", () => {
		const session = buildSession(choice(), { saveDebounceMs: 0 });
		session.dispose();
		expect(() => session.dispose()).not.toThrow();
	});
});

describe("a prebuilt world", () => {
	const artifact = demoArtifact();
	const siteId = Object.keys(artifact.sites)[0] as string;

	function prebuilt(overrides: Partial<LaunchChoice> = {}) {
		return buildSession(
			// A deliberately wrong seed: the artifact's must win, because its specs are
			// keyed to site ids derived from it and mean nothing paired with any other.
			choice({ flavour: "prebuilt", scenario: artifact, seed: hashString("wrong"), ...overrides }),
			{ saveDebounceMs: 0 },
		);
	}

	it("takes its seed, spawn and bounds from the artifact", () => {
		const session = prebuilt();
		expect(session.state.world.seed).toBe(artifact.seed);
		expect(session.state.player.x).toBe(artifact.spawn.x);
		expect(session.state.player.y).toBe(artifact.spawn.y);
		expect(session.state.world.bounds).toEqual(artifact.bounds);
		expect(session.state.world.scenarioId).toBe(artifact.id);
		session.dispose();
	});

	it("has every spec before the first frame is drawn", () => {
		// The property that makes prebuilt different in kind rather than degree. In
		// live play a spec can arrive after the player is standing in the town, which
		// is the whole reason the director has a commitment rule; here there is
		// nothing to commit, because nothing is still coming.
		const session = prebuilt();
		expect(session.state.sites[siteId]).toEqual(artifact.sites[siteId]);
		expect(session.state.lore).toEqual(artifact.lore);
		// Recorded as sources too, which is what stops a fallback roster from
		// overwriting an authored one.
		expect(session.state.specSources[siteId]).toBe("llm");
		session.dispose();
	});

	it("names the place from the artifact on the first frame", () => {
		const session = prebuilt();
		expect(session.engine.placeNameAt(artifact.spawn.x, artifact.spawn.y)).toBe("Thornwick");
		session.dispose();
	});

	it("is bounded, and the boundary is impassable", () => {
		const session = prebuilt();
		const view = session.engine.getWorldView();
		const { maxX } = artifact.bounds;
		const y = artifact.spawn.y;
		// Force the chunk containing a point outside the rectangle to exist, then
		// read it: the engine must be generating with bounds applied.
		session.engine.getChunks().ensure(Math.floor((maxX + 20) / 64), Math.floor(y / 64));
		expect(view.isPassable(maxX + 20, y)).toBe(false);
		session.dispose();
	});

	it("keeps the artifact's brief and refuses to be re-briefed", () => {
		// The content was written to this brief. Offering another cannot change what
		// is already on the page, so the artifact's wins.
		const session = prebuilt({ brief: { premise: "a desert of glass towers" } });
		expect(session.state.brief).toEqual(artifact.brief);
		session.dispose();
	});

	it("stays bounded and authored after a reload without the artifact", () => {
		// A save carries the bounds and the specs, so a scenario world survives its
		// file being deleted. Only the arc and the dialogue trees need re-attaching.
		const first = prebuilt();
		saveNow(first);
		first.dispose();

		const resumed = buildSession(choice({ flavour: "prebuilt" }), { saveDebounceMs: 0 });
		expect(resumed.state.world.bounds).toEqual(artifact.bounds);
		expect(resumed.state.world.scenarioId).toBe(artifact.id);
		expect(resumed.state.sites[siteId]).toEqual(artifact.sites[siteId]);
		expect(resumed.state.brief).toEqual(artifact.brief);
		resumed.dispose();
	});
});

describe("the opening card", () => {
	it("frames a world with no model at all", () => {
		// The flavour with the least to work from. It still has to say where the player
		// is and admit there is no errand, rather than starting them on a blank tile.
		const session = buildSession(choice(), { saveDebounceMs: 0 });
		const card = session.engine.getState().card;
		expect(card?.id).toBe("opening");
		expect(card?.sections.map((s) => s.heading)).toContain("Where you are");
		expect(card?.sections.map((s) => s.heading)).toContain("What brought you here");
		session.dispose();
	});

	it("frames a prebuilt scenario from its own arc", () => {
		const artifact = demoArtifact();
		const session = buildSession(
			choice({
				worldId: "framed",
				flavour: "prebuilt",
				scenario: {
					...artifact,
					arc: {
						title: "The Tithe",
						premise: "Somebody has to pay for the rope.",
						beats: [],
					},
				},
			}),
			{ saveDebounceMs: 0 },
		);
		const card = session.engine.getState().card;
		expect(card?.title).toBe(artifact.lore.title);
		expect(card?.sections.find((s) => s.heading === "What brought you here")?.body).toBe(
			"Somebody has to pay for the rope.",
		);
		session.dispose();
	});

	it("frames a scenario that improvises during play, which has its lore already", () => {
		// The case that went missing. `liveInGame` puts a model behind the conversations,
		// so the card used to wait for the director to report the world's lore — and a
		// scenario's lore is in the artifact, so the director never asks and never
		// reports. The result was a player dropped onto a tile with no premise, no
		// protagonist and no idea which way the first beat was, in the one flavour of
		// world that has all three written down.
		process.env.AI_GATEWAY_API_KEY = "test-key";
		try {
			const artifact = demoArtifact();
			const session = buildSession(
				choice({
					worldId: "improvised",
					flavour: "prebuilt",
					scenario: { ...artifact, liveInGame: true },
					liveInGame: true,
				}),
				{ saveDebounceMs: 0 },
			);
			expect(session.engine.getState().card?.id).toBe("opening");
			session.dispose();
		} finally {
			delete process.env.AI_GATEWAY_API_KEY;
		}
	});

	it("uses the brief when a world was asked to be about something", () => {
		const session = buildSession(
			choice({
				worldId: "briefed",
				brief: {
					protagonist: "a tax collector nobody sent for",
					storyline: "the player is owed money",
				},
			}),
			{ saveDebounceMs: 0 },
		);
		const sections = session.engine.getState().card?.sections ?? [];
		expect(sections.find((s) => s.heading === "Who you are")?.body).toBe(
			"You are a tax collector nobody sent for.",
		);
		expect(sections.find((s) => s.heading === "What brought you here")?.body).toBe(
			"You are owed money.",
		);
		session.dispose();
	});

	it("blocks the world until it has been read", () => {
		const session = buildSession(choice({ worldId: "blocked" }), { saveDebounceMs: 0 });
		const before = session.engine.getState().player;
		session.engine.dispatch({ t: "Move", facing: "down" });
		session.engine.dispatch({ t: "Move", facing: "down" });
		expect(session.engine.getState().player).toEqual(before);

		session.engine.dispatch({ t: "DismissCard" });
		session.engine.dispatch({ t: "Move", facing: "down" });
		session.engine.dispatch({ t: "Move", facing: "down" });
		expect(session.engine.getState().player.y).not.toBe(before.y);
		session.dispose();
	});

	it("does not show it again on a world that has already been played", () => {
		const first = buildSession(choice({ worldId: "resumed" }), { saveDebounceMs: 0 });
		saveNow(first);
		first.dispose();

		const again = buildSession(choice({ worldId: "resumed", mustExist: true }), {
			saveDebounceMs: 0,
		});
		expect(again.engine.getState().card).toBeUndefined();
		again.dispose();
	});
});

describe("a world's content pack", () => {
	const override = {
		id: "testpack",
		names: { given: ["Ott"], family: ["Pell"] },
		households: { house: { count: [1, 1] as const, roles: ["feller"] } },
	};

	it("is remembered by the world that was made with it", () => {
		// Names are derived, not stored, so a pack has to travel with the save: opening
		// one without it would rename everybody already met and keep their memories.
		const session = buildSession(choice({ worldId: "packed", content: override }), {
			saveDebounceMs: 0,
		});
		expect(session.engine.getState().content?.id).toBe("testpack");
		saveNow(session);
		session.dispose();

		const again = buildSession(choice({ worldId: "packed", mustExist: true }), {
			saveDebounceMs: 0,
		});
		expect(again.engine.getState().content?.id).toBe("testpack");
		again.dispose();
	});

	it("keeps its own pack rather than adopting an offered one", () => {
		const first = buildSession(choice({ worldId: "settled", content: override }), {
			saveDebounceMs: 0,
		});
		saveNow(first);
		first.dispose();

		const again = buildSession(
			choice({ worldId: "settled", mustExist: true, content: { id: "different" } }),
			{ saveDebounceMs: 0 },
		);
		expect(again.engine.getState().content?.id).toBe("testpack");
		again.dispose();
	});

	it("names the people in its houses", () => {
		const session = buildSession(choice({ worldId: "named", content: override }), {
			saveDebounceMs: 0,
		});
		const engine = session.engine;
		const chunks = engine.getChunks();
		let found: { interiorId: number; kind: string } | undefined;
		for (let my = -2; my <= 2 && !found; my++) {
			for (let mx = -2; mx <= 2 && !found; mx++) {
				chunks.ensure(mx, my);
				found = chunks
					.buildingsIn(mx, my)
					.find((b) => b.kind === "house" || b.kind === "farmhouse");
			}
		}
		if (found) {
			const people = engine.getResidents().in(found.interiorId, found.kind);
			expect(people.length).toBeGreaterThan(0);
			expect(people[0]?.name).toBe("Ott Pell");
			expect(people[0]?.role).toBe("feller");
		}
		session.dispose();
	});

	it("leaves a world with no pack on the default", () => {
		const session = buildSession(choice({ worldId: "plain" }), { saveDebounceMs: 0 });
		expect(session.engine.getState().content).toBeUndefined();
		session.dispose();
	});
});

describe("the opening card's directions", () => {
	it("names the first beat's town, who to ask for, and which way it lies", () => {
		const artifact = demoArtifact();
		const siteId = Number(Object.keys(artifact.sites)[0]);
		const spec = artifact.sites[String(siteId)];
		if (!spec) throw new Error("fixture has no site");

		const session = buildSession(
			choice({
				worldId: "directed",
				flavour: "prebuilt",
				scenario: {
					...artifact,
					arc: {
						title: "The Tithe",
						premise: "Somebody has to pay for the rope.",
						beats: [
							{
								id: "meet",
								order: 0,
								siteId,
								npcSlot: 0,
								requires: [],
								setsFlag: "arc:meet",
							},
						],
					},
				},
			}),
			{ saveDebounceMs: 0 },
		);

		const start = session.engine
			.getState()
			.card?.sections.find((section) => section.heading === "Where to start")?.body;
		expect(start).toBeDefined();
		expect(start).toContain(spec.name);
		expect(start).toContain(spec.npcs[0]?.name ?? "");
		session.dispose();
	});

	it("says nothing about where to start in a world with no story", () => {
		const session = buildSession(choice({ worldId: "storyless" }), { saveDebounceMs: 0 });
		const headings = session.engine.getState().card?.sections.map((s) => s.heading) ?? [];
		expect(headings).not.toContain("Where to start");
		session.dispose();
	});
});
