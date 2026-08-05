import { findPath } from "../../geom/astar.js";
import { bspSplit } from "../../geom/bsp.js";
import { labelComponents } from "../../geom/floodfill.js";
import { rasterizePolyline } from "../../geom/line.js";
import { type Rect, rectIntersection, rectIntersects, type Vec2 } from "../../geom/vec.js";
import { hash2 } from "../../rand/hash.js";
import { type Rng, rngFor } from "../../rand/rng.js";
import { D } from "../../tiles/decor.js";
import { TFlag } from "../../tiles/flags.js";
import { T } from "../../tiles/terrain.js";
import { elevationAt, SEA_LEVEL, slopeAt } from "../../world/fields.js";
import type { MacroSite } from "../../world/macro.js";
import { roadsAround } from "../../world/roads.js";
import { buildStructure, minimumPlot } from "./building.js";
import {
	type Anchor,
	type BuildingPlacement,
	createPatch,
	type FeaturePatch,
	patchIndex,
	patchWrite,
	type StructureKind,
} from "./patch.js";

export interface StructureSpec {
	readonly kind: StructureKind;
	readonly size: "small" | "medium" | "large";
	/** 1..5. Used to decide who gets a plot when there are more specs than plots. */
	readonly importance: number;
	readonly name?: string;
	readonly signText?: string;
}

export interface SettlementSpec {
	readonly name?: string;
	readonly walled: boolean;
	readonly structures: readonly StructureSpec[];
}

const patchCache = new Map<string, FeaturePatch>();

/** Weighted filler used when a spec has fewer structures than there are plots. */
const FILLER: readonly (readonly [StructureKind, number])[] = [
	["house", 10],
	["farmhouse", 3],
	["barn", 2],
	["stable", 1],
	["warehouse", 1],
];

/**
 * A settlement, generated once in its own coordinate frame.
 *
 * Cached by site id and never regenerated per chunk. This is the single most
 * important structural decision in the generator: a town is an *object* that
 * chunks are windows onto, not a thing that lives inside a chunk. A town
 * straddling four chunks is generated once and clipped four ways, so there is
 * nothing for the four chunks to disagree about.
 */
export function generateSettlement(
	seed: number,
	site: MacroSite,
	spec: SettlementSpec,
): FeaturePatch {
	const key = `${seed}:${site.id}`;
	const cached = patchCache.get(key);
	if (cached) return cached;

	const built = buildSettlement(seed, site, spec);
	patchCache.set(key, built);
	return built;
}

export function clearSettlementCache(): void {
	patchCache.clear();
}

/**
 * Forget one settlement so it is rebuilt from a new spec.
 *
 * The only reason this exists is the director: a town built from the fallback
 * roster has to be regenerated once its authored roster arrives. Callers are
 * responsible for invalidating the chunks that had already stamped the old
 * patch, which is why {@link settlementBounds} is exported.
 */
export function invalidateSettlement(seed: number, siteId: number): void {
	patchCache.delete(`${seed}:${siteId}`);
}

/**
 * A site's patch bounds, computable without generating it.
 *
 * Having this separate is what lets a chunk reject the settlements it does not
 * overlap before paying to build them — otherwise every chunk generates every
 * town in its halo and throws almost all of them away.
 */
export function settlementBounds(site: MacroSite): Rect {
	const radius = site.radius;
	return {
		x: site.site.x - radius - 2,
		y: site.site.y - radius - 2,
		w: radius * 2 + 5,
		h: radius * 2 + 5,
	};
}

function buildSettlement(seed: number, site: MacroSite, spec: SettlementSpec): FeaturePatch {
	const rng = rngFor(seed, "settlement", site.mx, site.my);
	const radius = site.radius;
	const bounds = settlementBounds(site);

	const { patch, buildings, anchors } = createPatch(site.id, bounds);

	// --- footprint -----------------------------------------------------------
	// A circle deformed by a few radial harmonics, so the outline is organic
	// without being noisy. Everything below is clipped to it.
	const harmonics = Array.from({ length: 4 }, (_, i) => ({
		amplitude: (0.06 + rng.float() * 0.1) / (i + 1),
		phase: rng.float() * Math.PI * 2,
		frequency: i + 2,
	}));

	/** The deformed footprint radius at a given bearing from the centre. */
	const radiusAt = (angle: number): number => {
		let r = radius;
		for (const h of harmonics) r += radius * h.amplitude * Math.sin(h.frequency * angle + h.phase);
		return r;
	};

	const inFootprint = (x: number, y: number): boolean => {
		const dx = x - site.site.x;
		const dy = y - site.site.y;
		const distance = Math.hypot(dx, dy);
		if (distance > radius * 1.25) return false;
		return distance <= radiusAt(Math.atan2(dy, dx));
	};

	// A settlement never sits in the sea, and never on ground too steep to build.
	const buildable = (x: number, y: number): boolean =>
		inFootprint(x, y) && elevationAt(seed, x, y) >= SEA_LEVEL + 0.02;

	// --- ground --------------------------------------------------------------
	for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
		for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
			if (!buildable(x, y)) continue;
			patchWrite(patch, x, y, rng.chance(0.12) ? T.grass : T.dirt);
		}
	}

	// --- town square ---------------------------------------------------------
	const square = flattestNear(seed, site.site, 5);
	const squareRadius = site.kind === "town" ? 4 : 3;
	stampDisc(patch, square, squareRadius, T.cobbleRoad, buildable);
	anchors.push({ id: "square", kind: "square", x: square.x, y: square.y });
	if (site.kind !== "camp") {
		patchWrite(patch, square.x, square.y, T.cobbleRoad);
		patch.decor[patchIndex(patch, square.x, square.y)] = D.well;
		anchors.push({ id: "well", kind: "well", x: square.x, y: square.y });
	}

	// Somewhere for people to stand who do not own a building. Without these the
	// only outdoor anchors are doorsteps, and every NPC ends up pressed against a
	// wall instead of out in the square where the player will find them.
	for (const [index, [dx, dy]] of (
		[
			[2, 0],
			[-2, 0],
			[0, 2],
			[0, -2],
		] as const
	).entries()) {
		const x = square.x + dx;
		const y = square.y + dy;
		if (!buildable(x, y)) continue;
		patchWrite(patch, x, y, T.cobbleRoad);
		anchors.push({
			id: `plaza:${index}`,
			kind: index % 2 === 0 ? "stall" : "bench",
			x,
			y,
		});
	}

	// --- main streets --------------------------------------------------------
	// Every road that reaches the footprint is continued inward to the square,
	// so the approach the player walks in on is the street they arrive by.
	for (const road of roadsAround(seed, site.mx, site.my)) {
		const entry = firstPointInside(rasterizePolyline(road.points), buildable);
		if (!entry) continue;
		carveStreet(patch, entry, square, buildable, T.cobbleRoad);
		anchors.push({ id: `gate:${road.id}`, kind: "gate", x: entry.x, y: entry.y });
	}

	// --- plots ---------------------------------------------------------------
	const inner: Rect = {
		x: Math.round(site.site.x - radius * 0.78),
		y: Math.round(site.site.y - radius * 0.78),
		w: Math.round(radius * 1.56),
		h: Math.round(radius * 1.56),
	};
	const { leaves, cuts } = bspSplit(inner, rng, { minSize: 7, stopSize: 13, cutWidth: 2 });

	// BSP cuts become the secondary street grid.
	for (const cut of cuts) {
		if (cut.vertical) {
			for (let y = cut.within.y; y < cut.within.y + cut.within.h; y++) {
				for (let dx = 0; dx < 2; dx++) {
					if (buildable(cut.at + dx, y)) patchWrite(patch, cut.at + dx, y, T.dirtRoad);
				}
			}
		} else {
			for (let x = cut.within.x; x < cut.within.x + cut.within.w; x++) {
				for (let dy = 0; dy < 2; dy++) {
					if (buildable(x, cut.at + dy)) patchWrite(patch, x, cut.at + dy, T.dirtRoad);
				}
			}
		}
	}

	/**
	 * Nothing may be built on the square.
	 *
	 * The BSP is laid over the town centre and the square sits at the town centre,
	 * so without this a plot lands squarely on top of it — burying the well, and
	 * leaving the "square" anchor *inside somebody's house*. That anchor is where
	 * people gather in the evening and where every carve path starts, so the whole
	 * settlement is then routed from a tile behind a locked door. It went unnoticed
	 * because a building used to be floored rather than roofed, which made the
	 * stolen square passable and the connectivity check pass.
	 */
	const plaza: Rect = {
		x: square.x - squareRadius - 1,
		y: square.y - squareRadius - 1,
		w: squareRadius * 2 + 3,
		h: squareRadius * 2 + 3,
	};

	// A plot is a leaf inset by a street margin, kept only if it fits entirely
	// on buildable ground and clear of the square.
	const plots = leaves
		.map((leaf) => ({ x: leaf.x + 1, y: leaf.y + 1, w: leaf.w - 2, h: leaf.h - 2 }))
		.filter(
			(plot) =>
				plot.w >= 5 &&
				plot.h >= 5 &&
				!rectIntersects(plot, plaza) &&
				rectFullyBuildable(plot, buildable),
		)
		.sort((a, b) => b.w * b.h - a.w * a.h);

	// --- assign structures to plots -----------------------------------------
	// The spec is advisory: more structures than plots are truncated by
	// importance and fewer are padded with filler, so a malformed or oversized
	// spec degrades instead of failing.
	const wanted = [...spec.structures].sort((a, b) => b.importance - a.importance);
	const assignments: (StructureSpec | undefined)[] = plots.map((plot, i) => {
		const candidate = wanted[i];
		if (!candidate) return undefined;
		const need = minimumPlot(candidate.kind, candidate.size);
		return plot.w >= need.x && plot.h >= need.y ? candidate : undefined;
	});

	plots.forEach((plot, i) => {
		const assigned = assignments[i];
		const kind: StructureKind = assigned?.kind ?? pickFiller(rng);
		const size = fitRect(plot, assigned?.size ?? "small", rng);
		if (size.w < 5 || size.h < 5) return;

		const index = buildings.length;
		const interiorId = hash2(site.id, index);
		const streetTarget = nearestStreet(patch, size) ?? square;
		const result = buildStructure(
			patch,
			index,
			kind,
			size,
			streetTarget,
			interiorId,
			rng,
			assigned ? { name: assigned.name, signText: assigned.signText } : undefined,
		);
		buildings.push(result.placement);
		anchors.push(...result.anchors);
	});

	// --- perimeter wall ------------------------------------------------------
	if (spec.walled && site.kind !== "camp") {
		// Follow the deformed outline rather than a circle: a circular wall drawn
		// around a lobed footprint wanders outside the town and breaks into
		// disconnected fragments standing in open field.
		//
		// Collected first and written second, so a tile can be dropped once the
		// whole ring is known.
		const ring: Vec2[] = [];
		stampRing(site.site, radiusAt, buildable, (x, y) => {
			// Leave the streets open: a wall across a road would make the gate
			// unreachable, and the carve pass is forbidden from breaking walls.
			const existing = patch.terrain[patchIndex(patch, x, y)] ?? T.void;
			if (existing === T.cobbleRoad || existing === T.dirtRoad) return;
			ring.push({ x, y });
		});

		const key = (x: number, y: number) => `${x},${y}`;
		const planned = new Set(ring.map((p) => key(p.x, p.y)));
		const joins = (x: number, y: number) => {
			if (planned.has(key(x, y))) return true;
			// A building wall counts too: the ring is allowed to end against one.
			const i = patchIndex(patch, x, y);
			if (i < 0) return false;
			const t = patch.terrain[i] ?? T.void;
			return t === T.stoneWall || t === T.woodWall;
		};

		for (const p of ring) {
			// Drop lone pillars. Two survive the 4-connected ring: one where the
			// outline runs past the patch bounds and is clipped, and one where two
			// gate roads leave side by side and strand the single tile between them.
			// A wall tile with nothing to join encloses nothing, so removing it costs
			// no enclosure and takes away a stray `■` that reads as a hole.
			const joined =
				joins(p.x, p.y - 1) || joins(p.x + 1, p.y) || joins(p.x, p.y + 1) || joins(p.x - 1, p.y);
			if (joined) patchWrite(patch, p.x, p.y, T.stoneWall);
		}
	}

	// --- carve ---------------------------------------------------------------
	// The one order-dependent step, and it is confined to this frame where it is
	// a pure function of (seed, site, spec). Walls are infinite cost: the route
	// to an interior anchor must go through the door.
	carveConnections(patch, square, anchors, buildable);

	// --- validate ------------------------------------------------------------
	// A building whose doorstep the carve could not reach — because neighbours
	// walled it in — is demolished rather than shipped. The alternative the old
	// design took was to let the player break the wall at runtime, which meant
	// every unreachable objective became a hole punched through stone.
	pruneUnreachable(patch, square, buildings, anchors, buildable, rng);

	return patch;
}

const MAX_PRUNE_ROUNDS = 4;

function pruneUnreachable(
	patch: FeaturePatch,
	square: Vec2,
	buildings: BuildingPlacement[],
	anchors: Anchor[],
	buildable: (x: number, y: number) => boolean,
	rng: Rng,
): void {
	for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
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

		const squareLabel = labelAt(square.x, square.y);
		if (squareLabel === 0) return;

		const doomed = new Set<number>();
		for (const anchor of anchors) {
			if (anchor.kind !== "doorstep" || anchor.building === undefined) continue;
			if (labelAt(anchor.x, anchor.y) !== squareLabel) doomed.add(anchor.building);
		}
		if (doomed.size === 0) return;

		for (const index of doomed) {
			const building = buildings.find((b) => b.index === index);
			if (building) demolish(patch, building, buildable, rng);
		}

		for (let i = buildings.length - 1; i >= 0; i--) {
			if (doomed.has(buildings[i]?.index ?? -1)) buildings.splice(i, 1);
		}
		for (let i = anchors.length - 1; i >= 0; i--) {
			const owner = anchors[i]?.building;
			if (owner !== undefined && doomed.has(owner)) anchors.splice(i, 1);
		}

		// Re-carve: removing a building may open a route the previous pass could
		// not find.
		carveConnections(patch, square, anchors, buildable);
	}
}

/** Return a building's footprint to open ground. */
function demolish(
	patch: FeaturePatch,
	building: BuildingPlacement,
	buildable: (x: number, y: number) => boolean,
	rng: Rng,
): void {
	const { rect } = building;
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			if (!buildable(x, y)) continue;
			patchWrite(patch, x, y, rng.chance(0.2) ? T.grass : T.dirt);
			const i = patchIndex(patch, x, y);
			if (i >= 0) patch.decor[i] = D.none;
		}
	}
	if (building.signAt) {
		const i = patchIndex(patch, building.signAt.x, building.signAt.y);
		if (i >= 0) patch.decor[i] = D.none;
	}
}

function pickFiller(rng: Rng): StructureKind {
	const index = rng.weighted(FILLER.map(([, weight]) => weight));
	return FILLER[index]?.[0] ?? "house";
}

/** Shrink a plot to a buildable rectangle with a little jitter. */
function fitRect(plot: Rect, size: "small" | "medium" | "large", rng: Rng): Rect {
	const target = size === "large" ? 11 : size === "medium" ? 8 : 6;
	const w = Math.min(plot.w, Math.max(5, Math.min(target, plot.w - rng.int(2))));
	const h = Math.min(plot.h, Math.max(5, Math.min(target, plot.h - rng.int(2))));
	return {
		x: plot.x + rng.int(Math.max(1, plot.w - w + 1)),
		y: plot.y + rng.int(Math.max(1, plot.h - h + 1)),
		w,
		h,
	};
}

function rectFullyBuildable(rect: Rect, buildable: (x: number, y: number) => boolean): boolean {
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			if (!buildable(x, y)) return false;
		}
	}
	return true;
}

function flattestNear(seed: number, centre: Vec2, reach: number): Vec2 {
	let best = centre;
	let bestSlope = Number.POSITIVE_INFINITY;
	for (let dy = -reach; dy <= reach; dy++) {
		for (let dx = -reach; dx <= reach; dx++) {
			const x = centre.x + dx;
			const y = centre.y + dy;
			if (elevationAt(seed, x, y) < SEA_LEVEL + 0.02) continue;
			const slope = slopeAt(seed, x, y);
			if (slope < bestSlope) {
				bestSlope = slope;
				best = { x, y };
			}
		}
	}
	return best;
}

function stampDisc(
	patch: FeaturePatch,
	centre: Vec2,
	radius: number,
	terrain: number,
	allowed: (x: number, y: number) => boolean,
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

function stampRing(
	centre: Vec2,
	radiusAt: (angle: number) => number,
	allowed: (x: number, y: number) => boolean,
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

function firstPointInside(
	points: readonly Vec2[],
	inside: (x: number, y: number) => boolean,
): Vec2 | undefined {
	return points.find((p) => inside(p.x, p.y));
}

function carveStreet(
	patch: FeaturePatch,
	from: Vec2,
	to: Vec2,
	allowed: (x: number, y: number) => boolean,
	terrain: number,
): void {
	const bounds = expandedBounds(patch.bounds);
	const path = findPath(from, to, {
		bounds,
		cost: (x, y) => (allowed(x, y) ? 1 : Number.POSITIVE_INFINITY),
		diagonal: false,
	});
	if (!path) return;
	for (const p of path) patchWrite(patch, p.x, p.y, terrain);
}

function expandedBounds(bounds: Rect): Rect {
	return bounds;
}

/** Nearest already-written road tile to a rectangle, for door orientation. */
function nearestStreet(patch: FeaturePatch, rect: Rect): Vec2 | undefined {
	const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
	let best: Vec2 | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	const search = 14;
	for (let dy = -search; dy <= search; dy++) {
		for (let dx = -search; dx <= search; dx++) {
			const x = Math.round(centre.x) + dx;
			const y = Math.round(centre.y) + dy;
			const i = patchIndex(patch, x, y);
			if (i < 0) continue;
			const terrain = patch.terrain[i];
			if (terrain !== T.cobbleRoad && terrain !== T.dirtRoad && terrain !== T.path) continue;
			const d = dx * dx + dy * dy;
			if (d < bestDistance) {
				bestDistance = d;
				best = { x, y };
			}
		}
	}
	return best;
}

/**
 * Connect the square to every anchor.
 *
 * Building walls cost `Infinity`, so a route into a shop must use the door. If
 * an anchor is genuinely unreachable the path simply is not carved — which is
 * caught by the connectivity test rather than papered over at runtime. This
 * replaces the old design's wall-breaking hack, where the player pressing SPACE
 * at an unreachable objective would overwrite the stone wall in front of them.
 */
function carveConnections(
	patch: FeaturePatch,
	square: Vec2,
	anchors: readonly Anchor[],
	buildable: (x: number, y: number) => boolean,
): void {
	const cost = (x: number, y: number): number => {
		const i = patchIndex(patch, x, y);
		if (i < 0) return Number.POSITIVE_INFINITY;
		const flags = patch.flags[i] ?? 0;
		if (flags & TFlag.Wall && !(flags & TFlag.Door)) return Number.POSITIVE_INFINITY;
		if (flags & TFlag.Door) return 2;
		if (flags & TFlag.Passable) return 1;
		// Unwritten ground inside the footprint may be carved; outside it may not.
		return buildable(x, y) ? 3 : Number.POSITIVE_INFINITY;
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
			{ x: square.x, y: square.y },
			{ x: anchor.x, y: anchor.y },
			{
				bounds: patch.bounds,
				cost,
				diagonal: false,
			},
		);
		if (!path) continue;
		for (const p of path) {
			const i = patchIndex(patch, p.x, p.y);
			if (i < 0) continue;
			const flags = patch.flags[i] ?? 0;
			// Never overwrite a door, a wall, or an existing road with plain path.
			if (flags & (TFlag.Wall | TFlag.Door)) continue;
			if (flags & TFlag.Interior) continue;
			const terrain = patch.terrain[i] ?? T.void;
			if (terrain === T.cobbleRoad || terrain === T.dirtRoad) continue;
			patchWrite(patch, p.x, p.y, T.path);
		}
	}
}

/** Every settlement patch whose bounds overlap a rectangle. */
export function settlementsOverlapping(
	seed: number,
	sites: readonly MacroSite[],
	specFor: (site: MacroSite) => SettlementSpec,
	area: Rect,
): FeaturePatch[] {
	const patches: FeaturePatch[] = [];
	for (const site of sites) {
		// Reject on the site's declared bounds first; generating a settlement in
		// order to discover it is somewhere else costs tens of milliseconds.
		if (!rectIntersection(settlementBounds(site), area)) continue;
		patches.push(generateSettlement(seed, site, specFor(site)));
	}
	// Deterministic priority: larger id wins where two settlements overlap.
	patches.sort((a, b) => a.id - b.id);
	return patches;
}

export type { Anchor, BuildingPlacement };
