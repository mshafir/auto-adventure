import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npcId } from "../core/world/spec.js";
import { buildSession } from "../session.js";
import { readScenarioFile, scenarioPath } from "./repo.js";
import { siteIndex } from "./validate.js";
import { storyWalker } from "./walker.js";

/**
 * The primitives, on their own.
 *
 * `walk.test.ts` asserts that two shipped stories reach their endings, which is the claim
 * worth having and a poor way to find out *which* primitive broke: every one of them fails
 * through a whole walk as "a beat never opened". These three are the properties that were
 * learned the hard way — leaving a room before travelling, opening a door to find whoever is
 * behind it, and admitting when nobody is there.
 *
 * Each was confirmed able to fail by disabling the primitive it names and watching this file
 * go red, which is worth saying because two of them run through so much of the engine that
 * they would pass on almost any world.
 */

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "auto-adventure-walker-"));
	process.env.AUTO_ADVENTURE_HOME = home;
});

afterEach(() => {
	delete process.env.AUTO_ADVENTURE_HOME;
	rmSync(home, { recursive: true, force: true });
});

function walkerFor(name: string) {
	const artifact = readScenarioFile(scenarioPath(name));
	if (!artifact) throw new Error(`${name} did not load`);
	const sites = siteIndex(artifact);
	const session = buildSession(
		{ worldId: `walker-${name}`, seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0, persist: false },
	);
	session.engine.dispatch({ t: "DismissCard" });
	return { artifact, sites, session, walker: storyWalker(artifact, session.engine, sites) };
}

describe("the story walker", { timeout: 60_000 }, () => {
	it("stands the player in the town it was sent to, out of doors", () => {
		// The failure this pins is silent and total: indoors the player's coordinates are
		// interior-local and the reducer asks which place they are in about the doorstep they
		// came in by, so a walker that teleports without leaving is reported as standing in the
		// last town it was inside, forever — and a `reach` objective for the town it is
		// actually standing in never ticks.
		const { artifact, sites, session, walker } = walkerFor("thornwick-road");
		const written = [...sites.values()].filter((site) => artifact.sites[String(site.id)]);
		expect(written.length, "no site in this scenario was written about").toBeGreaterThan(1);

		// Go somewhere, go indoors there, then go somewhere else: the second `goTo` is the one
		// that used to leave the player believing they were still in the first town.
		const [first, second] = written as [(typeof written)[0], (typeof written)[0]];
		walker.goTo(first);
		const room = walker.buildingsOf(first.id)[0];
		expect(room, "the first town built nothing to walk into").toBeDefined();
		if (!room) return;
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: room.door.x, y: room.door.y + 1 }],
		});
		session.engine.dispatch({ t: "Move", facing: "up" });
		session.engine.dispatch({ t: "Move", facing: "up" });

		walker.goTo(second);
		expect(session.engine.getState().player.inside).toBeUndefined();
		expect(
			Math.hypot(
				session.engine.getState().player.x - second.site.x,
				session.engine.getState().player.y - second.site.y,
			),
			"the walker did not end up standing in the town it was sent to",
		).toBeLessThan(2);
		session.dispose();
	});

	it("finds somebody the scenario put in a room, by going in and looking", async () => {
		// An indoor character resolves only while the player stands in their building, which is
		// correct — and means a walker that never opens a door reports every one of them as
		// missing.
		//
		// The porter first, and that is the test rather than setup. There is exactly one indoor
		// character in either shipped scenario — the Lady of Hautdesert — and she stands in a
		// bower inside a castle whose gate is barred until the porter has taken the player's
		// name in. So she is unreachable cold, by design, and the full walk only reaches her
		// because it has spoken to him by then. Doing the same here exercises both paths in the
		// order a player takes them: somebody standing in the open, then somebody behind a door
		// that a conversation opened.
		const { artifact, sites, session, walker } = walkerFor("green-chapel");
		const indoors = Object.values(artifact.sites).flatMap((spec) =>
			spec.npcs.filter((npc) => npc.indoors).map((npc) => ({ spec, npc })),
		);
		const wanted = indoors[0];
		expect(
			indoors.length,
			"green-chapel no longer has exactly one indoor character; this test was written around that",
		).toBe(1);
		if (!wanted) return;

		const site = sites.get(wanted.spec.siteId);
		expect(site).toBeDefined();
		if (!site) return;
		walker.goTo(site);

		// Whoever the gate to this place opens on. Read out of the artifact rather than
		// hard-coded, so a re-authored porter does not silently turn this into a test of
		// nothing.
		const gate = (artifact.barriers ?? []).find((barrier) =>
			JSON.stringify(barrier.opensWhen ?? {}).includes(String(wanted.spec.siteId >>> 0)),
		);
		const porter = JSON.stringify(gate?.opensWhen ?? {}).match(/npc:\d+:(\d+)/);
		expect(
			porter,
			"nothing gates the way in, so the Lady should have been reachable cold",
		).not.toBeNull();
		if (!porter) return;
		expect(await walker.talkTo(npcId(wanted.spec.siteId, Number(porter[1])))).toBe(true);

		// And the bower's own door, which is latched until the covenant is made. Two locks
		// between the start and this room, both of them the scenario working as written.
		session.engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "SetFlag", key: "arc:the-exchange-of-winnings", value: true }],
		});

		const id = npcId(wanted.spec.siteId, wanted.npc.slot);
		const spoke = await walker.talkTo(id, walker.roomOf(wanted.spec.siteId, wanted.npc.slot));
		expect(spoke, `${wanted.npc.name} could not be found indoors`).toBe(true);
		expect(walker.absent.has(id)).toBe(false);
		session.dispose();
	});

	it("says who it could not find, rather than reporting them as spoken to", async () => {
		// `absent` is the walk's only evidence that a beat's anchor was never placed, and a
		// `talkTo` that returned true for a person who does not exist would turn that into a
		// story reported as walkable and unfinishable in play.
		const { session, walker } = walkerFor("thornwick-road");
		const id = npcId(999_999, 0);
		expect(await walker.talkTo(id)).toBe(false);
		expect(walker.absent.has(id)).toBe(true);
		session.dispose();
	});
});
