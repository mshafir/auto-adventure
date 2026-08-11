import { bspSplit } from "../../geom/bsp.js";
import { rasterizePolyline } from "../../geom/line.js";
import { type Rect, rectIntersects, type Vec2 } from "../../geom/vec.js";
import { hash2 } from "../../rand/hash.js";
import { type Rng, rngFor } from "../../rand/rng.js";
import type { Lock } from "../../rules/lock.js";
import { D } from "../../tiles/decor.js";
import { T } from "../../tiles/terrain.js";
import type { MacroSite } from "../../world/macro.js";
import type { WorldSeed } from "../../world/recipe.js";
import { roadsAround } from "../../world/roads.js";
import { buildStructure } from "./building.js";
import {
	type Anchor,
	type BuildingPlacement,
	createPatch,
	type FeaturePatch,
	patchIndex,
	patchWrite,
	type StructureKind,
} from "./patch.js";
import { assignPlots, type PlotRequest } from "./plots.js";
import { featureBounds, generateFeature, registerFeature } from "./registry.js";
import {
	type Allowed,
	buildableWithin,
	carveConnections,
	carveStreet,
	flattestNear,
	reachableFrom,
	rectFullyAllowed,
	stampDisc,
	stampRing,
} from "./terraform.js";

export interface StructureSpec {
	readonly kind: StructureKind;
	readonly size: "small" | "medium" | "large";
	/** 1..5. Used to decide who gets a plot when there are more specs than plots. */
	readonly importance: number;
	readonly name?: string;
	readonly signText?: string;
	/** What has to be true to get inside. Absent means the door simply opens. */
	readonly lock?: Lock;
	/**
	 * A handle for this structure, so something else can refer to it.
	 *
	 * Needed because `required` and the relations in `plots.ts` are about *this*
	 * building and not about its kind: a settlement with three houses and one required
	 * counting house cannot express either without a way to name the one that matters.
	 */
	readonly id?: string;
	/**
	 * Whether the settlement must contain this, or may substitute filler for it.
	 *
	 * The flag that makes a spec binding. Without it the assignment pass is advisory all
	 * the way down — a plot too small yields filler and the story's counting house
	 * quietly becomes a house — and nothing downstream can tell the difference between a
	 * building the author wanted and one the roll happened to place.
	 */
	readonly required?: boolean;
}

export interface SettlementSpec {
	readonly name?: string;
	readonly walled: boolean;
	readonly structures: readonly StructureSpec[];
}

/**
 * The settlement at a site.
 *
 * A thin call through the registry, which owns the cache. Kept as its own name
 * because "build a settlement here" is a different question from "build whatever
 * belongs here", and the callers that ask this one — the validator, placement
 * resolution, the survey tool — have already established that a settlement is what
 * is there.
 */
export function generateSettlement(
	world: WorldSeed,
	site: MacroSite,
	spec: SettlementSpec,
): FeaturePatch {
	const patch = generateFeature(world, site, spec);
	if (patch) return patch;
	// A site kind no builder claims. Building one anyway, uncached, is better than
	// throwing at a caller who only wanted to look at some anchors.
	return buildSettlement(world, site, spec);
}

/**
 * A site's patch bounds, computable without generating it.
 *
 * @deprecated Prefer {@link featureBounds}; kept because a settlement's bounds are
 * asked for by name in several places that predate the registry.
 */
export function settlementBounds(site: MacroSite, world: WorldSeed): Rect {
	return featureBounds(site, world);
}

/** The bounds a settlement patch occupies, independent of the registry. */
function settlementRect(site: MacroSite): Rect {
	const radius = site.radius;
	return {
		x: site.site.x - radius - 2,
		y: site.site.y - radius - 2,
		w: radius * 2 + 5,
		h: radius * 2 + 5,
	};
}

registerFeature({
	id: "settlement",
	accepts: ["hamlet", "village", "town", "fort", "camp", "ruins", "landmark"],
	bounds: (site) => settlementRect(site),
	build: (world, site, spec) => buildSettlement(world, site, spec),
});

function buildSettlement(world: WorldSeed, site: MacroSite, spec: SettlementSpec): FeaturePatch {
	const rng = rngFor(world.seed, "settlement", site.mx, site.my);
	const radius = site.radius;
	const bounds = settlementRect(site);

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
	const buildable: Allowed = buildableWithin(world, inFootprint);

	// --- ground --------------------------------------------------------------
	for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
		for (let x = bounds.x; x < bounds.x + bounds.w; x++) {
			if (!buildable(x, y)) continue;
			patchWrite(patch, x, y, rng.chance(0.12) ? T.grass : T.dirt);
		}
	}

	// --- town square ---------------------------------------------------------
	const square = flattestNear(world, site.site, 5);
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
	for (const road of roadsAround(world, site.mx, site.my)) {
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
				rectFullyAllowed(plot, buildable),
		)
		.sort((a, b) => b.w * b.h - a.w * a.h);

	// --- assign structures to plots -----------------------------------------
	// Requirements are solved first and filler takes what is left; see `plots.ts` for
	// why the old importance sort could not express that. `id` falls back to the spec's
	// index so every request has a distinct handle even when the author gave none.
	const requests: PlotRequest[] = spec.structures.map((structure, index) => ({
		id: structure.id ?? `s${index}`,
		kind: structure.kind,
		size: structure.size,
		importance: structure.importance,
		required: structure.required ?? false,
		relations: [],
	}));

	const gates = anchors
		.filter((anchor) => anchor.kind === "gate")
		.map((anchor) => ({ x: anchor.x, y: anchor.y }));

	const solution = assignPlots({ plots, square, gates, centre: site.site, radius }, requests);

	const specByRequestId = new Map(
		spec.structures.map((structure, index) => [structure.id ?? `s${index}`, structure] as const),
	);
	const assignedTo = new Map(
		solution.assignments.map((assignment) => [assignment.plot, assignment.request] as const),
	);
	const blocked = new Set(solution.blocked);

	plots.forEach((plot, i) => {
		// A plot an isolated building keeps clear stays clear. Building filler here would
		// undo the isolation the requirement asked for.
		if (blocked.has(i)) return;

		const request = assignedTo.get(i);
		const assigned = request ? specByRequestId.get(request.id) : undefined;
		const kind: StructureKind = assigned?.kind ?? pickFiller(world, rng);
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
			assigned
				? {
						name: assigned.name,
						signText: assigned.signText,
						lock: assigned.lock,
						required: assigned.required ?? false,
					}
				: undefined,
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

/**
 * Demolish what the carve pass could not reach — except what the story needs.
 *
 * A building walled in by its neighbours is demolished rather than shipped, because the
 * alternative the old design took was letting the player break the wall at runtime,
 * which turned every unreachable objective into a hole punched through stone.
 *
 * A *required* building is different: demolishing it is the very substitution
 * `plots.ts` exists to prevent, arriving one pass later. So a required building that
 * cannot be reached takes a neighbour down instead — the nearest non-required building —
 * and the carve is retried. If that still does not open a route the building is kept,
 * unreachable, and the `buildings-reachable` invariant reports it. Kept rather than
 * demolished on purpose: a building standing in the wrong place is a bug somebody can
 * see and fix, and a building that was silently deleted is the bug that took a
 * playthrough to find.
 */
function pruneUnreachable(
	patch: FeaturePatch,
	square: Vec2,
	buildings: BuildingPlacement[],
	anchors: Anchor[],
	buildable: Allowed,
	rng: Rng,
): void {
	for (let round = 0; round < MAX_PRUNE_ROUNDS; round++) {
		const reached = reachableFrom(patch, square, anchors);
		if (!reached) return;

		const stranded = new Set<number>();
		for (const anchor of anchors) {
			if (anchor.kind !== "doorstep" || anchor.building === undefined) continue;
			if (!reached.has(anchor)) stranded.add(anchor.building);
		}
		if (stranded.size === 0) return;

		const isRequired = (index: number) =>
			buildings.find((building) => building.index === index)?.required === true;

		// What actually comes down this round: the stranded buildings that may be
		// demolished, plus one sacrificial neighbour for each stranded one that may not.
		const doomed = new Set<number>();
		for (const index of stranded) {
			if (!isRequired(index)) {
				doomed.add(index);
				continue;
			}
			const neighbour = nearestExpendable(buildings, index, doomed);
			if (neighbour !== undefined) doomed.add(neighbour);
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

		// Re-carve: removing a building may open a route the previous pass could not find.
		carveConnections(patch, square, anchors, buildable);
	}
}

/**
 * The nearest building that may be knocked down to open a route to `index`.
 *
 * By squared distance between footprint centres, with the building index as the
 * tie-break, so two equidistant neighbours always resolve the same way — this runs
 * inside settlement generation, where a coin toss would make two chunks disagree.
 */
function nearestExpendable(
	buildings: readonly BuildingPlacement[],
	index: number,
	already: ReadonlySet<number>,
): number | undefined {
	const subject = buildings.find((building) => building.index === index);
	if (!subject) return undefined;
	const centreOf = (building: BuildingPlacement) => ({
		x: building.rect.x + building.rect.w / 2,
		y: building.rect.y + building.rect.h / 2,
	});
	const from = centreOf(subject);

	let best: number | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const building of [...buildings].sort((a, b) => a.index - b.index)) {
		if (building.index === index) continue;
		if (building.required) continue;
		if (already.has(building.index)) continue;
		const to = centreOf(building);
		const distance = (to.x - from.x) ** 2 + (to.y - from.y) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			best = building.index;
		}
	}
	return best;
}

/** Return a building's footprint to open ground. */
function demolish(
	patch: FeaturePatch,
	building: BuildingPlacement,
	buildable: Allowed,
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

function pickFiller(world: WorldSeed, rng: Rng): StructureKind {
	const filler = world.rules.sites.filler;
	if (filler.length === 0) return "house";
	const index = rng.weighted(filler.map(([, weight]) => weight));
	return filler[index]?.[0] ?? "house";
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

function firstPointInside(
	points: readonly Vec2[],
	inside: (x: number, y: number) => boolean,
): Vec2 | undefined {
	return points.find((p) => inside(p.x, p.y));
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

export type { Anchor, BuildingPlacement };
