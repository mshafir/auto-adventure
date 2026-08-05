import { type Rect, rectIntersects, type Vec2 } from "../../geom/vec.js";
import { hash2 } from "../../rand/hash.js";
import { type Rng, rngFor } from "../../rand/rng.js";
import { D } from "../../tiles/decor.js";
import { T } from "../../tiles/terrain.js";
import { elevationAt } from "../../world/fields.js";
import type { MacroSite } from "../../world/macro.js";
import type { WorldSeed } from "../../world/recipe.js";
import { buildStructure, minimumPlot } from "./building.js";
import { createPatch, type FeaturePatch, patchDecor, patchTerrainAt, patchWrite } from "./patch.js";
import { registerFeature } from "./registry.js";
import type { SettlementSpec } from "./settlement.js";
import { type Allowed, carveConnections, rectFullyAllowed } from "./terraform.js";

/**
 * A working waterfront: piers out over the water, boats at them, sheds behind.
 *
 * The generator's usual move — pick a footprint, level it, fill it — does not work
 * here, because the interesting half of a dock is *not on land*. So this one starts
 * from the water: it finds the shoreline inside the site radius, orients everything
 * perpendicular to it, and only then decides where the buildings go. A dock laid out
 * land-first ends up with its piers running along the beach instead of out from it.
 *
 * A site with no usable shoreline builds nothing rather than building an inland
 * harbour. `accepts` cannot express that — whether there is water somewhere is not a
 * property of the site kind — so the empty patch is the honest answer, and the
 * recipe's own placement is what decides where a dock is worth asking for.
 */

/** How far out a pier runs from the last dry tile. */
const PIER_LENGTH = 7;

/** Tiles between piers, so a boat at one is not sitting on the next. */
const PIER_SPACING = 5;

/** How deep the made ground behind the waterline is. */
const QUAY_DEPTH = 3;

function docksRect(site: MacroSite): Rect {
	const radius = site.radius;
	return {
		x: site.site.x - radius - 2,
		y: site.site.y - radius - 2,
		w: radius * 2 + 5,
		h: radius * 2 + 5,
	};
}

registerFeature({
	id: "docks",
	accepts: ["docks"],
	bounds: docksRect,
	build: buildDocks,
});

export function buildDocks(world: WorldSeed, site: MacroSite, spec: SettlementSpec): FeaturePatch {
	const rng = rngFor(world.seed, "docks", site.mx, site.my);
	const bounds = docksRect(site);
	const { patch, buildings, anchors } = createPatch(site.id, bounds);

	const sea = world.rules.climate.seaLevel;
	const dry = (x: number, y: number) => elevationAt(world, x, y) >= sea;

	const shore = findShore(world, site, sea);
	// Nothing to build a harbour on. An empty patch writes no terrain at all, so the
	// wilderness the earlier stages produced stands, and the site simply is not there.
	if (!shore) return patch;

	const { quay, seaward } = shore;

	// Everything is measured from the quay rather than from the site centre, because
	// the site centre may be a hundred tiles inland or halfway out to sea.
	//
	// And the test is `dry`, not the usual `buildableWithin` — which insists on a
	// margin of 0.02 above sea level and therefore rejects the waterline itself. On a
	// gentle shore that margin is the entire beach, so the first version of this built
	// its quay and the feet of its piers nowhere at all.
	const onLand: Allowed = (x, y) =>
		Math.hypot(x - quay.x, y - quay.y) <= site.radius &&
		x >= bounds.x &&
		y >= bounds.y &&
		x < bounds.x + bounds.w &&
		y < bounds.y + bounds.h &&
		dry(x, y);

	// --- the hard standing ---------------------------------------------------
	// A band along the top of the beach, running with the shore rather than filling
	// the site radius. The first version stamped every tile within five of any water
	// across the whole footprint, which on an indented coast is not a quay at all —
	// it is a gravel stain in the shape of the coastline.
	const along: Vec2 = { x: -seaward.y, y: seaward.x };
	const pierCount = Math.max(2, Math.min(4, Math.round(site.radius / 5)));
	const reach = Math.floor(((pierCount - 1) * PIER_SPACING) / 2) + 3;

	for (let step = -reach; step <= reach; step++) {
		const root = waterlineAt(world, quay, along, seaward, step, sea);
		if (!root) continue;
		for (let back = 0; back < QUAY_DEPTH; back++) {
			const x = root.x - seaward.x * back;
			const y = root.y - seaward.y * back;
			if (!onLand(x, y)) continue;
			patchWrite(patch, x, y, back === 0 ? T.gravel : rng.chance(0.3) ? T.dirt : T.gravel);
		}
	}
	patchWrite(patch, quay.x, quay.y, T.cobbleRoad);
	anchors.push({ id: "square", kind: "square", x: quay.x, y: quay.y });

	// --- piers ---------------------------------------------------------------
	// Spaced along the shore so boats have room between them, and each one snapped to
	// its *own* waterline before it starts: a coast is not a straight line, and piers
	// all starting at the quay's waterline leave half of them beginning inland.
	const offset = -Math.floor(((pierCount - 1) * PIER_SPACING) / 2);

	for (let n = 0; n < pierCount; n++) {
		const step = offset + n * PIER_SPACING;
		const root = waterlineAt(world, quay, along, seaward, step, sea);
		if (!root) continue;
		const built = runPier(patch, root, seaward, dry, rng);
		if (!built) continue;
		anchors.push({ id: `pier:${n}`, kind: "bench", x: built.head.x, y: built.head.y });
		if (n === 0) {
			anchors.push({ id: "quay:stall", kind: "stall", x: built.foot.x, y: built.foot.y });
		}
	}

	// --- sheds behind --------------------------------------------------------
	// Searched for rather than computed. A shed wants to be near the quay and wholly
	// on dry land, and on an indented coast the tile eight paces inland is as likely to
	// be in the next inlet as on solid ground — the arithmetic version put every
	// warehouse in the sea and then quietly declined to build any of them.
	const inland: Vec2 = { x: -seaward.x, y: -seaward.y };
	const wanted = [...spec.structures].sort((a, b) => b.importance - a.importance);
	const taken: Rect[] = [];

	for (const assigned of wanted) {
		const need = minimumPlot(assigned.kind, assigned.size);
		const size = Math.max(6, Math.min(10, Math.max(need.x, need.y)));
		const plot = findPlot(size, quay, along, inland, site.radius, onLand, taken);
		if (!plot) continue;
		taken.push(plot);

		const index = buildings.length;
		const result = buildStructure(
			patch,
			index,
			assigned.kind,
			plot,
			quay,
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
	}

	carveConnections(patch, quay, anchors, onLand, T.path);
	return patch;
}

/**
 * Somewhere behind the quay to put a building.
 *
 * Sweeps inland-first so sheds crowd the water rather than sprawling up the hill,
 * and along the shore in both directions from the quay so they end up in a row.
 */
function findPlot(
	size: number,
	quay: Vec2,
	along: Vec2,
	inland: Vec2,
	radius: number,
	onLand: Allowed,
	taken: readonly Rect[],
): Rect | undefined {
	for (let back = QUAY_DEPTH + 1; back <= radius; back++) {
		for (let step = 0; step <= radius; step++) {
			for (const side of step === 0 ? [1] : [1, -1]) {
				const centre = {
					x: quay.x + inland.x * (back + size / 2) + along.x * step * side,
					y: quay.y + inland.y * (back + size / 2) + along.y * step * side,
				};
				const plot: Rect = {
					x: Math.round(centre.x - size / 2),
					y: Math.round(centre.y - size / 2),
					w: size,
					h: size,
				};
				// One tile of air between neighbours, or two sheds share a wall and the
				// carve pass cannot get a doorstep between them.
				const padded = { x: plot.x - 1, y: plot.y - 1, w: plot.w + 2, h: plot.h + 2 };
				if (taken.some((other) => rectIntersects(padded, other))) continue;
				if (!rectFullyAllowed(plot, onLand)) continue;
				return plot;
			}
		}
	}
	return undefined;
}

interface Shore {
	/** The dry tile the quay is centred on. */
	readonly quay: Vec2;
	/** Unit direction from the quay toward open water. */
	readonly seaward: Vec2;
}

/**
 * A stretch of shoreline worth putting a harbour on.
 *
 * Wants a dry tile with water on one side and room behind it, not merely any tile
 * adjacent to water — a puddle in a marsh satisfies the naive test and produces a
 * pier three tiles long running into a bog. Scored on how much open water lies in the
 * seaward direction, so a bay beats an inlet.
 */
function findShore(world: WorldSeed, site: MacroSite, sea: number): Shore | undefined {
	const centre = site.site;
	const reach = site.radius;
	let best: Shore | undefined;
	let bestScore = Number.NEGATIVE_INFINITY;

	// A coarse sweep: adjacent candidates score almost identically, so sampling every
	// second tile finds the same shore for a quarter of the work.
	for (let dy = -reach; dy <= reach; dy += 2) {
		for (let dx = -reach; dx <= reach; dx += 2) {
			const x = centre.x + dx;
			const y = centre.y + dy;
			if (elevationAt(world, x, y) < sea) continue;

			for (const seaward of DIRECTIONS) {
				let open = 0;
				for (let d = 1; d <= PIER_LENGTH + 3; d++) {
					if (elevationAt(world, x + seaward.x * d, y + seaward.y * d) < sea) open++;
					else break;
				}
				// Needs enough water to moor in and enough land to stand on.
				if (open < PIER_LENGTH) continue;
				let land = 0;
				for (let d = 1; d <= 6; d++) {
					if (elevationAt(world, x - seaward.x * d, y - seaward.y * d) >= sea) land++;
					else break;
				}
				if (land < 4) continue;

				// Prefer the shore nearest the site's own centre, so a scenario that put a
				// dock somewhere gets it near where it asked rather than at the far rim.
				// Nearness dominates: a scenario that put a dock somewhere means *there*,
				// and any shore with enough water to moor at will do.
				const score = open + land - Math.hypot(dx, dy) * 2;
				if (score > bestScore) {
					bestScore = score;
					best = { quay: { x, y }, seaward };
				}
			}
		}
	}
	return best;
}

const DIRECTIONS: readonly Vec2[] = [
	{ x: 1, y: 0 },
	{ x: -1, y: 0 },
	{ x: 0, y: 1 },
	{ x: 0, y: -1 },
];

/**
 * The last dry tile on the shore, `step` tiles along from the quay.
 *
 * A coastline is not a straight line, so the tile `step` along from the quay is
 * usually not on the waterline at all — it is a few tiles inland or already in the
 * water. Walking in the seaward direction until the ground runs out gives every pier
 * its own starting point, which is the difference between a row of piers and a row of
 * planks at random distances from the sea.
 */
function waterlineAt(
	world: WorldSeed,
	quay: Vec2,
	along: Vec2,
	seaward: Vec2,
	step: number,
	sea: number,
): Vec2 | undefined {
	const start = { x: quay.x + along.x * step, y: quay.y + along.y * step };
	const wet = (x: number, y: number) => elevationAt(world, x, y) < sea;

	// How far to hunt, scaled by how far along the shore we have come. A coast at
	// forty-five degrees moves the waterline one tile for every tile of travel, so a
	// fixed window finds the shore near the quay and nothing at the ends — which came
	// out as a harbour with one pier in the middle and empty beach either side.
	const slack = Math.abs(step) + QUAY_DEPTH + 2;

	// Already in the water: back up until we are not.
	if (wet(start.x, start.y)) {
		for (let d = 1; d <= slack; d++) {
			const back = { x: start.x - seaward.x * d, y: start.y - seaward.y * d };
			if (!wet(back.x, back.y)) return back;
		}
		return undefined;
	}

	// On land: walk out until the next tile is water.
	let at = start;
	for (let d = 0; d <= slack; d++) {
		const next = { x: at.x + seaward.x, y: at.y + seaward.y };
		if (wet(next.x, next.y)) return at;
		at = next;
	}
	return undefined;
}

/** One pier, run out from the last dry tile, with a boat moored at the head. */
function runPier(
	patch: FeaturePatch,
	foot: Vec2,
	seaward: Vec2,
	dry: (x: number, y: number) => boolean,
	rng: Rng,
): { foot: Vec2; head: Vec2 } | undefined {
	let head = foot;
	for (let d = 1; d <= PIER_LENGTH; d++) {
		const at = { x: foot.x + seaward.x * d, y: foot.y + seaward.y * d };
		// Stop at the far shore rather than paving across a strait.
		if (dry(at.x, at.y)) break;
		patchWrite(patch, at.x, at.y, T.pier);
		head = at;
	}
	if (head === foot) return undefined;

	patchWrite(patch, foot.x, foot.y, T.pier);
	patchDecor(patch, foot.x, foot.y, D.mooring);

	// A boat alongside the head of the pier, on whichever side the roll picks — both
	// are open water, which is the only thing that matters.
	const along: Vec2 = rng.chance(0.5)
		? { x: -seaward.y, y: seaward.x }
		: { x: seaward.y, y: -seaward.x };
	const berth = { x: head.x + along.x, y: head.y + along.y };
	if (!dry(berth.x, berth.y)) {
		patchWrite(patch, berth.x, berth.y, T.deck);
		patchDecor(patch, berth.x, berth.y, D.boat);
	}
	return { foot, head };
}

/** Where the piers of a dock will be, without building it. For tools and tests. */
export function dockPiers(world: WorldSeed, site: MacroSite): readonly Vec2[] {
	const shore = findShore(world, site, world.rules.climate.seaLevel);
	if (!shore) return [];
	const patch = buildDocks(world, site, { walled: false, structures: [] });
	const tiles: Vec2[] = [];
	for (let y = patch.bounds.y; y < patch.bounds.y + patch.bounds.h; y++) {
		for (let x = patch.bounds.x; x < patch.bounds.x + patch.bounds.w; x++) {
			if (patchTerrainAt(patch, x, y) === T.pier) tiles.push({ x, y });
		}
	}
	return tiles;
}
