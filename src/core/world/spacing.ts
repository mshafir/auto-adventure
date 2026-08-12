import type { Vec2 } from "../geom/vec.js";

/**
 * How close two places may stand, asked once.
 *
 * Two callers want this and they must not answer it separately: the survey uses it to
 * decide whether a site may grow, and `validate.ts` uses it to report a recipe that put two
 * places on top of each other. Written twice they would drift, and the drift would show up
 * as a generator producing worlds its own checker complains about — a site grown into an
 * overlap the validator then warns about, on the same run.
 *
 * Circles rather than rectangles, matching how a footprint is described everywhere else in
 * the codebase: a site is a centre and a radius, and the deformed outline `buildSettlement`
 * draws stays inside it.
 */
export interface Footprint {
	readonly at: Vec2;
	readonly radius: number;
}

/** Tiles by which two footprints intrude on each other. Zero or less means clear. */
export function overlapBy(a: Footprint, b: Footprint): number {
	return a.radius + b.radius - Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
}

/**
 * How much overlap growth tolerates: none at all.
 *
 * Deliberately stricter than what the map already contains. Sites are one per macro cell
 * with their centres jittered, so two neighbours can stand about 28 tiles apart while a
 * town of the highest importance reaches 48 — pre-existing overlaps are ordinary, and
 * forbidding them retrospectively would fail worlds that play perfectly well. What growth
 * must not do is *add* to that, so a candidate radius is refused unless it stands clear.
 * A site that already overlaps a neighbour therefore cannot grow towards it at all, which
 * is the intended reading and not an accident of the arithmetic.
 */
export const GROWTH_CLEARANCE = 0;
