import { bspSplit } from "../../geom/bsp.js";
import { type Rect, rectIntersects, type Vec2 } from "../../geom/vec.js";
import { hash2 } from "../../rand/hash.js";
import { rngFor } from "../../rand/rng.js";
import { D } from "../../tiles/decor.js";
import { T } from "../../tiles/terrain.js";
import type { MacroSite } from "../../world/macro.js";
import type { WorldSeed } from "../../world/recipe.js";
import { roadsAround } from "../../world/roads.js";
import { buildStructure, minimumPlot } from "./building.js";
import { createPatch, type FeaturePatch, patchDecor, patchWrite } from "./patch.js";
import { registerFeature } from "./registry.js";
import type { SettlementSpec } from "./settlement.js";
import {
	type Allowed,
	buildableWithin,
	carveConnections,
	carveStreet,
	flattestNear,
	rectFullyAllowed,
	stampRect,
} from "./terraform.js";

/**
 * A castle: a curtain wall with one way in, and a keep inside it.
 *
 * Deliberately rectangular where a settlement is a deformed circle. A town's outline
 * follows the ground because a town grew; a castle's does not, because a castle was
 * *set down*, and the straight line is most of what makes it read as built rather
 * than as a walled village. It also makes the one property that matters easy to
 * guarantee: exactly one gap in the wall, so the gatehouse is genuinely the only way
 * in and a barrier stamped across it genuinely bars the way.
 *
 * The gatehouse emits its position as an anchor rather than stamping a gate tile. A
 * gate that is *barred* is a scenario's decision — it needs a condition to open it and
 * something to say when it will not — and the generator has no business inventing one.
 * What the generator owes is a single choke point that a scenario can put a gate on.
 */

/** Wall inset from the site radius, leaving a skirt of open ground outside. */
const WALL_INSET = 4;

/** How wide the gap in the curtain wall is. Three tiles: a gatehouse, not a doorway. */
const GATE_WIDTH = 3;

function castleRect(site: MacroSite): Rect {
	const radius = site.radius;
	return {
		x: site.site.x - radius - 2,
		y: site.site.y - radius - 2,
		w: radius * 2 + 5,
		h: radius * 2 + 5,
	};
}

registerFeature({
	id: "castle",
	accepts: ["castle"],
	bounds: castleRect,
	build: buildCastle,
});

export function buildCastle(world: WorldSeed, site: MacroSite, spec: SettlementSpec): FeaturePatch {
	const rng = rngFor(world.seed, "castle", site.mx, site.my);
	const bounds = castleRect(site);
	const { patch, buildings, anchors } = createPatch(site.id, bounds);

	const centre = flattestNear(world, site.site, 4);
	const chosen = castleYard(world, site, centre);
	// No square of ground big enough. An empty patch leaves the wilderness exactly as
	// it was, which is far better than the alternative: a curtain wall with the low
	// ground bitten out of it is a castle you can walk into from three sides, and the
	// scenario that barred its gate has barred nothing.
	if (!chosen) return patch;
	const yard = chosen;

	const inFootprint: Allowed = (x, y) =>
		x >= yard.x - 2 && y >= yard.y - 2 && x < yard.x + yard.w + 2 && y < yard.y + yard.h + 2;
	const buildable = buildableWithin(world, inFootprint);

	for (let y = yard.y; y < yard.y + yard.h; y++) {
		for (let x = yard.x; x < yard.x + yard.w; x++) {
			if (buildable(x, y)) patchWrite(patch, x, y, rng.chance(0.18) ? T.grass : T.dirt);
		}
	}

	// --- curtain wall --------------------------------------------------------
	stampRect(patch, yard, T.stoneWall, buildable);

	// Corner towers, stamped as solid blocks of wall: from outside a tower is a
	// thicker corner, and there is nothing inside one worth walking into.
	for (const [cx, cy] of [
		[yard.x, yard.y],
		[yard.x + yard.w - 1, yard.y],
		[yard.x, yard.y + yard.h - 1],
		[yard.x + yard.w - 1, yard.y + yard.h - 1],
	] as const) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (inside(yard, x, y) || !buildable(x, y)) continue;
				patchWrite(patch, x, y, T.stoneWall);
			}
		}
	}

	// --- the way in ----------------------------------------------------------
	// On the side the nearest road approaches from, so the gatehouse faces the
	// country rather than the back of a hill.
	const approach = nearestApproach(world, site, centre);
	const gate = gateSpan(yard, approach);
	for (const tile of gate.tiles) {
		if (buildable(tile.x, tile.y)) patchWrite(patch, tile.x, tile.y, T.cobbleRoad);
	}
	anchors.push({ id: "gate:castle", kind: "gate", x: gate.centre.x, y: gate.centre.y });
	// A banner either side of the arch, so the entrance reads as the entrance.
	for (const post of gate.flanks) {
		if (buildable(post.x, post.y)) patchDecor(patch, post.x, post.y, D.banner);
	}

	// The road outside, run from the gate to the edge of the footprint, so an
	// approaching player has something to follow in.
	carveStreet(patch, gate.outside, gate.centre, buildable, T.cobbleRoad);

	// --- courtyard -----------------------------------------------------------
	const court = flattestNear(world, centre, 2);
	anchors.push({ id: "square", kind: "square", x: court.x, y: court.y });
	patchWrite(patch, court.x, court.y, T.cobbleRoad);
	for (const [index, [dx, dy]] of (
		[
			[2, 0],
			[-2, 0],
			[0, 2],
		] as const
	).entries()) {
		const x = court.x + dx;
		const y = court.y + dy;
		if (!buildable(x, y)) continue;
		patchWrite(patch, x, y, T.cobbleRoad);
		anchors.push({ id: `court:${index}`, kind: index === 0 ? "stall" : "bench", x, y });
	}

	// --- the keep ------------------------------------------------------------
	// Placed first and largest, opposite the gate, so the approach runs the length
	// of the courtyard to reach it.
	const keepRect = keepPlot(yard, approach);
	if (rectFullyAllowed(keepRect, buildable)) {
		const result = buildStructure(
			patch,
			buildings.length,
			"tower",
			keepRect,
			court,
			hash2(site.id, 0),
			rng,
			{ name: spec.name ? `the keep of ${spec.name}` : "the keep" },
		);
		buildings.push(result.placement);
		anchors.push(...result.anchors);
	}

	// --- the rest of the ward ------------------------------------------------
	const wardRect = { x: yard.x + 2, y: yard.y + 2, w: yard.w - 4, h: yard.h - 4 };
	if (wardRect.w >= 8 && wardRect.h >= 8) {
		const { leaves } = bspSplit(wardRect, rng, { minSize: 6, stopSize: 11, cutWidth: 2 });
		const taken: Rect[] = [keepRect, { x: court.x - 3, y: court.y - 3, w: 7, h: 7 }];
		// Largest plot first, so the big structures get the room they need before the
		// houses take it.
		const plots = leaves
			.map((leaf) => ({ x: leaf.x + 1, y: leaf.y + 1, w: leaf.w - 2, h: leaf.h - 2 }))
			.sort((a, b) => b.w * b.h - a.w * a.h);
		const wanted = [...spec.structures].sort((a, b) => b.importance - a.importance);

		for (const plot of plots) {
			if (plot.w < 5 || plot.h < 5) continue;
			if (taken.some((other) => rectIntersects(plot, other))) continue;
			if (!rectFullyAllowed(plot, buildable)) continue;

			// The first structure still waiting that *fits*, not simply the first still
			// waiting. Head-of-line blocking on a temple that needs eleven tiles leaves
			// every smaller plot in the ward empty behind it.
			const at = wanted.findIndex((candidate) => {
				const need = minimumPlot(candidate.kind, candidate.size);
				return plot.w >= need.x && plot.h >= need.y;
			});
			if (at < 0) continue;
			const assigned = wanted.splice(at, 1)[0] as (typeof wanted)[number];

			const index = buildings.length;
			const result = buildStructure(
				patch,
				index,
				assigned.kind,
				plot,
				court,
				hash2(site.id, index),
				rng,
				{
					...(assigned.name ? { name: assigned.name } : {}),
					...(assigned.signText ? { signText: assigned.signText } : {}),
					...(assigned.lock ? { lock: assigned.lock } : {}),
				},
			);
			buildings.push(result.placement);
			anchors.push(...result.anchors);
			taken.push(plot);
		}
	}

	// The gate to the courtyard first, so it is a proper road and the doorstep routes
	// below join it rather than each finding their own way to the gate.
	carveStreet(patch, gate.centre, court, buildable, T.cobbleRoad);
	carveConnections(patch, court, anchors, buildable, T.path);

	return patch;
}

function inside(rect: Rect, x: number, y: number): boolean {
	return x > rect.x && y > rect.y && x < rect.x + rect.w - 1 && y < rect.y + rect.h - 1;
}

/** Which wall the nearest road comes at, as a unit direction outward. */
function nearestApproach(world: WorldSeed, site: MacroSite, centre: Vec2): Vec2 {
	let best: Vec2 | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const road of roadsAround(world, site.mx, site.my)) {
		for (const point of road.points) {
			const d = (point.x - centre.x) ** 2 + (point.y - centre.y) ** 2;
			if (d < bestDistance) {
				bestDistance = d;
				best = point;
			}
		}
	}
	// No road within the halo: face south, which is the direction the player is most
	// likely to be coming from given the camera and nothing better to go on.
	if (!best) return { x: 0, y: 1 };
	const dx = best.x - centre.x;
	const dy = best.y - centre.y;
	return Math.abs(dx) > Math.abs(dy)
		? { x: Math.sign(dx) || 1, y: 0 }
		: { x: 0, y: Math.sign(dy) || 1 };
}

interface Gate {
	readonly tiles: readonly Vec2[];
	readonly centre: Vec2;
	/** The two wall tiles either side of the gap. */
	readonly flanks: readonly Vec2[];
	/** One tile outside the wall, where the approach road starts. */
	readonly outside: Vec2;
}

/** The gap in the curtain wall, centred on the side the approach comes from. */
function gateSpan(yard: Rect, approach: Vec2): Gate {
	const midX = yard.x + Math.floor(yard.w / 2);
	const midY = yard.y + Math.floor(yard.h / 2);
	const right = yard.x + yard.w - 1;
	const bottom = yard.y + yard.h - 1;
	const reach = Math.floor(GATE_WIDTH / 2);

	const tiles: Vec2[] = [];
	let centre: Vec2;
	let flanks: Vec2[];
	let outside: Vec2;

	if (approach.x !== 0) {
		const wallX = approach.x > 0 ? right : yard.x;
		centre = { x: wallX, y: midY };
		for (let d = -reach; d <= reach; d++) tiles.push({ x: wallX, y: midY + d });
		flanks = [
			{ x: wallX, y: midY - reach - 1 },
			{ x: wallX, y: midY + reach + 1 },
		];
		outside = { x: wallX + approach.x, y: midY };
	} else {
		const wallY = approach.y > 0 ? bottom : yard.y;
		centre = { x: midX, y: wallY };
		for (let d = -reach; d <= reach; d++) tiles.push({ x: midX + d, y: wallY });
		flanks = [
			{ x: midX - reach - 1, y: wallY },
			{ x: midX + reach + 1, y: wallY },
		];
		outside = { x: midX, y: wallY + approach.y };
	}

	return { tiles, centre, flanks, outside };
}

/** A plot for the keep, against the wall opposite the gate. */
function keepPlot(yard: Rect, approach: Vec2): Rect {
	const size = Math.max(7, Math.min(11, Math.floor(Math.min(yard.w, yard.h) / 3)));
	const midX = yard.x + Math.floor(yard.w / 2) - Math.floor(size / 2);
	const midY = yard.y + Math.floor(yard.h / 2) - Math.floor(size / 2);
	if (approach.x !== 0) {
		const x = approach.x > 0 ? yard.x + 2 : yard.x + yard.w - 2 - size;
		return { x, y: midY, w: size, h: size };
	}
	const y = approach.y > 0 ? yard.y + 2 : yard.y + yard.h - 2 - size;
	return { x: midX, y, w: size, h: size };
}

/**
 * The largest square of buildable ground a castle will fit on, centred where it can be.
 *
 * A settlement drapes itself over whatever ground it finds and simply does not build
 * on the parts that will not take it. A castle cannot do that: its whole point is a
 * continuous wall with one gap, and a wall with the low ground bitten out of it has
 * three. So the yard shrinks until it fits, and if nothing fits the castle is not
 * there at all.
 */
function castleYard(world: WorldSeed, site: MacroSite, centre: Vec2): Rect | undefined {
	const buildable = buildableWithin(world, () => true);
	const search = castleRect(site);

	// A summed-area table over "is this tile buildable", so the search below can ask
	// whether a whole square is clear in constant time. The naive version — test every
	// tile of every candidate square — is a thousand times more elevation samples, and
	// elevation is the most expensive thing the generator computes.
	const clear = new Int32Array((search.w + 1) * (search.h + 1));
	const at = (gx: number, gy: number) => clear[gy * (search.w + 1) + gx] as number;
	for (let gy = 1; gy <= search.h; gy++) {
		for (let gx = 1; gx <= search.w; gx++) {
			const ok = buildable(search.x + gx - 1, search.y + gy - 1) ? 1 : 0;
			clear[gy * (search.w + 1) + gx] = ok + at(gx - 1, gy) + at(gx, gy - 1) - at(gx - 1, gy - 1);
		}
	}
	const allClear = (gx: number, gy: number, w: number, h: number) =>
		at(gx + w, gy + h) - at(gx, gy + h) - at(gx + w, gy) + at(gx, gy) === w * h;

	// Largest first, and among equal sizes the one nearest where the site said it was.
	// A castle that has slid to the far rim of its own footprint is a castle the
	// scenario did not place.
	for (let inner = site.radius - WALL_INSET; inner >= MIN_HALF - WALL_INSET; inner--) {
		// Two tiles of margin all round: the corner towers stand outside the wall and
		// the approach road starts one tile beyond the gate.
		const span = inner * 2 + 5;
		if (span > search.w || span > search.h) continue;

		let best: Rect | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (let gy = 0; gy + span <= search.h; gy++) {
			for (let gx = 0; gx + span <= search.w; gx++) {
				if (!allClear(gx, gy, span, span)) continue;
				const cx = search.x + gx + inner + 2;
				const cy = search.y + gy + inner + 2;
				const distance = (cx - centre.x) ** 2 + (cy - centre.y) ** 2;
				if (distance < bestDistance) {
					bestDistance = distance;
					best = { x: cx - inner, y: cy - inner, w: inner * 2 + 1, h: inner * 2 + 1 };
				}
			}
		}
		if (best) return best;
	}
	return undefined;
}

/** Below this a castle is a tower with a fence round it. */
const MIN_HALF = 9;

/** Where a scenario should put a gate to bar the way in. Used by the validator and tools. */
export function castleGateTiles(world: WorldSeed, site: MacroSite): readonly Vec2[] {
	const centre = flattestNear(world, site.site, 4);
	const yard = castleYard(world, site, centre);
	if (!yard) return [];
	return gateSpan(yard, nearestApproach(world, site, centre)).tiles;
}
