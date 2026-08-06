import type { Rect, Vec2 } from "../../geom/vec.js";
import { hash2 } from "../../rand/hash.js";
import { rngFor } from "../../rand/rng.js";
import { TFlag } from "../../tiles/flags.js";
import { T } from "../../tiles/terrain.js";
import { elevationAt, roughnessAt, slopeAt } from "../../world/fields.js";
import type { MacroSite } from "../../world/macro.js";
import type { WorldSeed } from "../../world/recipe.js";
import { createPatch, type FeaturePatch, patchWrite } from "./patch.js";
import { registerFeature } from "./registry.js";
import type { SettlementSpec } from "./settlement.js";
import { type Allowed, buildableWithin, carveStreet } from "./terraform.js";

/**
 * A cave: a mouth in the rock, and a great deal of nothing on the surface.
 *
 * Almost all of a cave is its interior, which is generated separately and lazily like
 * every other interior. What belongs here is only what the player can see from
 * outside — an apron of scree, a face of rock, and the opening itself — and getting
 * *that* right is mostly about siting: a cave mouth in the middle of a meadow reads as
 * a hole somebody dug, and a cave mouth set into a hillside reads as a cave.
 *
 * So the mouth is placed on the steepest ground in the site, facing downhill, and the
 * rock face is stamped uphill behind it. If the site has no slope worth the name the
 * feature builds nothing: an empty patch leaves the wilderness exactly as it was, and
 * a site that quietly is not there is much better than a hole in a field.
 */

/** Below this slope there is no hillside to put a mouth in. */
const MIN_SLOPE = 0.012;

/** How far the scree apron reaches out from the mouth. */
const APRON = 4;

function caveRect(site: MacroSite): Rect {
	const radius = Math.max(6, site.radius);
	return {
		x: site.site.x - radius - 2,
		y: site.site.y - radius - 2,
		w: radius * 2 + 5,
		h: radius * 2 + 5,
	};
}

registerFeature({
	id: "cave",
	accepts: ["cave"],
	bounds: caveRect,
	build: buildCave,
});

export function buildCave(world: WorldSeed, site: MacroSite, _spec: SettlementSpec): FeaturePatch {
	const rng = rngFor(world.seed, "cave", site.mx, site.my);
	const bounds = caveRect(site);
	const { patch, buildings, anchors } = createPatch(site.id, bounds);

	const found = steepestIn(world, site);
	if (!found) return patch;
	const { at: mouth, downhill } = found;

	const inFootprint: Allowed = (x, y) => Math.hypot(x - mouth.x, y - mouth.y) <= APRON + 2;
	const buildable = buildableWithin(world, inFootprint);

	// --- the rock face -------------------------------------------------------
	// Uphill of the mouth, wide enough that the opening reads as being *in* something.
	const across: Vec2 = { x: -downhill.y, y: downhill.x };
	for (let side = -3; side <= 3; side++) {
		for (let back = 0; back <= 2; back++) {
			const x = mouth.x - downhill.x * back + across.x * side;
			const y = mouth.y - downhill.y * back + across.y * side;
			if (!buildable(x, y)) continue;
			// Taper: the face is deepest behind the mouth and thins at the edges.
			if (Math.abs(side) + back > 4) continue;
			patchWrite(patch, x, y, T.caveWall);
		}
	}

	// --- the apron -----------------------------------------------------------
	// Scree fanning downhill, so there is somewhere to stand and something that
	// looks like it fell out of the hole.
	for (let d = 1; d <= APRON; d++) {
		const width = Math.max(0, 3 - Math.floor(d / 2));
		for (let side = -width; side <= width; side++) {
			const x = mouth.x + downhill.x * d + across.x * side;
			const y = mouth.y + downhill.y * d + across.y * side;
			if (!buildable(x, y)) continue;
			patchWrite(patch, x, y, rng.chance(0.35) ? T.rubble : T.gravel);
		}
	}

	// --- the mouth -----------------------------------------------------------
	// Written last, so nothing above can bury it. A `BuildingPlacement`, because the
	// reducer's whole notion of going inside is "the tile ahead is a door belonging to
	// a building" — a cave that used its own mechanism would need that path written
	// twice, and the second copy is where the divergence lives.
	patchWrite(patch, mouth.x, mouth.y, T.caveMouth);
	const step = { x: mouth.x + downhill.x, y: mouth.y + downhill.y };
	patchWrite(patch, step.x, step.y, T.gravel);

	buildings.push({
		index: 0,
		kind: "cave",
		// A cave has no footprint to speak of: the mouth is the whole of it above ground.
		rect: { x: mouth.x, y: mouth.y, w: 1, h: 1 },
		door: mouth,
		interiorId: hash2(site.id, 0),
		name: "the cave mouth",
	});
	// Beside the step, not on it.
	//
	// A cave has one tile of approach: the mouth is one tile wide and the rock face
	// wraps it, so `step` is the only ground a player can walk into it from. Standing
	// anybody on that tile seals the cave — and seals it invisibly, because walking
	// into a person is how you talk to them, so every attempt to go in opens a
	// conversation instead and nothing anywhere says the way is blocked.
	//
	// The same mistake as the porter in the castle arch, and it cost the same thing:
	// the Green Knight tells the player to go down for the whetstone afterwards, then
	// stands in the doorway they would have to use.
	const aside = { x: step.x + across.x, y: step.y + across.y };
	const station = buildable(aside.x, aside.y) ? aside : step;
	anchors.push({ id: "b0:doorstep", kind: "doorstep", x: station.x, y: station.y, building: 0 });
	anchors.push({ id: "square", kind: "square", x: station.x, y: station.y });

	// A track down the scree, so the apron connects to whatever is below it.
	const foot = { x: mouth.x + downhill.x * (APRON + 1), y: mouth.y + downhill.y * (APRON + 1) };
	if (buildable(foot.x, foot.y)) carveStreet(patch, step, foot, buildable, T.path);

	return patch;
}

/**
 * The steepest standable tile in the site, and the direction downhill from it.
 *
 * Sampled coarsely: slope is smooth at this scale, so every second tile finds the
 * same hillside for a quarter of the elevation samples — and elevation is the
 * expensive field.
 */
function steepestIn(world: WorldSeed, site: MacroSite): { at: Vec2; downhill: Vec2 } | undefined {
	const sea = world.rules.climate.seaLevel;
	const reach = Math.max(6, site.radius);
	let best: Vec2 | undefined;
	let bestScore = MIN_SLOPE;

	for (let dy = -reach; dy <= reach; dy += 2) {
		for (let dx = -reach; dx <= reach; dx += 2) {
			const x = site.site.x + dx;
			const y = site.site.y + dy;
			if (elevationAt(world, x, y) < sea + 0.02) continue;
			// Rough *and* steep: a smooth steep slope is a grassy bank, and rock is what
			// a cave is in.
			const score = slopeAt(world, x, y) * (0.5 + roughnessAt(world, x, y));
			if (score > bestScore) {
				bestScore = score;
				best = { x, y };
			}
		}
	}
	if (!best) return undefined;

	// Downhill by the steepest of the four neighbours, so the mouth faces out of the
	// hill rather than into it.
	const here = elevationAt(world, best.x, best.y);
	let downhill: Vec2 = { x: 0, y: 1 };
	let drop = 0;
	for (const dir of [
		{ x: 1, y: 0 },
		{ x: -1, y: 0 },
		{ x: 0, y: 1 },
		{ x: 0, y: -1 },
	]) {
		const fall = here - elevationAt(world, best.x + dir.x * 3, best.y + dir.y * 3);
		if (fall > drop) {
			drop = fall;
			downhill = dir;
		}
	}
	return { at: best, downhill };
}

/** Whether a patch actually put a mouth down. Caves on flat ground build nothing. */
export function hasCaveMouth(patch: FeaturePatch): boolean {
	return patch.buildings.some((building) => building.kind === "cave");
}

/** The flag set a cave mouth carries, for tests that assert on it rather than on an id. */
export const CAVE_MOUTH_FLAGS = TFlag.Door | TFlag.Wall | TFlag.BlocksSight;
