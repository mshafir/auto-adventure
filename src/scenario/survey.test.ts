import { describe, expect, it } from "vitest";
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
