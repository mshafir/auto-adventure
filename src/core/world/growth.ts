import { sitePlots } from "../gen/features/settlement.js";
import { isWellInside, type WorldBounds } from "./bounds.js";
import { ambition } from "./context.js";
import { isSettlement, type MacroSite } from "./macro.js";
import type { PlaceRecipe, SettledKind, WorldSeed } from "./recipe.js";
import { GROWTH_CLEARANCE, overlapBy } from "./spacing.js";

/**
 * Making a site big enough for what it will be asked to hold.
 *
 * Two passes ask for this and they must not answer it separately. The survey grows every
 * settlement that is short before a token is spent; the settling walk grows one when a
 * required building turns out to have had nowhere to stand. Two growth rules would mean a
 * world the survey called big enough and the walk grew anyway on the same seed — and the
 * ceiling and the target are subtle enough that a second copy would get one of them wrong.
 */

/**
 * How much bigger a site gets per attempt.
 *
 * Three tiles, because a plot needs five in either axis and a step smaller than that can
 * spend several rounds buying nothing.
 */
const GROWTH_STEP = 3;

/**
 * The three kinds that differ only in size.
 *
 * Deliberately not `isSettlement`, which also admits `fort`: a fort is a settlement but not a
 * bigger village, and nothing else on the map has a next size up at all.
 */
const SIZE_LADDER: readonly SettledKind[] = ["hamlet", "village", "town"];

/** What the recipe says a place of this kind and importance is worth, before any growing. */
function baselineRadius(world: WorldSeed, site: MacroSite, kind: SettledKind): number {
	const rule = world.rules.sites.radius[kind];
	return rule.base + (rule.perImportance ?? 0) * site.importance;
}

/**
 * How far a site of this kind may be grown.
 *
 * Measured against what the *recipe* says the kind is worth at this importance, never against
 * the site's current radius — which is what makes growing idempotent. A ceiling of "half
 * again what you are now" would move every time it was applied, so surveying an already-grown
 * world would grow it again, and again, until something else stopped it.
 *
 * Half again, and never past the next rung of the ladder: a hamlet that has to reach village
 * size to hold its roster has stopped being the thing it was, and the story was told a hamlet
 * was there.
 */
function growthLimit(world: WorldSeed, site: MacroSite, kind: SettledKind): number {
	const baseline = baselineRadius(world, site, kind);
	const rung = SIZE_LADDER.indexOf(kind);
	const next = rung >= 0 ? SIZE_LADDER[rung + 1] : undefined;
	const ceiling = next
		? (() => {
				const up = world.rules.sites.radius[next];
				return up.base + (up.perImportance ?? 0) * site.importance;
			})()
		: Number.POSITIVE_INFINITY;
	return Math.min(baseline * 1.5, ceiling);
}

/**
 * How many plots a site of this kind and importance is worth asking for.
 *
 * Measured at the size the *recipe* gives the kind, never at whatever size the site is now,
 * and both halves matter. At the recipe's size it is a fixed point, so surveying an
 * already-grown world asks for the same thing and stops — where a target read off the current
 * radius would rise every time the site grew and each pass would grow it again. And it has to
 * be the recipe's size rather than a constant because `ambition` goes as the square of the
 * radius while plots go roughly linearly with it: a target that moved with the footprint would
 * outrun the ground it was chasing.
 */
export function rosterTarget(world: WorldSeed, site: MacroSite): number {
	const kind = site.kind;
	if (kind === "none" || !isSettlement(kind)) return 0;
	return ambition({ ...site, radius: baselineRadius(world, site, kind) });
}

export interface GrowthRequest {
	readonly world: WorldSeed;
	readonly site: MacroSite;
	readonly bounds: WorldBounds;
	/** Everything a grown footprint could run into. The site itself is skipped by id. */
	readonly neighbours: readonly MacroSite[];
	/** How many plots the site has to end up with. */
	readonly wanted: number;
}

/**
 * The recipe entry that makes this site big enough, or nothing if it cannot be.
 *
 * Growth is refused where it would push a footprint into a neighbour or across the boundary
 * band. The neighbour test is `overlapBy`, which is also what `validate.ts` warns with — a
 * grown site is pinned as an authored place and so becomes subject to that very warning, and
 * a generator that produced worlds its own checker complained about would be worse than one
 * that never grew anything.
 */
export function growSite(request: GrowthRequest): PlaceRecipe | undefined {
	const { world, site, bounds, neighbours, wanted } = request;
	const kind = site.kind;
	// `isSettlement` already excludes "none", but narrowing through it does not reach the
	// recipe's radius table, which is keyed by the kinds a place can actually be.
	if (kind === "none" || !isSettlement(kind)) return undefined;
	// An authored place is a size somebody chose. Growing it would be the generator overruling
	// the recipe, and the recipe is the one thing here with an opinion.
	if (site.authored) return undefined;
	if (sitePlots(world, site).length >= wanted) return undefined;

	const limit = growthLimit(world, site, kind);
	const clear = (radius: number): boolean =>
		neighbours.every(
			(other) =>
				other.id === site.id ||
				overlapBy({ at: site.site, radius }, { at: other.site, radius: other.radius }) <=
					GROWTH_CLEARANCE,
		);
	const fits = (radius: number): boolean =>
		[
			{ x: site.site.x - radius, y: site.site.y },
			{ x: site.site.x + radius, y: site.site.y },
			{ x: site.site.x, y: site.site.y - radius },
			{ x: site.site.x, y: site.site.y + radius },
		].every((point) => isWellInside(bounds, point.x, point.y));

	let chosen: number | undefined;
	for (let radius = site.radius + GROWTH_STEP; radius <= limit; radius += GROWTH_STEP) {
		// Both tests only get harder as the radius rises, so the first refusal is the last word
		// rather than something to try again beyond.
		if (!fits(radius) || !clear(radius)) break;
		chosen = radius;
		// The smallest size that holds the roster wins. Taking the ceiling regardless would
		// spend the map's spare ground on sites that did not need it.
		if (sitePlots(world, { ...site, radius }).length >= wanted) break;
	}
	if (chosen === undefined) return undefined;
	return { at: site.site, kind, importance: site.importance, radius: chosen };
}
