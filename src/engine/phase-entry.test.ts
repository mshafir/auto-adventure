import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ASH_HOLLOW_ID, npcIdFor, twoPhaseArtifact } from "../../test/fixtures/two-phase.js";
import { takenKey } from "../core/rules/placement.js";
import { T } from "../core/tiles/terrain.js";
import { chunkKey, toChunk } from "../core/world/coords.js";
import { artifactWorld } from "../scenario/artifact.js";
import { readScenarioDir, writeScenarioDir } from "../scenario/dir.js";
import { buildSession, type Session } from "../session.js";
import { resolvePlacements } from "./placements.js";

/*
 * Chapters, through a whole session rather than through `composeScenario` alone.
 *
 * The composition rules have their own unit tests. What this file is for is everything that
 * has to happen *around* them when a chapter turns: the placements re-resolved against the
 * new content, the ground rebuilt where it changed, the people re-derived from specs a
 * chapter may have replaced, and — the cheap thing that has to stay cheap — nothing at all
 * happening on the commands where no chapter turned.
 */

const roots: string[] = [];
const sessions: Session[] = [];

/** A real session over the fixture, read back from a directory the way a player's would be. */
function open(): Session {
	const root = mkdtempSync(join(tmpdir(), "phase-entry-"));
	roots.push(root);
	const artifact = readScenarioDir(writeScenarioDir(twoPhaseArtifact(), root));
	if (!artifact) throw new Error("the fixture did not load");

	const session = buildSession(
		{
			worldId: `two-phase-${roots.length}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ persist: false },
	);
	sessions.push(session);
	return session;
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose?.();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Set a flag the way a scene's last step would, and let the world settle around it. */
function flood(session: Session) {
	session.engine.dispatch({
		t: "ApplyEffects",
		effects: [{ t: "SetFlag", key: "flood", value: true }],
	});
}

describe("entering a chapter", () => {
	it("brings in the placement the chapter adds", () => {
		const session = open();
		expect(session.engine.getState().placements ?? []).toHaveLength(0);

		flood(session);
		expect((session.engine.getState().placements ?? []).map((placement) => placement.id)).toEqual([
			"the-body-in-the-millrace",
		]);
	});

	it("resolves that placement to a real tile, rather than merely listing it", () => {
		// Listed but unresolved is the failure that matters: a `have` objective naming it could
		// never be satisfied and nothing on screen would say why. A chapter is exactly where that
		// slips through, because the building it names is not checked until the chapter arrives.
		const session = open();
		flood(session);
		const state = session.engine.getState();
		const placement = state.placements?.[0];
		if (!placement) throw new Error("the chapter added no placement");
		expect(state.flags[takenKey(placement.id)]).toBeUndefined();

		const { resolved, unresolved } = resolvePlacements(state.placements, {
			world: artifactWorld(twoPhaseArtifact()),
			siteSpec: (siteId) => state.sites[String(siteId)],
			bounds: twoPhaseArtifact().bounds,
		});
		expect(unresolved).toEqual([]);
		expect(resolved.map((entry) => entry.id)).toEqual(["the-body-in-the-millrace"]);
	});

	it("keeps the cutscenes it started with, since the chapter replaces none of them", () => {
		const session = open();
		expect(Object.keys(session.engine.getState().scenes ?? {})).toEqual(["the-messenger-arrives"]);
		flood(session);
		expect(Object.keys(session.engine.getState().scenes ?? {})).toEqual(["the-messenger-arrives"]);
	});

	it("lays the ground the chapter changes", () => {
		const session = open();
		const view = session.engine.getView();
		// The base chapter lays a footpath; the second widens it into a trodden dirt verge.
		expect(view.terrainAt(60, -30)).toBe(T.path);

		flood(session);
		expect(session.engine.getView().terrainAt(60, -30)).toBe(T.dirtRoad);
	});

	it("rebuilds the chunk the new ground is in, rather than leaving a hole", () => {
		const session = open();
		flood(session);
		const { cx, cy } = toChunk(60, -30);
		expect(session.engine.getChunks().has(cx, cy)).toBe(true);
		expect(chunkKey(cx, cy)).toBeTruthy();
	});

	it("leaves ground the chapter did not touch exactly as it was", () => {
		const session = open();
		const before = session.engine.getView().terrainAt(120, -80);
		flood(session);
		expect(session.engine.getView().terrainAt(120, -80)).toBe(before);
	});

	/*
	 * The cheap thing has to stay cheap. Composition runs after every command, and the engine
	 * decides whether to re-index anything by comparing the composed content by identity — so a
	 * step taken with no chapter turning must produce no new content object at all.
	 */
	it("does nothing on a command that turns no chapter", () => {
		const session = open();
		const before = session.engine.getState();
		session.engine.dispatch({ t: "Move", facing: "left" });
		const after = session.engine.getState();
		expect(after.placements).toBe(before.placements);
		expect(after.sites).toBe(before.sites);
		expect(after.triggers).toBe(before.triggers);
	});

	it("does not turn a chapter twice", () => {
		const session = open();
		flood(session);
		const entered = session.engine.getState();
		session.engine.dispatch({ t: "Move", facing: "left" });
		expect(session.engine.getState().placements).toBe(entered.placements);
	});

	/*
	 * A chapter can replace a site's spec wholesale, so the roster is re-derived from specs
	 * rather than kept. This fixture moves nobody, which makes the assertion "nobody was lost" —
	 * the failure a blanket `forgetAll` would cause if the repopulate afterwards were forgotten.
	 */
	it("still has its people afterwards", () => {
		const session = open();
		const keeper = npcIdFor(ASH_HOLLOW_ID, 0);
		const before = session.engine.personById(keeper);
		expect(before).toBeDefined();

		flood(session);
		const after = session.engine.personById(keeper);
		expect(after).toBeDefined();
		expect({ x: after?.x, y: after?.y }).toEqual({ x: before?.x, y: before?.y });
	});
});

describe("resuming inside a chapter", () => {
	it("opens in the chapter the flags put the player in", () => {
		// The chapter is derived, so a save made after a turning point must not open in chapter
		// one holding chapter two's flags — a world whose story has already happened in it.
		const session = open();
		flood(session);
		const mid = session.engine.getState();
		expect(mid.placements).toHaveLength(1);

		session.engine.hydrate({ ...mid, placements: [], signs: [] });
		expect(session.engine.getState().placements).toHaveLength(1);
	});
});
