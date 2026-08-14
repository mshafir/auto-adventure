import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import {
	featureKindFor,
	generateFeature,
	invalidateFeature,
} from "../core/gen/features/registry.js";
import {
	type BoundaryStyle,
	isWellInside,
	safeInterior,
	type WorldBounds,
} from "../core/world/bounds.js";
import type { Duration } from "../core/world/brief.js";
import type { RegionContext } from "../core/world/context.js";
import { biomeAt, regionContext, type SiteContext, siteContext } from "../core/world/context.js";
import { CHUNK } from "../core/world/coords.js";
import { elevationAt } from "../core/world/fields.js";
import { growSite, rosterTarget } from "../core/world/growth.js";
import {
	isSettlement,
	MACRO,
	type MacroSite,
	macroSite,
	placeRadius,
} from "../core/world/macro.js";
import {
	type PlaceRecipe,
	type SettledKind,
	type WorldRecipe,
	type WorldSeed,
	worldSeed,
} from "../core/world/recipe.js";
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
 *
 * `tiny` is not a length anybody would choose to play — two beats across a world four
 * macro cells wide is a walk of a couple of minutes. It exists because the shortest
 * real world still costs thirty model calls and several minutes, which is a bad price
 * for finding out whether a change to the *pipeline* works: a run that has to be paid
 * for is a run that gets made once, and the pass that broke is discovered on the next
 * world somebody wanted to keep. Two beats and a handful of places exercises every pass
 * — shape, lore, regions, sites, arc, reactions, dialogue, repair — for about a tenth
 * of the bill.
 *
 * Two chunks of radius is 128 tiles, and `MACRO` is one chunk, so the boundary encloses
 * about sixteen macro cells. On a dense seed that is three or four places and a walk of
 * a couple of minutes; on a sparse one it is nothing at all, which is why the boundary
 * grows until it holds a story — see {@link GROWTH_LIMIT_CHUNKS}. Deliberately the
 * smallest radius that works rather than a safe one, so the cheap case stays cheap and
 * only the seeds that need the room pay for it.
 */
export const DURATION_PLAN: Readonly<Record<Duration, DurationPlan>> = {
	tiny: { beats: 2, radiusChunks: 2 },
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
	/**
	 * Sites that were made bigger so they could hold what they will be asked for, by id.
	 *
	 * Empty for a world where the ground was already generous enough, which is most of
	 * them at the sizes the recipe now asks for. Reported so a player watching a
	 * generation can see it happen, and so a test can tell growth from luck.
	 */
	readonly grown: Readonly<Record<string, number>>;
	/**
	 * The grown sites as recipe entries, for whoever writes the artifact.
	 *
	 * Growth that lived only in this survey would be a town that shrank the next time the
	 * artifact was opened, with every placement in it written against the larger one. The
	 * survey's own `world` already has these folded in; this is the same fact in the form
	 * that survives being saved.
	 */
	readonly places: readonly PlaceRecipe[];
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
 * A settlement has to produce a *building*. "Something" used to include an anchor, and
 * every settlement emits a square and a well before it places anything at all — so a town
 * with nothing in it passed this filter, was named, peopled and given story beats, and the
 * only symptom was a field with a signpost. The kinds that lay out their own buildings from
 * their own rules keep the old test, because an empty patch is what *their* refusal looks
 * like and an anchor is evidence they accepted.
 *
 * `validate.ts` already catches exactly this and calls it an error for a human to fix.
 * Filtering here is what makes it not happen in the first place, which matters now that
 * a world can be generated with nobody watching.
 *
 * Runs *after* growth, and the order is load-bearing: a site with no room at its rolled
 * size may have plenty once it has been made bigger, and asking this first would drop it
 * before it ever got the chance.
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
		if (!patch) return true;
		if (isSettlement(site.kind)) return patch.buildings.length > 0;
		return patch.buildings.length > 0 || patch.anchors.length > 0;
	} finally {
		invalidateFeature(world, site.id);
	}
}

/**
 * Make room, before the model is asked for a roster that needs it.
 *
 * The fix at source. A site short of plots was told to write eight buildings for ground with
 * four, and four of them quietly became filler — the very substitution the placement solver
 * exists to prevent, arriving before the solver ever sees it. Growing the site at survey time
 * costs nothing but arithmetic and happens before a single token is spent.
 *
 * The rule itself lives in `core/world/growth.ts`, because the settling walk grows a site too
 * — one at a time, when a required building turns out to have had nowhere to stand — and two
 * growth rules would mean a world this pass called big enough and that one grew anyway.
 */
function growSites(
	world: WorldSeed,
	bounds: WorldBounds,
	sites: readonly MacroSite[],
	neighbours: readonly MacroSite[],
): { readonly places: readonly PlaceRecipe[]; readonly grown: Record<string, number> } {
	const places: PlaceRecipe[] = [];
	const grown: Record<string, number> = {};
	for (const site of sites) {
		const place = growSite({
			world,
			site,
			bounds,
			neighbours,
			wanted: rosterTarget(world, site),
		});
		if (place?.radius === undefined) continue;
		grown[String(site.id)] = place.radius;
		places.push(place);
	}
	return { places, grown };
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
	// A world that says what its edge is gets it, without the samples being taken. This
	// is the only way `mountains` is ever reached — the ground-following rule below has
	// no branch that returns it — so a world ringed in ice has to ask.
	const asked = world.rules.bounds.style;
	if (asked) return asked;

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

/**
 * How far the boundary may be pushed out to find somewhere for the story to happen.
 *
 * A radius is a request for a *size*, and how many towns fit inside it is the seed's
 * business — so a sparse corner of the world can enclose one settlement, or none, at
 * any duration. The consequence is not a thin world, it is no world: the arc pass needs
 * at least two places to plot between, and below that it reports "no story could be
 * plotted" and every later pass carries on as though that were what was asked for.
 *
 * Growing is the right answer rather than moving the spawn, because the spawn was
 * chosen for the ground under it.
 *
 * Bounded twice over, and the second bound is the one that matters. Three chunks is
 * enough to reach the next ring of macro cells; but three chunks on top of `tiny`'s two
 * is five, which is larger than `short` — and a run measured on a real seed did exactly
 * that, producing a "tiny" world 670 tiles across with twenty people in it, dearer than
 * the size it was chosen to be cheaper than. So a duration may never grow past the next
 * size up. A `tiny` world that has to reach `short` to find a story has stopped being a
 * bargain and should stop growing rather than quietly become expensive.
 */
const GROWTH_LIMIT_CHUNKS = 3;

/** Durations by extent, so "the next size up" is a lookup rather than a guess. */
const BY_EXTENT: readonly Duration[] = ["tiny", "short", "medium", "long"];

function growthCeiling(duration: Duration | undefined): number {
	const plan = planFor(duration);
	const at = BY_EXTENT.indexOf(duration ?? "medium");
	const next = at >= 0 ? BY_EXTENT[at + 1] : undefined;
	const nextUp = next ? DURATION_PLAN[next].radiusChunks : Number.POSITIVE_INFINITY;
	return Math.min(plan.radiusChunks + GROWTH_LIMIT_CHUNKS, nextUp);
}

/**
 * Survey a world, growing the sites that cannot hold what they will be asked for.
 *
 * `recipe` is the one the world was built from, and it is required rather than optional on
 * purpose. Growth works by adding authored places, and the survey's world has to be rebuilt
 * by exactly the route the artifact will take when it is loaded again — `worldSeed(seed,
 * recipe)` — or the town the story was written against is not the town the player walks
 * into. An optional parameter would make forgetting it silent, and the symptom would be a
 * world that quietly lost its climate the first time a site grew. Pass `undefined` when the
 * world genuinely has no recipe.
 */
export function surveyWorld(
	world: WorldSeed,
	duration: Duration | undefined,
	recipe: WorldRecipe | undefined,
): Survey {
	const plan = planFor(duration);

	// Spawn first, unbounded: the bounds are drawn around wherever the world offers
	// a reasonable start, not the other way round.
	const spawn = findSpawn(world);

	// Then outward until there is a story's worth of somewhere, and no further. The
	// first radius that holds enough wins, so an ordinary seed — which has plenty at
	// the requested size — is surveyed exactly once and comes out exactly as before.
	let survey = surveyAt(world, spawn, plan.radiusChunks, recipe);

	// A world that settles nothing has nothing to grow toward. Every place in it will be put
	// there by an author, so the requested radius is the answer — whereas searching for
	// settlements that cannot exist would take every scenario to the largest rectangle its
	// duration allows and then report no story sites anyway.
	if (world.rules.sites.settled.length + world.rules.sites.wild.length === 0) return survey;

	const ceiling = growthCeiling(duration);
	for (let radius = plan.radiusChunks + 1; radius <= ceiling; radius++) {
		if (storySites(survey).length >= Math.min(plan.beats, MIN_STORY_SITES)) break;
		const wider = surveyAt(world, spawn, radius, recipe);
		// Never smaller than what we already had: growing the rectangle can move the
		// boundary onto a different settlement and push one *out*, and taking that would
		// be searching for a story by walking away from one.
		if (storySites(wider).length > storySites(survey).length) survey = wider;
	}
	return survey;
}

/**
 * The fewest settlements a story can be told across.
 *
 * Two: somewhere to be given the errand and somewhere to take it. One is a story that
 * happens entirely in the room it started in, which `validate.ts` already complains
 * about by name.
 */
const MIN_STORY_SITES = 2;

function surveyAt(
	world: WorldSeed,
	spawn: { readonly x: number; readonly y: number },
	radiusChunks: number,
	recipe: WorldRecipe | undefined,
): Survey {
	const radiusTiles = radiusChunks * CHUNK;
	const style = styleForEdge(world, spawn, radiusTiles);
	const { bounds, adjustment } = solveBounds(world, spawn, radiusTiles, style);

	const inside = (site: MacroSite) => isWellInside(bounds, site.site.x, site.site.y);

	// Room first. Neighbours are drawn a macro cell wider than the bounds, because a site
	// just outside the playable rectangle is still ground a grown footprint would run into.
	const { places, grown } = growSites(
		world,
		bounds,
		sitesWithin(world, bounds).filter(inside),
		sitesWithin(world, bounds, MACRO),
	);
	// Rebuilt rather than patched: `macroSite` is what every later caller consults, so a
	// radius changed on the objects collected above would leave the rules disagreeing with
	// them. Positions, kinds and importances are pinned to what they already were, which is
	// what leaves roads, region ids and site ids exactly as they were.
	// Appended rather than merged: `mergeRecipe` lets one recipe's `places` *replace*
	// another's, which is right for a pack override and here would silently delete every
	// place a scenario's author wrote down — green-chapel lost its two castles, its cave and
	// its harbour to exactly that, and the cell where the cave had been rolled a landmark.
	// Nothing authored is ever grown, so these cannot collide with what is already there.
	const grownWorld =
		places.length === 0
			? world
			: worldSeed(world.seed, { ...recipe, places: [...(recipe?.places ?? []), ...places] });

	const declined: Record<string, number> = {};
	const sites = sitesWithin(grownWorld, bounds)
		.filter(inside)
		.filter((site) => {
			if (buildsSomething(grownWorld, site)) return true;
			declined[site.kind] = (declined[site.kind] ?? 0) + 1;
			return false;
		})
		.map((site) => ({
			site,
			context: siteContext(grownWorld, site),
			distanceFromSpawn: Math.round(Math.hypot(site.site.x - spawn.x, site.site.y - spawn.y)),
			settlement: isSettlement(site.kind),
		}))
		.sort((a, b) => a.distanceFromSpawn - b.distanceFromSpawn);

	const regionIds = [...new Set(sites.map((entry) => entry.site.regionId))];
	const regions = regionIds.map((id) => {
		const at = sites.find((entry) => entry.site.regionId === id)?.site.site ?? spawn;
		return regionContext(grownWorld, id, at);
	});

	return {
		world: grownWorld,
		spawn,
		bounds,
		sites,
		regions,
		boundaryAdjustment: adjustment,
		declined,
		grown,
		places,
	};
}

/**
 * What founding a place somewhere would actually produce, or why it cannot go there.
 *
 * The measurement behind both `craft survey` and `craft found`, and the reason those two
 * agree: the survey shows the ground by asking this of every cell, and founding asks it of
 * the one cell the author picked. A place the survey offered is therefore a place founding
 * will accept, and a place founding refuses is one the survey never listed.
 *
 * It works by *doing it and looking*. The candidate is added to the recipe, the world is
 * resolved with it in, and the resulting site is generated and measured — because a
 * settlement's real building count depends on the plots its footprint finds on that exact
 * ground, and nothing short of laying it out knows how many there are.
 */
export interface Prospect {
	readonly site: MacroSite;
	readonly context: SiteContext;
	/** How many buildings the ground here will actually hold. */
	readonly budget: number;
	/** The recipe entry that produced this, ready to be written down. */
	readonly place: PlaceRecipe;
}

export function prospect(
	seed: number,
	recipe: WorldRecipe | undefined,
	bounds: WorldBounds,
	place: PlaceRecipe,
): Prospect | { readonly refusal: string } {
	const at = place.at;
	if (!isWellInside(bounds, at.x, at.y)) {
		const safe = safeInterior(bounds);
		return {
			refusal:
				`${at.x},${at.y} is in the world's edge or outside it. The ground a place can stand on ` +
				`runs from ${safe.minX},${safe.minY} to ${safe.maxX},${safe.maxY}`,
		};
	}

	// Appended, never replaced: `mergeRecipe` lets one recipe's `places` replace another's,
	// which here would delete every place already founded and measure this one in a world
	// where none of its neighbours exist.
	const world = worldSeed(seed, { ...recipe, places: [...(recipe?.places ?? []), place] });
	const site = macroSite(world, macroOf(at.x), macroOf(at.y));

	// The same test `siteKindAt` applies to a rolled site, and it has to be the same: a
	// footprint whose centre is at sea may still find plots on a spit at its edge, so the
	// budget alone would accept a village whose square and well were under water.
	if (elevationAt(world, at.x, at.y) < world.rules.climate.seaLevel) {
		return { refusal: `${at.x},${at.y} is under water. A place has to stand on land` };
	}

	if (straddles(bounds, site)) {
		return {
			refusal:
				`a ${place.kind} at ${at.x},${at.y} reaches ${site.radius} tiles, which the world's edge ` +
				"would cut in half. Move it inward, or make it smaller with --importance",
		};
	}
	if (!buildsSomething(world, site)) {
		return {
			refusal:
				`the ground at ${at.x},${at.y} will not hold a ${place.kind}: too steep, too wet, or too ` +
				"much of the footprint in water. craft survey lists the cells that will",
		};
	}

	// Overlapping footprints are legal — the clip-into-chunks model copes — and they read as
	// one sprawling place rather than as two, which is never what somebody founding a second
	// town meant. `validate.ts` warns about it; refusing here is what stops it being written.
	for (const other of recipe?.places ?? []) {
		const gap = Math.hypot(other.at.x - at.x, other.at.y - at.y);
		const together = site.radius + placeRadius(other, world.rules);
		if (gap >= together) continue;
		return {
			refusal:
				`a ${place.kind} at ${at.x},${at.y} reaches ${site.radius} tiles and would run ` +
				`${Math.round(together - gap)} tiles into the ${other.kind} at ${other.at.x},${other.at.y}. ` +
				"Two places that touch read as one; move it further off or lower --importance",
		};
	}

	const context = siteContext(world, site);
	return { site, context, budget: context.buildingBudget, place };
}

function macroOf(coordinate: number): number {
	return Math.floor(coordinate / MACRO);
}

/** A cell of the world, with what would happen if a place were founded in it. */
export interface Candidate {
	readonly mx: number;
	readonly my: number;
	readonly prospect: Prospect;
	readonly distanceFromSpawn: number;
}

/**
 * Every macro cell of a bounded world that would hold the kind of place asked about.
 *
 * This is what shopping for a world means once the generator settles nothing: the question
 * is no longer "which towns did the seed give me" but "where will this country take one".
 * Sites sit one macro cell apart, so a cell is the unit — two places in one cell would share
 * an id, and `macroSite` would only ever report the later of them.
 *
 * Cells that cannot hold anything are counted rather than listed. A caller that wants to
 * know *why* asks {@link prospect} about that one cell and gets a sentence.
 */
export function candidates(
	seed: number,
	recipe: WorldRecipe | undefined,
	bounds: WorldBounds,
	spawn: { readonly x: number; readonly y: number },
	kind: SettledKind,
	importance: number,
): { readonly found: readonly Candidate[]; readonly refused: number } {
	const taken = new Set(
		(recipe?.places ?? []).map((place) => `${macroOf(place.at.x)},${macroOf(place.at.y)}`),
	);
	const found: Candidate[] = [];
	let refused = 0;

	const safe = safeInterior(bounds);
	for (let my = macroOf(safe.minY); my <= macroOf(safe.maxY); my++) {
		for (let mx = macroOf(safe.minX); mx <= macroOf(safe.maxX); mx++) {
			if (taken.has(`${mx},${my}`)) continue;
			// The centre of the cell, clamped into the playable rectangle. A cell on the inside
			// of the edge still has ground in it, and its middle may not be the part that does.
			const at = {
				x: Math.min(Math.max(mx * MACRO + MACRO / 2, safe.minX), safe.maxX),
				y: Math.min(Math.max(my * MACRO + MACRO / 2, safe.minY), safe.maxY),
			};
			const asked = prospect(seed, recipe, bounds, { at, kind, importance });
			if ("refusal" in asked) {
				refused++;
				continue;
			}
			found.push({
				mx,
				my,
				prospect: asked,
				distanceFromSpawn: Math.round(Math.hypot(at.x - spawn.x, at.y - spawn.y)),
			});
		}
	}

	found.sort((a, b) => a.distanceFromSpawn - b.distanceFromSpawn);
	return { found, refused };
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
