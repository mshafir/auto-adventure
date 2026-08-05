import { findPath } from "../../geom/astar.js";
import { labelComponents } from "../../geom/floodfill.js";
import type { Rect, Vec2 } from "../../geom/vec.js";
import { TFlag } from "../../tiles/flags.js";
import { T, type TerrainId } from "../../tiles/terrain.js";
import { elevationAt, slopeAt } from "../../world/fields.js";
import type { WorldSeed } from "../../world/recipe.js";
import { type Anchor, type FeaturePatch, patchIndex, patchWrite } from "./patch.js";

/**
 * Shaping primitives shared by every feature builder.
 *
 * These were all private to `settlement.ts` until there was a second builder. A
 * castle needs a ring wall for the same reason a walled town does, and both need a
 * route from the way in to every doorstep — so the alternative to moving them here
 * was a castle generator that imported half of the settlement generator, or a second
 * copy of a ring-stamper with its own diagonal-corner bug.
 *
 * Everything here works on a {@link FeaturePatch} in world coordinates and is pure in
 * `(world, site, spec)` by construction: no function reads anything outside the patch
 * it was handed.
 */

/** Whether a tile may be built on. */
export type Allowed = (x: number, y: number) => boolean;

/**
 * Surfaces a carved route leaves alone.
 *
 * A route is allowed to pave open ground and nothing else. Without pier and deck in
 * here the dock's own carve pass walked out along the pier it had just built and
 * replaced every plank with a dirt path — a jetty of footpath standing in open water.
 */
const KEEP_SURFACE: ReadonlySet<TerrainId> = new Set([
	T.cobbleRoad,
	T.dirtRoad,
	T.bridge,
	T.pier,
	T.deck,
]);

/** Ground high enough and dry enough to build on, inside a footprint test. */
export function buildableWithin(world: WorldSeed, inside: Allowed): Allowed {
	const floor = world.rules.climate.seaLevel + 0.02;
	return (x, y) => inside(x, y) && elevationAt(world, x, y) >= floor;
}

/** The flattest tile within `reach` of a point, for putting something square on. */
export function flattestNear(world: WorldSeed, centre: Vec2, reach: number): Vec2 {
	let best = centre;
	let bestSlope = Number.POSITIVE_INFINITY;
	const floor = world.rules.climate.seaLevel + 0.02;
	for (let dy = -reach; dy <= reach; dy++) {
		for (let dx = -reach; dx <= reach; dx++) {
			const x = centre.x + dx;
			const y = centre.y + dy;
			if (elevationAt(world, x, y) < floor) continue;
			const slope = slopeAt(world, x, y);
			if (slope < bestSlope) {
				bestSlope = slope;
				best = { x, y };
			}
		}
	}
	return best;
}

export function stampDisc(
	patch: FeaturePatch,
	centre: Vec2,
	radius: number,
	terrain: TerrainId,
	allowed: Allowed,
): void {
	const r2 = radius * radius;
	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			if (dx * dx + dy * dy > r2) continue;
			const x = centre.x + dx;
			const y = centre.y + dy;
			if (allowed(x, y)) patchWrite(patch, x, y, terrain);
		}
	}
}

export function stampRing(
	centre: Vec2,
	radiusAt: (angle: number) => number,
	allowed: Allowed,
	write: (x: number, y: number) => void,
): void {
	// Step finely enough that consecutive samples land on adjacent tiles;
	// a coarser sweep leaves a dotted line rather than a wall.
	const maxRadius = radiusAt(0);
	const steps = Math.max(256, Math.round(maxRadius * 16));

	let prevX = Number.NaN;
	let prevY = Number.NaN;

	// One sample past the end closes the ring back onto its first tile. Writes are
	// idempotent, so revisiting that tile costs nothing.
	for (let i = 0; i <= steps; i++) {
		const angle = (i / steps) * Math.PI * 2;
		// Sit just inside the outline so the wall is on buildable ground.
		const r = radiusAt(angle) - 1;
		const x = Math.round(centre.x + Math.cos(angle) * r);
		const y = Math.round(centre.y + Math.sin(angle) * r);

		// Adjacent is not the same as orthogonally adjacent. On its 45-degree arcs
		// the ring steps diagonally, and two tiles touching only at a corner have no
		// orthogonal neighbour, so a four-neighbour autotiler renders each run as a
		// stub capped at both ends: the wall came out as `╺━━╸ ╺╸ ┏╸ ╺┛ ■`, a dotted
		// diagonal that reads as a gap wherever there should be a corner. Adding the
		// tile that turns the diagonal into a step makes the ring 4-connected, so the
		// same autotiler produces a proper corner instead.
		// NaN on the first iteration compares false, which skips this.
		if (Math.abs(x - prevX) === 1 && Math.abs(y - prevY) === 1) {
			// Prefer the corner nearer the centre: `allowed` is the buildable
			// footprint, so the inner tile is the one more likely to be inside it.
			const inner = { x: prevX, y };
			const outer = { x, y: prevY };
			const dInner = (inner.x - centre.x) ** 2 + (inner.y - centre.y) ** 2;
			const dOuter = (outer.x - centre.x) ** 2 + (outer.y - centre.y) ** 2;
			const [first, second] = dInner <= dOuter ? [inner, outer] : [outer, inner];
			if (allowed(first.x, first.y)) write(first.x, first.y);
			else if (allowed(second.x, second.y)) write(second.x, second.y);
		}

		if (allowed(x, y)) write(x, y);
		prevX = x;
		prevY = y;
	}
}

/** A rectangular wall ring, one tile thick, written where allowed. */
export function stampRect(
	patch: FeaturePatch,
	rect: Rect,
	terrain: TerrainId,
	allowed: Allowed,
): void {
	const right = rect.x + rect.w - 1;
	const bottom = rect.y + rect.h - 1;
	for (let x = rect.x; x <= right; x++) {
		if (allowed(x, rect.y)) patchWrite(patch, x, rect.y, terrain);
		if (allowed(x, bottom)) patchWrite(patch, x, bottom, terrain);
	}
	for (let y = rect.y; y <= bottom; y++) {
		if (allowed(rect.x, y)) patchWrite(patch, rect.x, y, terrain);
		if (allowed(right, y)) patchWrite(patch, right, y, terrain);
	}
}

/**
 * Run a street between two points.
 *
 * Walls are impassable, and that is load-bearing rather than defensive. When this was
 * a plain distance search over `allowed`, a castle's gate road took the shortest line
 * to the courtyard and drove *through* the barracks in the way — a cobbled strip
 * running under a roof, with the building's walls left standing on either side of it.
 * A street that cannot cross a wall either goes round or is not carved, and both are
 * better than that.
 */
export function carveStreet(
	patch: FeaturePatch,
	from: Vec2,
	to: Vec2,
	allowed: Allowed,
	terrain: TerrainId,
): void {
	const path = findPath(from, to, {
		bounds: patch.bounds,
		cost: (x, y) => {
			if (!allowed(x, y)) return Number.POSITIVE_INFINITY;
			const i = patchIndex(patch, x, y);
			if (i < 0) return Number.POSITIVE_INFINITY;
			const flags = patch.flags[i] ?? 0;
			if (flags & TFlag.Wall && !(flags & TFlag.Door)) return Number.POSITIVE_INFINITY;
			if (flags & TFlag.Interior) return Number.POSITIVE_INFINITY;
			return 1;
		},
		diagonal: false,
	});
	if (!path) return;
	for (const p of path) patchWrite(patch, p.x, p.y, terrain);
}

/**
 * Connect a hub to every anchor.
 *
 * Building walls cost `Infinity`, so a route into a shop must use the door. If an
 * anchor is genuinely unreachable the path simply is not carved — which is caught by
 * the connectivity test rather than papered over at runtime. This replaces the old
 * design's wall-breaking hack, where the player pressing SPACE at an unreachable
 * objective would overwrite the stone wall in front of them.
 */
export function carveConnections(
	patch: FeaturePatch,
	hub: Vec2,
	anchors: readonly Anchor[],
	allowed: Allowed,
	surface: TerrainId = T.path,
): void {
	const cost = (x: number, y: number): number => {
		const i = patchIndex(patch, x, y);
		if (i < 0) return Number.POSITIVE_INFINITY;
		const flags = patch.flags[i] ?? 0;
		if (flags & TFlag.Wall && !(flags & TFlag.Door)) return Number.POSITIVE_INFINITY;
		if (flags & TFlag.Door) return 2;
		if (flags & TFlag.Passable) return 1;
		// Unwritten ground inside the footprint may be carved; outside it may not.
		return allowed(x, y) ? 3 : Number.POSITIVE_INFINITY;
	};

	for (const anchor of anchors) {
		if (anchor.kind === "square") continue;
		// An anchor that is itself impassable can never be routed to, and a failed
		// A* explores the entire patch before saying so. Buildings emit `counter`,
		// `hearth` and `backroom` anchors inside their own footprint, which became
		// exactly this case when the footprint stopped being a floor and started
		// being a roof — and doubled the time to generate a settlement chunk.
		const index = patchIndex(patch, anchor.x, anchor.y);
		if (index < 0 || !((patch.flags[index] ?? 0) & TFlag.Passable)) continue;
		const path = findPath(
			{ x: hub.x, y: hub.y },
			{ x: anchor.x, y: anchor.y },
			{ bounds: patch.bounds, cost, diagonal: false },
		);
		if (!path) continue;
		for (const p of path) {
			const i = patchIndex(patch, p.x, p.y);
			if (i < 0) continue;
			const flags = patch.flags[i] ?? 0;
			// Never overwrite a door, a wall, or an existing road with plain path.
			if (flags & (TFlag.Wall | TFlag.Door)) continue;
			if (flags & TFlag.Interior) continue;
			if (KEEP_SURFACE.has(patch.terrain[i] ?? T.void)) continue;
			patchWrite(patch, p.x, p.y, surface);
		}
	}
}

/**
 * Which anchors share a walkable component with a hub.
 *
 * `undefined` when the hub itself is not walkable, which is *not* the same as "no
 * anchor is reachable". Collapsing the two is how a settlement whose square landed on
 * an impassable tile came out with every one of its buildings demolished: the caller
 * asks "which of these can I not reach", and the honest answer when it cannot stand
 * anywhere is "I cannot tell", not "none of them".
 */
export function reachableFrom(
	patch: FeaturePatch,
	hub: Vec2,
	anchors: readonly Anchor[],
): Set<Anchor> | undefined {
	const labels = labelComponents(
		patch.bounds,
		(x, y) => {
			const i = patchIndex(patch, x, y);
			return i >= 0 && ((patch.flags[i] ?? 0) & TFlag.Passable) !== 0;
		},
		true,
	);
	const labelAt = (x: number, y: number) =>
		labels.labels[(y - patch.bounds.y) * patch.bounds.w + (x - patch.bounds.x)] ?? 0;

	const hubLabel = labelAt(hub.x, hub.y);
	if (hubLabel === 0) return undefined;
	const reached = new Set<Anchor>();
	for (const anchor of anchors) {
		if (labelAt(anchor.x, anchor.y) === hubLabel) reached.add(anchor);
	}
	return reached;
}

export function rectFullyAllowed(rect: Rect, allowed: Allowed): boolean {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			if (!allowed(x, y)) return false;
		}
	}
	return true;
}
