import { describe, expect, it } from "vitest";
import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import { generateFeature, invalidateFeature } from "../core/gen/features/registry.js";
import { sitePlots } from "../core/gen/features/settlement.js";
import { hashString } from "../core/rand/hash.js";
import { isBoundary, isWellInside } from "../core/world/bounds.js";
import { buildingBudget } from "../core/world/context.js";
import { CHUNK } from "../core/world/coords.js";
import { isSettlement, macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { overlapBy } from "../core/world/spacing.js";
import {
	DURATION_PLAN,
	planFor,
	sitesWithin,
	solveBounds,
	storySites,
	styleForEdge,
	surveyWorld,
} from "./survey.js";

const SEEDS = ["survey-a", "survey-b", "survey-c"].map(hashString);
const SEED = SEEDS[0] as number;

describe("planFor", () => {
	it("scales beats and extent together", () => {
		// In a bounded world narrative length and spatial extent are the same knob.
		expect(planFor("short").beats).toBeLessThan(planFor("long").beats);
		expect(planFor("short").radiusChunks).toBeLessThan(planFor("long").radiusChunks);
	});

	it("defaults to medium", () => {
		expect(planFor(undefined)).toEqual(DURATION_PLAN.medium);
	});
});

describe("solveBounds", () => {
	it("finds a boundary that cuts no settlement in half", () => {
		// The constraint that keeps a town from being half swallowed by a cliff face.
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "short", undefined);
			for (const entry of survey.sites) {
				if (!entry.settlement) continue;
				const { x, y } = entry.site.site;
				const reach = entry.site.radius;
				// Every extreme of the footprint agrees it is playable.
				for (const point of [
					{ x, y },
					{ x: x - reach, y },
					{ x: x + reach, y },
					{ x, y: y - reach },
					{ x, y: y + reach },
				]) {
					expect(
						isWellInside(survey.bounds, point.x, point.y),
						`${entry.site.kind} ${entry.site.id} of seed ${seed} straddles the band`,
					).toBe(true);
				}
			}
		}
	});

	it("stays near the radius it was asked for", () => {
		// It may move to find a gap, but a "short" scenario must not come out long.
		const { bounds, adjustment } = solveBounds(
			worldSeed(SEED),
			{ x: 0, y: 0 },
			4 * CHUNK,
			"cliffs",
		);
		expect(Math.abs(adjustment)).toBeLessThanOrEqual(CHUNK);
		expect(bounds.maxX - bounds.minX).toBeGreaterThan(4 * CHUNK);
	});

	it("keeps the requested style", () => {
		expect(solveBounds(worldSeed(SEED), { x: 0, y: 0 }, 256, "ocean").bounds.style).toBe("ocean");
	});
});

describe("styleForEdge", () => {
	it("picks a style the ground can carry", () => {
		// Never invents a fourth style, and never rings dry land in open sea without
		// the sea being there.
		for (const seed of SEEDS) {
			const style = styleForEdge(worldSeed(seed), { x: 0, y: 0 }, 256);
			expect(["ocean", "cliffs", "mountains"]).toContain(style);
		}
	});
});

describe("sitesWithin", () => {
	it("is deterministic and ordered independently of who asked", () => {
		const bounds = solveBounds(worldSeed(SEED), { x: 0, y: 0 }, 256, "cliffs").bounds;
		const once = sitesWithin(worldSeed(SEED), bounds).map((site) => site.id);
		const twice = sitesWithin(worldSeed(SEED), bounds).map((site) => site.id);
		expect(twice).toEqual(once);
	});

	it("finds more when asked to look wider", () => {
		const bounds = solveBounds(worldSeed(SEED), { x: 0, y: 0 }, 256, "cliffs").bounds;
		expect(sitesWithin(worldSeed(SEED), bounds, CHUNK).length).toBeGreaterThanOrEqual(
			sitesWithin(worldSeed(SEED), bounds).length,
		);
	});
});

describe("surveyWorld", () => {
	it("spawns somewhere the boundary cannot reach", () => {
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "short", undefined);
			expect(isWellInside(survey.bounds, survey.spawn.x, survey.spawn.y)).toBe(true);
			expect(isBoundary(seed, survey.bounds, survey.spawn.x, survey.spawn.y)).toBe(false);
		}
	});

	it("reports only sites inside the playable area", () => {
		const survey = surveyWorld(worldSeed(SEED), "medium", undefined);
		for (const entry of survey.sites) {
			expect(isWellInside(survey.bounds, entry.site.site.x, entry.site.site.y)).toBe(true);
		}
	});

	it("orders sites by how far they are from the start", () => {
		// The arc prompt relies on this to plot a story that travels outward.
		const survey = surveyWorld(worldSeed(SEED), "medium", undefined);
		const distances = survey.sites.map((entry) => entry.distanceFromSpawn);
		expect([...distances].sort((a, b) => a - b)).toEqual(distances);
	});

	it("finds a region context for every region its sites are in", () => {
		const survey = surveyWorld(worldSeed(SEED), "medium", undefined);
		const needed = new Set(survey.sites.map((entry) => entry.site.regionId));
		const found = new Set(survey.regions.map((region) => region.regionId));
		for (const id of needed) expect(found.has(id)).toBe(true);
	});

	it("carries the building budget the engine will actually honour", () => {
		// It used to assert every budget was above zero, which was true only because the
		// budget was arithmetic on a radius and arithmetic never returns nothing. Now that it
		// counts real plots, a site the sea or the slope leaves no room on reports zero — and
		// that is the honest answer, not a regression. What this test is for is that the
		// survey carries the engine's number rather than one of its own.
		const survey = surveyWorld(worldSeed(SEED), "short", undefined);
		for (const entry of survey.sites) {
			expect(entry.context.buildingBudget).toBe(buildingBudget(survey.world, entry.site));
			expect(entry.context.siteId).toBe(entry.site.id);
		}
	});

	it("gives a longer scenario a bigger world and more to do", () => {
		const short = surveyWorld(worldSeed(SEED), "short", undefined);
		const long = surveyWorld(worldSeed(SEED), "long", undefined);
		expect(long.bounds.maxX - long.bounds.minX).toBeGreaterThan(
			short.bounds.maxX - short.bounds.minX,
		);
		expect(long.sites.length).toBeGreaterThan(short.sites.length);
	});

	it("is deterministic", () => {
		expect(surveyWorld(worldSeed(SEED), "short", undefined).bounds).toEqual(
			surveyWorld(worldSeed(SEED), "short", undefined).bounds,
		);
	});

	/*
	 * The smallest size, which is not for playing.
	 *
	 * It exists so a change to the pipeline can be tried without paying for a world
	 * somebody wanted to keep, and that only works if it reliably produces a world with
	 * a story in it. A radius small enough to be cheap is also small enough to enclose
	 * one settlement, or none — at which point the arc pass reports "no story could be
	 * plotted", every later pass carries on regardless, and the run has tested nothing.
	 */
	describe("a world small enough to throw away", () => {
		// More seeds than the rest of this file uses, because the property being asserted
		// is exactly the one that holds for most seeds and used to fail for the rest.
		const MANY = [
			"tiny-a",
			"tiny-b",
			"tiny-c",
			"tiny-d",
			"tiny-e",
			"tiny-f",
			"tiny-g",
			"tiny-h",
		].map(hashString);

		it("finds a story on all but the barest seeds", () => {
			// The claim that decides whether the size is worth offering. Left at its own
			// radius most seeds enclose one settlement or none, and a test world that
			// usually comes out storyless is a worse way to exercise the pipeline than
			// paying for a short one — so this is what the growing is for, and it fails
			// loudly if the growing stops working.
			//
			// Not *every* seed, and the exception is honest rather than a fudge: a corner
			// of the world with no settlement inside the largest rectangle this size is
			// allowed has nothing to offer, and no amount of logic invents one.
			const withStory = MANY.filter(
				(seed) => storySites(surveyWorld(worldSeed(seed), "tiny", undefined)).length >= 2,
			);
			expect(withStory.length).toBeGreaterThanOrEqual(MANY.length - 1);
		});

		it("never grows past the size it was chosen to be cheaper than", () => {
			// Measured, not assumed: a real run grew a `tiny` world to 670 tiles — wider
			// than `short` — and produced twenty people to write conversations for. The
			// cheap size had quietly become the expensive one.
			for (const seed of MANY) {
				const tiny = surveyWorld(worldSeed(seed), "tiny", undefined);
				const widest = DURATION_PLAN.short.radiusChunks * CHUNK * 2 + 2 * CHUNK;
				expect(tiny.bounds.maxX - tiny.bounds.minX, `seed ${seed}`).toBeLessThanOrEqual(widest);
			}
		});

		it("stays smaller than a short world wherever the ground allows", () => {
			// Not "always smaller": a sparse corner has to be grown until it holds a
			// story, and on a seed where `short` was already the answer the two meet. What
			// must hold is that the usual case is genuinely cheaper.
			const smaller = MANY.filter((seed) => {
				const tiny = surveyWorld(worldSeed(seed), "tiny", undefined);
				const short = surveyWorld(worldSeed(seed), "short", undefined);
				return tiny.sites.length < short.sites.length;
			});
			expect(smaller.length).toBeGreaterThan(MANY.length / 2);
		});
	});

	it("finds settlements a story could be hung on", () => {
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "medium", undefined);
			const story = storySites(survey);
			expect(story.length).toBeGreaterThan(0);
			for (const entry of story) expect(isSettlement(entry.site.kind)).toBe(true);
		}
	});
});

/**
 * The three kinds that refuse unsuitable ground, and what the survey owes them.
 *
 * `castle`, `cave` and `docks` build *nothing* rather than compromise — an empty patch
 * on ground with no level square, no hillside or no shoreline. Every later authoring
 * pass takes the survey's site list as a list of real places, so a declined site that
 * survives this far becomes a named castle with people posted to it standing in an
 * empty field. `validate.ts` calls that an error; a world generated with nobody watching
 * has no one to read it.
 */
describe("a world with landmarks asked for", () => {
	/** Weights high enough that some cells are certain to roll onto bad ground. */
	const LANDMARKS = {
		sites: { weights: { castle: 4, cave: 4, docks: 4 }, wildWeights: { cave: 4 } },
	};

	it("reports every site it dropped, so a fruitless recipe is visible", () => {
		// Some seed in this set declines something: caves want a hillside and docks want a
		// shore, and at this weight the roll finds ground that has neither.
		const surveys = SEEDS.map((seed) =>
			surveyWorld(worldSeed(seed, LANDMARKS), "medium", undefined),
		);
		const dropped = surveys.reduce(
			(total, survey) => total + Object.values(survey.declined).reduce((a, b) => a + b, 0),
			0,
		);
		expect(dropped, "no seed declined anything; the filter is untested").toBeGreaterThan(0);
	});

	it("keeps nothing that the generator would refuse to build", () => {
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed, LANDMARKS), "medium", undefined);
			for (const entry of survey.sites) {
				// Rebuilt here rather than trusting the survey's own answer, so this fails if
				// the filter is removed rather than merely agreeing with itself.
				invalidateFeature(survey.world, entry.site.id);
				const patch = generateFeature(
					survey.world,
					entry.site,
					fallbackSettlementSpec(survey.world, entry.site),
				);
				invalidateFeature(survey.world, entry.site.id);
				if (!patch) continue;
				// A settlement has to have a *building*. Every settlement emits a square and a
				// well before it places anything, so counting anchors let a town with nothing
				// in it through: it was named, peopled and given story beats, and the only
				// symptom on the map was a field with a signpost.
				const built = entry.settlement
					? patch.buildings.length
					: patch.buildings.length + patch.anchors.length;
				expect(
					built,
					`${entry.site.kind} at ${entry.site.site.x},${entry.site.site.y} builds nothing`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("still finds the settlements, having filtered the landmarks", () => {
		// The filter must not be able to empty the world: a survey with no settlement in it
		// is a scenario with nowhere to put a story.
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed, LANDMARKS), "medium", undefined);
			expect(storySites(survey).length).toBeGreaterThan(0);
		}
	});

	it("declines nothing in a default world but the settlements with no room at all", () => {
		// This used to assert that a default world declined *nothing*, on the grounds that
		// nothing in the default ladder can refuse its ground. That stopped being true when a
		// settlement was made to prove it can build a building rather than merely an anchor —
		// and the hamlet this now drops is the whole reason for the change, not a casualty of
		// it. What still holds is that the landmark filter is invisible here: whatever a
		// default world declines is a settlement that could not build.
		for (const seed of SEEDS) {
			const { declined } = surveyWorld(worldSeed(seed), "medium", undefined);
			for (const kind of Object.keys(declined)) {
				expect(isSettlement(kind as never), `${kind} was declined in a default world`).toBe(true);
			}
		}
	});

	it("grows a site whose ground holds less than its roster asks for", () => {
		// The fix at source. Without it the model is told to write eight buildings for a town
		// with four plots, and four of them quietly become filler — the substitution the
		// placement solver exists to prevent, arriving before the solver ever sees it.
		const plain = worldSeed(SEED);
		const survey = surveyWorld(plain, "short", undefined);
		const grown = Object.keys(survey.grown);
		expect(grown.length, "nothing grew, so this test asserts nothing").toBeGreaterThan(0);

		for (const id of grown) {
			const after = survey.sites.find((entry) => String(entry.site.id) === id)?.site;
			expect(after, `grew ${id} and then dropped it`).toBeDefined();
			if (!after) continue;
			const before = macroSite(plain, after.mx, after.my);
			expect(after.radius).toBe(survey.grown[id]);
			expect(after.radius).toBeGreaterThan(before.radius);
			// Bigger for a reason: the point is plots, not tiles.
			expect(sitePlots(survey.world, after).length).toBeGreaterThan(
				sitePlots(plain, before).length,
			);
			// And everything the story keys on is where it was, which is what makes growing
			// a site safe rather than a reshuffle of the map.
			expect([after.id, after.regionId, after.kind, after.site]).toEqual([
				before.id,
				before.regionId,
				before.kind,
				before.site,
			]);
		}
	});

	it("will not grow a site into its neighbour", () => {
		// Growth is bounded by the same predicate the validator reports overlaps with, so the
		// generator cannot produce, on one run, a world its own checker complains about.
		// Asserted of the grown sites only: two rolled sites can already stand closer than
		// their radii, which is ordinary and not growth's doing.
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "medium", undefined);
			for (const id of Object.keys(survey.grown)) {
				const grown = survey.sites.find((entry) => String(entry.site.id) === id)?.site;
				if (!grown) continue;
				for (const other of sitesWithin(survey.world, survey.bounds, CHUNK)) {
					if (other.id === grown.id) continue;
					expect(
						overlapBy(
							{ at: grown.site, radius: grown.radius },
							{ at: other.site, radius: other.radius },
						),
						`grew ${grown.kind} ${grown.id} into ${other.kind} ${other.id}`,
					).toBeLessThanOrEqual(0);
				}
			}
		}
	});

	it("keeps a grown site in the recipe, so the world survives being reloaded", () => {
		// Growth that lived only in the survey would be a town that shrank the next time the
		// artifact was opened, with every placement written against the larger one.
		const survey = surveyWorld(worldSeed(SEED), "short", undefined);
		expect(survey.places.length).toBeGreaterThan(0);

		const reloaded = worldSeed(SEED, { places: survey.places });
		for (const [id, radius] of Object.entries(survey.grown)) {
			const site = survey.sites.find((entry) => String(entry.site.id) === id)?.site;
			if (!site) continue;
			expect(macroSite(reloaded, site.mx, site.my).radius).toBe(radius);
		}
	});

	it("does not grow a world it has already grown", () => {
		// Surveying an artifact again — the validator does, and so does every reload — must
		// not make its towns bigger a second time. The ceiling is measured against what the
		// recipe says the kind is worth, never against the site's current size, and this is
		// what says so.
		const first = surveyWorld(worldSeed(SEED), "short", undefined);
		expect(Object.keys(first.grown).length).toBeGreaterThan(0);

		const again = surveyWorld(first.world, "short", { places: first.places });
		expect(again.grown).toEqual({});
		expect(again.sites.map((entry) => entry.site.radius)).toEqual(
			first.sites.map((entry) => entry.site.radius),
		);
	});

	it("drops a site the ground will not let build anything", () => {
		// The todo.txt case: a town with no buildings at all, named and peopled and given
		// story beats. Growing comes first and rescues most of them; what survives that is
		// ground that cannot hold a single 5x5 plot however big the footprint gets, and the
		// only honest thing left is not to name it.
		let checked = 0;
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "medium", undefined);
			for (const entry of survey.sites) {
				if (!entry.settlement) continue;
				expect(
					sitePlots(survey.world, entry.site).length,
					`${entry.site.kind} at ${entry.site.site.x},${entry.site.site.y} has nowhere to build`,
				).toBeGreaterThan(0);
				checked++;
			}
		}
		expect(checked, "no settlement was surveyed, so nothing was checked").toBeGreaterThan(5);
	});
});
