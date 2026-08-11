import { describe, expect, it } from "vitest";
import { demoArtifact, demoJourneyArtifact, demoSiteSpec } from "../../test/fixtures/scenario.js";
import { hashString } from "../core/rand/hash.js";
import { signBoard } from "../core/rules/signage.js";
import { hasFlag, TFlag } from "../core/tiles/flags.js";
import { terrainDef } from "../core/tiles/terrain.js";
import { boundsAround, isWellInside } from "../core/world/bounds.js";
import type { MacroSite } from "../core/world/macro.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { isPassable, terrainOf } from "./passability.js";
import { signpostsFor } from "./signposts.js";
import { buildPassability, siteIndex, validateArtifact } from "./validate.js";

/**
 * Where the boards go.
 *
 * Generating the bounded world is what this measures against and it is slow by nature, so
 * the artifact and its grid are built once and every assertion is made against the same
 * derivation — which also proves the derivation is a function of the world rather than of
 * the order the questions are asked in.
 */
const SLOW = { timeout: 120_000 };

const ARTIFACT = demoJourneyArtifact();
const GRID = buildPassability(ARTIFACT);
const SITES = siteIndex(ARTIFACT);
const PLAN = signpostsFor(ARTIFACT, GRID, SITES);

describe("signposts on the way out", SLOW, () => {
	it("puts up a board for the journey the story asks for", () => {
		expect(PLAN.signs.length).toBeGreaterThan(0);
		const beats = ARTIFACT.arc?.beats ?? [];
		const destination = beats[1]?.siteId;
		expect(PLAN.signs.some((sign) => sign.arms.some((arm) => arm.siteId === destination))).toBe(
			true,
		);
	});

	/*
	 * The one the opening needs. A player who has just read the framing card is standing on a
	 * road with two ends and nothing to choose between them, and the errand's own marker does
	 * not exist yet — `questMarks` only marks chunks in `discovered`. So the first board has
	 * to be somewhere they walk past on the way out, not at the far end of the journey.
	 */
	it("stands the first one on the way out of where the player wakes up", () => {
		const first = ARTIFACT.arc?.beats[0]?.siteId;
		const home = SITES.get(first as number);
		expect(home).toBeDefined();
		const board = PLAN.signs[0];
		expect(board, "no board at all").toBeDefined();
		const away = Math.hypot((board?.x ?? 0) - ARTIFACT.spawn.x, (board?.y ?? 0) - ARTIFACT.spawn.y);
		// Outside the town it leaves, and inside the distance somebody walking out of it
		// covers before they have had to guess. `OUT_OF_TOWN.to` plus the verge reach.
		expect(away).toBeGreaterThan(0);
		expect(away).toBeLessThanOrEqual((home?.radius ?? 0) + 28);
	});

	/*
	 * The bug this found: the spawn is usually *inside* a town, because `findSpawn` prefers a
	 * chunk with one in its halo. Treated as an origin in its own right it produced a board
	 * three tiles from the player pointing at the town they were standing in — which is the
	 * one thing a board must never say.
	 */
	it("never points at the place the player is already standing in", () => {
		const first = ARTIFACT.arc?.beats[0]?.siteId;
		for (const sign of PLAN.signs) {
			const home = SITES.get(first as number);
			if (!home) continue;
			const inTown = Math.hypot(home.site.x - sign.x, home.site.y - sign.y) <= home.radius + 28;
			if (!inTown) continue;
			expect(
				sign.arms.some((arm) => arm.siteId === first),
				sign.id,
			).toBe(false);
		}
	});

	/*
	 * A post is read by *facing* it, so one on ground nobody can stand on is a promise
	 * attached to a bare tile: `stampSigns` declines to put it up and the player finds
	 * nothing there. The generator's own guard is the floor under this; the point of
	 * checking here is that the derivation never relies on it.
	 */
	it("only ever chooses ground somebody could stand on and get in front of", () => {
		for (const sign of PLAN.signs) {
			expect(isWellInside(ARTIFACT.bounds, sign.x, sign.y), sign.id).toBe(true);
			expect(isPassable(GRID, sign.x, sign.y), sign.id).toBe(true);
			const ways = [
				[0, -1],
				[1, 0],
				[0, 1],
				[-1, 0],
			].filter(([dx, dy]) => isPassable(GRID, sign.x + (dx as number), sign.y + (dy as number)));
			expect(ways.length, `${sign.id} is in a corner`).toBeGreaterThanOrEqual(3);
		}
	});

	/*
	 * Not on the road, because a post is drawn over whatever the tile is and one planted on
	 * cobbles reads as a hole in the road. It is still walkable either way — decor takes no
	 * passability away outdoors — so this is about how it looks and not about blocking.
	 */
	it("stands on the verge rather than in the middle of the track", () => {
		for (const sign of PLAN.signs) {
			const terrain = terrainOf(GRID, sign.x, sign.y);
			expect(terrain, sign.id).toBeDefined();
			expect(hasFlag(terrainDef(terrain as number).flags, TFlag.Road), sign.id).toBe(false);
		}
	});

	/*
	 * `demoJourneyArtifact` (used by every other test in this file) yields exactly ONE
	 * signpost: the spawn sits exactly on the first town, so it becomes the origin rather
	 * than a leg in its own right, and there is only the one leg onward. So this test used
	 * to reduce to `1 === 1` against `PLAN` above and would have stayed green with `taken`
	 * deleted from `signposts.ts` entirely — the tile-dedupe mechanism it claims to check.
	 *
	 * Fixed with two origins built to *force* the collision rather than hope a procedural
	 * world happens to produce one: two towns 24 tiles apart, radius 10 each, one leg out
	 * and one leg back, so each stands its board on the way toward the other along the
	 * same line. `OUT_OF_TOWN` starts each search at `radius + 2` tiles out — 12 for
	 * both — so the two searches start from the *same* point on that line and, without
	 * the guard, resolve to the identical tile: confirmed empirically (see the fix's
	 * report) by running this exact fixture with `taken.add` commented out, which gives
	 * two identical coordinates rather than two distinct ones. Revisiting the first town
	 * also gives it two arms (to the second town, then to a third), exercising the
	 * grouping at `signposts.ts:102` the single-leg fixture above never reaches either.
	 *
	 * Built from fabricated `MacroSite`s rather than real ones precisely because organic
	 * settlement placement does not reliably put two towns this close together — a sweep
	 * over several seeds' nearest settlements got as near as *adjacent* tiles and no
	 * closer, which is why the mechanism needs to be forced to be tested at all.
	 */
	it("never stands two posts on one tile", () => {
		const fabricate = (id: number, x: number, y: number, radius: number): MacroSite => ({
			id,
			mx: id,
			my: id,
			site: { x, y },
			kind: "hamlet",
			importance: 1,
			radius,
			regionId: 0,
		});

		// Far from the origin, so nothing here is near any site a real seed would place.
		const a = fabricate(900_001, 4000, 4000, 10);
		const b = fabricate(900_002, 4024, 4000, 10);
		const c = fabricate(900_003, 6000, 6000, 12);
		const named = (site: MacroSite, name: string) => {
			const spec = demoSiteSpec(site.id);
			return { ...spec, name, shortName: name, settlement: { ...spec.settlement, name } };
		};

		const forced = demoArtifact({
			seed: hashString("signpost-forced-collision"),
			spawn: { x: a.site.x, y: a.site.y },
			// Only wide enough to cover where a board could actually stand (within radius +
			// `OUT_OF_TOWN.to` + a verge reach of either town, ~40 tiles) — `c` is never
			// searched geometrically, only referenced by id, so it does not need to be inside
			// bounds. Kept small deliberately: `buildPassability` over a much wider area
			// (2400, tried first) took over a minute for this one test.
			bounds: boundsAround(a.site, 150, { style: "cliffs", thickness: 6 }),
			sites: {
				[String(a.id)]: named(a, "Aldermoor"),
				[String(b.id)]: named(b, "Bellhaven"),
				[String(c.id)]: named(c, "Candlemere"),
			},
			arc: {
				title: "The Three-Cornered Errand",
				premise: "One town sends the player out, calls them back, and sends them on again.",
				beats: [
					{
						id: "beat-a",
						order: 0,
						siteId: a.id,
						npcSlot: 0,
						requires: [],
						setsFlag: "arc:beat-a",
						journal: "Word at Aldermoor is to start at Bellhaven.",
					},
					{
						id: "beat-b",
						order: 1,
						siteId: b.id,
						npcSlot: 0,
						requires: ["arc:beat-a"],
						setsFlag: "arc:beat-b",
						journal: "Bellhaven sends word back to Aldermoor.",
					},
					{
						id: "beat-a2",
						order: 2,
						siteId: a.id,
						npcSlot: 0,
						requires: ["arc:beat-b"],
						setsFlag: "arc:beat-a2",
						journal: "Aldermoor, again, points onward to Candlemere.",
					},
					{
						id: "beat-c",
						order: 3,
						siteId: c.id,
						npcSlot: 0,
						requires: ["arc:beat-a2"],
						setsFlag: "arc:beat-c",
						journal: "Candlemere is the last of it.",
					},
				],
			},
		});

		const grid = buildPassability(forced);
		// `siteIndex` only returns sites a real world seed actually placed at that cell, and
		// none of these fabricated ids are one — so the fabricated `MacroSite`s themselves
		// are what `signpostsFor` is given, exactly as a real `sites` map would hand them in.
		const sites = new Map<number, MacroSite>([
			[a.id, a],
			[b.id, b],
			[c.id, c],
		]);
		const plan = signpostsFor(forced, grid, sites);

		// Two real origins — Aldermoor (two arms, to Bellhaven and Candlemere) and
		// Bellhaven (one arm, back to Aldermoor) — so this is a genuine dedupe check
		// rather than a single sign compared against itself.
		expect(plan.signs.length).toBe(2);
		const tiles = plan.signs.map((sign) => `${sign.x},${sign.y}`);
		expect(new Set(tiles).size).toBe(tiles.length);
	});

	/*
	 * The whole artifact has to be reproducible from its seed and its brief, so a derivation
	 * that picked at random would make two runs of the same input two different worlds.
	 */
	it("chooses the same tiles every time it is asked", () => {
		const again = signpostsFor(ARTIFACT, buildPassability(ARTIFACT), siteIndex(ARTIFACT));
		expect(again.signs).toEqual(PLAN.signs);
	});

	it("says something readable once it is read against the world", () => {
		const sign = PLAN.signs[0];
		expect(sign).toBeDefined();
		const board = signBoard(sign as NonNullable<typeof sign>, {
			nameOf: (siteId) => ARTIFACT.sites[String(siteId)]?.shortName,
			positionOf: (siteId) => SITES.get(siteId)?.site,
		});
		expect(board).toContain("Aldermoor");
		expect(board).toMatch(/to the (north|south|east|west)/);
	});

	it("points at nowhere the story does not go", () => {
		const visited = new Set((ARTIFACT.arc?.beats ?? []).map((beat) => beat.siteId));
		for (const sign of PLAN.signs) {
			for (const arm of sign.arms) expect(visited.has(arm.siteId), sign.id).toBe(true);
		}
	});

	it("has nothing to put up for a world with no story in it", () => {
		const storyless = demoJourneyArtifact({ arc: undefined });
		expect(signpostsFor(storyless, GRID, SITES).signs).toEqual([]);
	});

	/*
	 * A board the validator objects to is a board that was derived wrong, and the derivation
	 * is what puts every one of them in a generated world — so the two must agree by
	 * construction rather than by having been checked once by hand.
	 */
	it("produces boards the validator has nothing to say about", () => {
		const signed = { ...ARTIFACT, signs: PLAN.signs };
		const complaints = validateArtifact(signed)
			.map((finding) => finding.message)
			.filter((message) => message.includes("signpost"));
		expect(complaints).toEqual([]);
	});

	it("works out its bearings against the world the artifact was written for", () => {
		// Not an assertion about signage so much as about the recipe travelling with it: a
		// board resolved against the wrong world would point at a town that is not there.
		expect(artifactWorld(ARTIFACT).seed).toBe(ARTIFACT.seed);
	});
});

/**
 * A board somebody put in a scenario file by hand.
 *
 * The derivation above cannot produce any of these, which is the point of it — but a
 * hand-written scenario can, and the two ways a signpost fails are both silent. It stands
 * where nobody can get in front of it, so no post goes up and the tile is bare ground with a
 * promise attached; or an arm names a place that is not here, so the arm is quietly left off
 * and the board says less than it claims to.
 */
describe("a board that will not work", SLOW, () => {
	function complaints(signs: ScenarioArtifact["signs"]): string[] {
		return validateArtifact({ ...ARTIFACT, signs })
			.filter((finding) => finding.message.includes("signpost"))
			.map((finding) => finding.message);
	}

	const arm = { siteId: ARTIFACT.arc?.beats[1]?.siteId as number };

	it("is reported when it stands in the band closing the world", () => {
		const found = complaints([{ id: "s", x: ARTIFACT.bounds.minX + 1, y: 0, arms: [arm] }]);
		expect(found.join(" ")).toContain("outside the world");
	});

	it("is reported when an arm points at a place this scenario does not have", () => {
		const board = PLAN.signs[0] as NonNullable<(typeof PLAN.signs)[number]>;
		const found = complaints([{ ...board, arms: [{ siteId: 999_999 }] }]);
		expect(found.join(" ")).toContain("not in this scenario");
	});

	it("is reported when two posts claim one tile", () => {
		const board = PLAN.signs[0] as NonNullable<(typeof PLAN.signs)[number]>;
		const found = complaints([board, { ...board, id: "other" }]);
		expect(found.join(" ")).toContain("same tile");
	});

	/*
	 * Never an error, however wrong. A missing signpost is a world that is harder to follow
	 * and never a world that cannot be finished, and refusing a scenario over a convenience
	 * after several paid minutes would turn a blemish into a total loss.
	 */
	it("is never bad enough to refuse the world over", () => {
		const severities = validateArtifact({
			...ARTIFACT,
			signs: [{ id: "s", x: ARTIFACT.bounds.minX + 1, y: 0, arms: [{ siteId: 999_999 }] }],
		})
			.filter((finding) => finding.message.includes("signpost"))
			.map((finding) => finding.severity);
		expect(severities.length).toBeGreaterThan(0);
		expect(severities).not.toContain("error");
	});
});
