import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASH_HOLLOW_ID,
	npcIdFor,
	twoPhaseArtifact,
	WENTHOLLOW_ID,
} from "../../test/fixtures/two-phase.js";
import { findPath } from "../core/geom/astar.js";
import { itemCount } from "../core/rules/state.js";
import { T } from "../core/tiles/terrain.js";
import { sitesInside } from "../core/world/macro.js";
import { buildSession, type Session } from "../session.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { readScenarioDir, writeScenarioDir } from "./dir.js";
import { readScenarioAt, writeScenario } from "./repo.js";
import { storyWalker } from "./walker.js";

/*
 * The whole thing, played.
 *
 * Every layer below has its own tests and they all pass; this is the one that catches what
 * they cannot — that a directory on disk becomes a world, that walking into a town fires a
 * trigger, that the trigger's cutscene stages against real generated ground and plays, and
 * that the world afterwards is the second chapter rather than the first with a flag set.
 *
 * Slow by nature: it generates a bounded world, builds two settlements and walks fifty tiles.
 * That is the price of the only test that would have caught a scenario whose people asked
 * after a document that was nowhere.
 */

const SLOW = { timeout: 60_000 };

const roots: string[] = [];
const sessions: Session[] = [];

function laid(artifact: ScenarioArtifact = twoPhaseArtifact()) {
	const root = mkdtempSync(join(tmpdir(), "two-phase-"));
	roots.push(root);
	const read = readScenarioDir(writeScenarioDir(artifact, root));
	if (!read) throw new Error("the fixture did not load");
	return read;
}

function open(artifact = laid()): {
	readonly session: Session;
	readonly artifact: ScenarioArtifact;
} {
	const session = buildSession(
		{
			worldId: `two-phase-e2e-${roots.length}-${sessions.length}`,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
		},
		{ persist: false },
	);
	sessions.push(session);
	return { session, artifact };
}

afterEach(() => {
	for (const session of sessions.splice(0)) session.dispose?.();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Walk the story: ask Ilse, then go east to Ash Hollow and let the scene happen. */
async function playToTheFlood(session: Session, artifact: ScenarioArtifact) {
	const sites = sitesInside(artifactWorld(artifact), artifact.bounds);
	const walker = storyWalker(artifact, session.engine, sites);
	const wenthollow = sites.get(WENTHOLLOW_ID);
	const ashHollow = sites.get(ASH_HOLLOW_ID);
	if (!wenthollow || !ashHollow) throw new Error("the fixture's towns are not in this world");

	walker.catchUp();
	await walker.talkTo(npcIdFor(WENTHOLLOW_ID, 0));
	walker.goTo(ashHollow);
	walker.catchUp();
	return walker;
}

describe("the two-phase fixture", () => {
	it("gets the errand from the ferryman", SLOW, async () => {
		const { session, artifact } = open();
		const sites = sitesInside(artifactWorld(artifact), artifact.bounds);
		const walker = storyWalker(artifact, session.engine, sites);
		walker.catchUp();
		expect(await walker.talkTo(npcIdFor(WENTHOLLOW_ID, 0))).toBe(true);
		expect(session.engine.getState().flags["beat:asked-ilse"]).toBe(true);
	});

	it("plays the cutscene on reaching the second town, and turns the chapter", SLOW, async () => {
		const { session, artifact } = open();
		await playToTheFlood(session, artifact);

		const state = session.engine.getState();
		// The scene has finished rather than merely started, and the flag its last step sets is
		// what makes the chapter turn.
		expect(state.scene).toBeUndefined();
		expect(state.flags.flood).toBe(true);
		// Its last step grants the ledger, which is what proves the last step ran at all.
		expect(itemCount(state, "Abbey Ledger")).toBe(1);
	});

	it("brings the second chapter's world with it", SLOW, async () => {
		const { session, artifact } = open();
		await playToTheFlood(session, artifact);

		const state = session.engine.getState();
		expect((state.placements ?? []).map((placement) => placement.id)).toEqual([
			"the-body-in-the-millrace",
		]);
		// And the ground between the towns has been trodden into a wider way.
		expect(session.engine.getView().terrainAt(60, -30)).toBe(T.dirtRoad);
	});

	it("does not play the cutscene again", SLOW, async () => {
		const { session, artifact } = open();
		await playToTheFlood(session, artifact);
		const after = session.engine.getState();

		// Every command the walk would make next, and none of them may reopen it.
		for (let step = 0; step < 8; step++) session.engine.dispatch({ t: "Move", facing: "left" });
		expect(session.engine.getState().scene).toBeUndefined();
		expect(itemCount(session.engine.getState(), "Abbey Ledger")).toBe(
			itemCount(after, "Abbey Ledger"),
		);
	});

	it("writes no save while the cutscene is playing", SLOW, async () => {
		const { session, artifact } = open();
		const sites = sitesInside(artifactWorld(artifact), artifact.bounds);
		const walker = storyWalker(artifact, session.engine, sites);
		const ashHollow = sites.get(ASH_HOLLOW_ID);
		if (!ashHollow) throw new Error("Ash Hollow is not in this world");

		walker.catchUp();
		await walker.talkTo(npcIdFor(WENTHOLLOW_ID, 0));
		walker.goTo(ashHollow);

		// Mid-scene: what a quit at the wrong moment would have written must not carry the scene,
		// because an interrupted scene replays from its first step.
		const playing = session.engine.getState();
		expect(playing.scene).toBeDefined();
		session.saves.schedule(playing);
		session.saves.flush();
		expect(session.saves.load(playing.world.id)?.scene).toBeUndefined();
	});

	/*
	 * The authored path is the whole argument for terraform existing: the generator gave both
	 * towns roads, but not to each other, so without it the way between them is cross-country.
	 */
	it("connects the two towns by ground a player can walk", SLOW, () => {
		const { session, artifact } = open();
		const sites = sitesInside(artifactWorld(artifact), artifact.bounds);
		const from = sites.get(WENTHOLLOW_ID)?.site;
		const to = sites.get(ASH_HOLLOW_ID)?.site;
		if (!from || !to) throw new Error("the fixture's towns are not in this world");

		// Build the ground between them before asking whether it connects.
		const ashHollow = sites.get(ASH_HOLLOW_ID);
		if (!ashHollow) throw new Error("Ash Hollow is not in this world");
		storyWalker(artifact, session.engine, sites).goTo(ashHollow);
		const view = session.engine.getView();

		const path = findPath(from, to, {
			bounds: { x: Math.min(from.x, to.x) - 40, y: Math.min(from.y, to.y) - 40, w: 160, h: 160 },
			cost: (x, y) => (view.isPassable(x, y) ? 1 : Number.POSITIVE_INFINITY),
		});
		expect(path).toBeDefined();
	});
});

describe("the fixture as a shipped scenario", () => {
	it("passes the checks a scenario is loaded through", () => {
		// `readScenarioAt` is what the launcher calls: the directory checks and the
		// world-consistency checks together. A fixture that only passed one of them would be
		// proving less than it looks like.
		const root = mkdtempSync(join(tmpdir(), "two-phase-repo-"));
		roots.push(root);
		writeScenarioDir(twoPhaseArtifact(), root);
		expect(readScenarioAt(join(root, "two-phase"))).toBeDefined();
	});

	it("round-trips through the repository the launcher writes with", () => {
		// `writeScenario` goes to the *configured* scenario root, which defaults to the one in the
		// repository — so this has to redirect it. Without that, running the suite committed a
		// scenario into `.scenarios/`, which is exactly the accident this notices.
		const root = mkdtempSync(join(tmpdir(), "two-phase-root-"));
		roots.push(root);
		const previous = process.env.AUTO_ADVENTURE_SCENARIOS;
		process.env.AUTO_ADVENTURE_SCENARIOS = root;
		try {
			expect(readScenarioAt(writeScenario(twoPhaseArtifact()))?.id).toBe("two-phase");
		} finally {
			if (previous === undefined) delete process.env.AUTO_ADVENTURE_SCENARIOS;
			else process.env.AUTO_ADVENTURE_SCENARIOS = previous;
		}
	});
});
