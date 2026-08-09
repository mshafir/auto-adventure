import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import {
	featureKindFor,
	generateFeature,
	invalidateFeature,
} from "../core/gen/features/registry.js";
import { type BoundaryStyle, isWellInside, type WorldBounds } from "../core/world/bounds.js";
import type { Duration } from "../core/world/brief.js";
import type { RegionContext } from "../core/world/context.js";
import { biomeAt, regionContext, type SiteContext, siteContext } from "../core/world/context.js";
import { CHUNK } from "../core/world/coords.js";
import { isSettlement, MACRO, type MacroSite, macroSite } from "../core/world/macro.js";
import type { WorldSeed } from "../core/world/recipe.js";
import { findSpawn } from "../engine/spawn.js";
import { canReach, gridFor, reachableFrom } from "./passability.js";

/**
 * Everything about a world that can be known for free.
 *
 * This pass is why a pre-generated scenario can be better than a live one rather
 * than merely cheaper. The generator is pure and runs offline, so before a single
 * token is spent the tool already knows where every settlement is, how big it is,
 * how many buildings will fit, what the ground is like and how far apart things
 * are. The model is then asked to name and populate a world that has already been
 * measured, which is the same contract `prompt.ts` describes — only now with the
 * whole map in hand instead of one chunk's halo.
 */

export interface DurationPlan {
	readonly beats: number;
	/** Half-width of the playable rectangle, in chunks. */
	readonly radiusChunks: number;
}

/**
 * What each duration means.
 *
 * In a bounded world narrative length and spatial extent are the same knob, so one
 * choice sets both. The numbers are a starting point that `validate.ts` measures
 * rather than trusts.
 */
export const DURATION_PLAN: Readonly<Record<Duration, DurationPlan>> = {
	short: { beats: 3, radiusChunks: 4 },
	medium: { beats: 6, radiusChunks: 6 },
	long: { beats: 10, radiusChunks: 9 },
};

export function planFor(duration: Duration | undefined): DurationPlan {
	return DURATION_PLAN[duration ?? "medium"];
}

export interface SurveyedSite {
	readonly site: MacroSite;
	readonly context: SiteContext;
	/** Tiles from the spawn, straight-line. Orders the story roughly by distance. */
	readonly distanceFromSpawn: number;
	readonly settlement: boolean;
}

export interface Survey {
	/**
	 * The world this survey describes — seed and recipe both.
	 *
	 * A survey is what an artifact is assembled from, so it has to carry the whole of
	 * what produced it. Carrying only the seed would let a scenario be written against
	 * a world with a thick forest and then be played in one without.
	 */
	readonly world: WorldSeed;
	readonly spawn: { readonly x: number; readonly y: number };
	readonly bounds: WorldBounds;
	readonly sites: readonly SurveyedSite[];
	readonly regions: readonly RegionContext[];
	/** How far the boundary had to move to avoid cutting a settlement in half. */
	readonly boundaryAdjustment: number;
	/**
	 * Sites the roll produced and the generator then refused to build, by kind.
	 *
	 * Reported rather than merely dropped so that a recipe asking for six castles in a
	 * world with no level ground says so. Without this the only symptom is a world with
	 * fewer places than asked for, which reads as the weights not working.
	 */
	readonly declined: Readonly<Record<string, number>>;
}

/**
 * Whether the generator will actually build something here.
 *
 * `castle`, `cave` and `docks` decline rather than compromise — a castle with no level
 * ground, a cave with no hillside and a dock with no shoreline each build *nothing* and
 * leave the wilderness as it was. That is the right call for the map and a trap for
 * everything downstream of this survey: the site pass would name the place, the arc pass
 * would set a beat there, and the result is a named castle, with people in it, standing
 * in an empty field.
 *
 * `validate.ts` already catches exactly this and calls it an error for a human to fix.
 * Filtering here is what makes it not happen in the first place, which matters now that
 * a world can be generated with nobody watching.
 *
 * Built with the deterministic roster because the authored one does not exist yet, and
 * dropped again afterwards: `generateFeature` memoises by `(world, kind, siteId)`, so
 * leaving this patch in the cache would mean the real spec is never stamped. The same
 * precaution `checkPlaces` takes, for the same reason.
 */
function buildsSomething(world: WorldSeed, site: MacroSite): boolean {
	if (!featureKindFor(site.kind)) return true;
	try {
		const patch = generateFeature(world, site, fallbackSettlementSpec(world, site));
		return !patch || patch.buildings.length > 0 || patch.anchors.length > 0;
	} finally {
		invalidateFeature(world, site.id);
	}
}

/** How thick to make the band. Enough to read as landform, not as a line. */
const THICKNESS = 8;

/**
 * Whether a site's footprint would be clipped by the band.
 *
 * The check that keeps a town from being half swallowed by a cliff face. A site is
 * either wholly playable or wholly outside; anything in between is a settlement
 * with its plots cut off, and which plots depends on the noise.
 */
function straddles(bounds: WorldBounds, site: MacroSite): boolean {
	const { x, y } = site.site;
	const reach = site.radius;
	// Sample the footprint's extremes rather than every tile: a site is a disc, so
	// if its centre and its four extents agree, the whole thing agrees.
	const points = [
		{ x, y },
		{ x: x - reach, y },
		{ x: x + reach, y },
		{ x, y: y - reach },
		{ x, y: y + reach },
	];
	const inside = points.filter((point) => isWellInside(bounds, point.x, point.y)).length;
	return inside > 0 && inside < points.length;
}

function rectAround(
	centre: { readonly x: number; readonly y: number },
	radiusTiles: number,
	style: BoundaryStyle,
): WorldBounds {
	return {
		minX: centre.x - radiusTiles,
		minY: centre.y - radiusTiles,
		maxX: centre.x + radiusTiles,
		maxY: centre.y + radiusTiles,
		style,
		thickness: THICKNESS,
	};
}

/**
 * Choose a boundary that cuts through nothing.
 *
 * Walks outward from the requested radius, alternating larger and smaller, and
 * takes the first rectangle no settlement straddles. Sites sit roughly one macro
 * cell apart, so a gap is always within half a cell — but if the search somehow
 * exhausts itself the requested radius is returned anyway, and `validate.ts` will
 * report the clipped town rather than the tool silently producing one.
 */
export function solveBounds(
	world: WorldSeed,
	centre: { readonly x: number; readonly y: number },
	radiusTiles: number,
	style: BoundaryStyle,
): { readonly bounds: WorldBounds; readonly adjustment: number } {
	const candidates = (): number[] => {
		const offsets = [0];
		for (let step = 1; step <= MACRO; step++) offsets.push(step, -step);
		return offsets;
	};

	for (const offset of candidates()) {
		const bounds = rectAround(centre, radiusTiles + offset, style);
		const nearby = sitesWithin(world, bounds, MACRO);
		if (!nearby.some((site) => straddles(bounds, site))) {
			return { bounds, adjustment: offset };
		}
	}
	return { bounds: rectAround(centre, radiusTiles, style), adjustment: 0 };
}

/** Every site whose cell falls in or near a rectangle. */
export function sitesWithin(world: WorldSeed, bounds: WorldBounds, margin = 0): MacroSite[] {
	const minMx = Math.floor((bounds.minX - margin) / MACRO);
	const maxMx = Math.floor((bounds.maxX + margin) / MACRO);
	const minMy = Math.floor((bounds.minY - margin) / MACRO);
	const maxMy = Math.floor((bounds.maxY + margin) / MACRO);

	const sites: MacroSite[] = [];
	for (let my = minMy; my <= maxMy; my++) {
		for (let mx = minMx; mx <= maxMx; mx++) {
			const site = macroSite(world, mx, my);
			if (site.kind !== "none") sites.push(site);
		}
	}
	// Stable and independent of who asked, like `sitesAround`.
	sites.sort((a, b) => a.my - b.my || a.mx - b.mx);
	return sites;
}

/**
 * A boundary style that suits the edge it is drawn on.
 *
 * Ringing a desert in ocean reads as a mistake, so the choice follows the ground.
 * Sampled around the perimeter rather than at one point, because an edge can cross
 * several biomes.
 */
export function styleForEdge(
	world: WorldSeed,
	centre: { readonly x: number; readonly y: number },
	radiusTiles: number,
): BoundaryStyle {
	let wet = 0;
	let samples = 0;
	for (let angle = 0; angle < 16; angle++) {
		const radians = (angle / 16) * Math.PI * 2;
		const x = Math.round(centre.x + Math.cos(radians) * radiusTiles);
		const y = Math.round(centre.y + Math.sin(radians) * radiusTiles);
		const biome = biomeAt(world, x, y);
		samples++;
		if (biome === "ocean" || biome === "beach" || biome === "marsh") wet++;
	}
	// Mostly water already: the sea is the honest edge. Otherwise stone, and cliffs
	// rather than mountains unless the land is high enough to carry them.
	if (samples > 0 && wet / samples > 0.4) return "ocean";
	return "cliffs";
}

export function surveyWorld(world: WorldSeed, duration: Duration | undefined): Survey {
	const plan = planFor(duration);
	const radiusTiles = plan.radiusChunks * CHUNK;

	// Spawn first, unbounded: the bounds are drawn around wherever the world offers
	// a reasonable start, not the other way round.
	const spawn = findSpawn(world);
	const style = styleForEdge(world, spawn, radiusTiles);
	const { bounds, adjustment } = solveBounds(world, spawn, radiusTiles, style);

	const declined: Record<string, number> = {};
	const sites = sitesWithin(world, bounds)
		.filter((site) => isWellInside(bounds, site.site.x, site.site.y))
		.filter((site) => {
			if (buildsSomething(world, site)) return true;
			declined[site.kind] = (declined[site.kind] ?? 0) + 1;
			return false;
		})
		.map((site) => ({
			site,
			context: siteContext(world, site),
			distanceFromSpawn: Math.round(Math.hypot(site.site.x - spawn.x, site.site.y - spawn.y)),
			settlement: isSettlement(site.kind),
		}))
		.sort((a, b) => a.distanceFromSpawn - b.distanceFromSpawn);

	const regionIds = [...new Set(sites.map((entry) => entry.site.regionId))];
	const regions = regionIds.map((id) => {
		const at = sites.find((entry) => entry.site.regionId === id)?.site.site ?? spawn;
		return regionContext(world, id, at);
	});

	return { world, spawn, bounds, sites, regions, boundaryAdjustment: adjustment, declined };
}

/** The settlements a story can actually be hung on. */
export function storySites(survey: Survey): readonly SurveyedSite[] {
	return survey.sites.filter((entry) => entry.settlement);
}

/**
 * Which of a survey's places the player can actually walk to.
 *
 * `distanceFromSpawn` is a straight line, which is the right measure for *ordering* a
 * story outward and the wrong one for deciding whether a place can be visited at all: a
 * town across an inlet is thirty tiles away and unreachable. A story with a beat there
 * cannot be finished, and nothing before this could tell — the validator says so at the
 * end, by which time sixty model calls have been spent writing the scene.
 *
 * Separate from `surveyWorld` and asked for explicitly, because it is not free: it
 * generates every chunk of the bounded world, which is the same work the validator does
 * and several seconds of it. A survey printed for a person does not need it; a story
 * about to be plotted does.
 */
export function walkableSites(survey: Survey): Set<number> {
	const grid = gridFor(survey.world, survey.bounds);
	const seen = reachableFrom(grid, survey.spawn);
	const reachable = new Set<number>();
	for (const entry of survey.sites) {
		if (canReach(grid, seen, entry.site.site)) reachable.add(entry.site.id);
	}
	return reachable;
}
