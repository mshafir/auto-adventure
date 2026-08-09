import { describe, expect, it } from "vitest";
import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import { generateFeature, invalidateFeature } from "../core/gen/features/registry.js";
import { hashString } from "../core/rand/hash.js";
import { isBoundary, isWellInside } from "../core/world/bounds.js";
import { CHUNK } from "../core/world/coords.js";
import { isSettlement } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
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
			const survey = surveyWorld(worldSeed(seed), "short");
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
			const survey = surveyWorld(worldSeed(seed), "short");
			expect(isWellInside(survey.bounds, survey.spawn.x, survey.spawn.y)).toBe(true);
			expect(isBoundary(seed, survey.bounds, survey.spawn.x, survey.spawn.y)).toBe(false);
		}
	});

	it("reports only sites inside the playable area", () => {
		const survey = surveyWorld(worldSeed(SEED), "medium");
		for (const entry of survey.sites) {
			expect(isWellInside(survey.bounds, entry.site.site.x, entry.site.site.y)).toBe(true);
		}
	});

	it("orders sites by how far they are from the start", () => {
		// The arc prompt relies on this to plot a story that travels outward.
		const survey = surveyWorld(worldSeed(SEED), "medium");
		const distances = survey.sites.map((entry) => entry.distanceFromSpawn);
		expect([...distances].sort((a, b) => a - b)).toEqual(distances);
	});

	it("finds a region context for every region its sites are in", () => {
		const survey = surveyWorld(worldSeed(SEED), "medium");
		const needed = new Set(survey.sites.map((entry) => entry.site.regionId));
		const found = new Set(survey.regions.map((region) => region.regionId));
		for (const id of needed) expect(found.has(id)).toBe(true);
	});

	it("carries the building budget the engine will actually honour", () => {
		const survey = surveyWorld(worldSeed(SEED), "short");
		for (const entry of survey.sites) {
			expect(entry.context.buildingBudget).toBeGreaterThan(0);
			expect(entry.context.siteId).toBe(entry.site.id);
		}
	});

	it("gives a longer scenario a bigger world and more to do", () => {
		const short = surveyWorld(worldSeed(SEED), "short");
		const long = surveyWorld(worldSeed(SEED), "long");
		expect(long.bounds.maxX - long.bounds.minX).toBeGreaterThan(
			short.bounds.maxX - short.bounds.minX,
		);
		expect(long.sites.length).toBeGreaterThan(short.sites.length);
	});

	it("is deterministic", () => {
		expect(surveyWorld(worldSeed(SEED), "short").bounds).toEqual(
			surveyWorld(worldSeed(SEED), "short").bounds,
		);
	});

	it("finds settlements a story could be hung on", () => {
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed), "medium");
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
		const surveys = SEEDS.map((seed) => surveyWorld(worldSeed(seed, LANDMARKS), "medium"));
		const dropped = surveys.reduce(
			(total, survey) => total + Object.values(survey.declined).reduce((a, b) => a + b, 0),
			0,
		);
		expect(dropped, "no seed declined anything; the filter is untested").toBeGreaterThan(0);
	});

	it("keeps nothing that the generator would refuse to build", () => {
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed, LANDMARKS), "medium");
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
				expect(
					patch.buildings.length + patch.anchors.length,
					`${entry.site.kind} at ${entry.site.site.x},${entry.site.site.y} builds nothing`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("still finds the settlements, having filtered the landmarks", () => {
		// The filter must not be able to empty the world: a survey with no settlement in it
		// is a scenario with nowhere to put a story.
		for (const seed of SEEDS) {
			const survey = surveyWorld(worldSeed(seed, LANDMARKS), "medium");
			expect(storySites(survey).length).toBeGreaterThan(0);
		}
	});

	it("leaves a default world with nothing to decline", () => {
		// Nothing in the default ladder can refuse its ground, so the filter should be
		// invisible on every world that existed before landmarks were askable.
		for (const seed of SEEDS) {
			expect(surveyWorld(worldSeed(seed), "medium").declined).toEqual({});
		}
	});
});
