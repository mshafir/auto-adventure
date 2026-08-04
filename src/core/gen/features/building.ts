import type { Rect, Vec2 } from "../../geom/vec.js";
import type { Rng } from "../../rand/rng.js";
import { D } from "../../tiles/decor.js";
import { TFlag } from "../../tiles/flags.js";
import { T, type TerrainId } from "../../tiles/terrain.js";
import {
	type Anchor,
	type BuildingPlacement,
	type FeaturePatch,
	patchDecor,
	patchIndex,
	patchWrite,
	type StructureKind,
} from "./patch.js";

export interface BuildingMaterials {
	readonly wall: TerrainId;
	/** What fills the footprint as seen from outside: a roof, or open sky. */
	readonly cover: TerrainId;
}

function materialsFor(kind: StructureKind): BuildingMaterials {
	switch (kind) {
		case "temple":
		case "barracks":
		case "tower":
		case "smithy":
			return { wall: T.stoneWall, cover: T.roof };
		// A ruin is roofless by definition, and its rubble is the point.
		case "ruin":
			return { wall: T.stoneWall, cover: T.rubble };
		default:
			return { wall: T.woodWall, cover: T.roof };
	}
}

/** Shops put a board out front; a farmhouse does not. */
function hasSign(kind: StructureKind): boolean {
	return (
		kind === "shop" ||
		kind === "inn" ||
		kind === "smithy" ||
		kind === "apothecary" ||
		kind === "stable" ||
		kind === "mill"
	);
}

function interiorAnchors(kind: StructureKind): readonly Anchor["kind"][] {
	switch (kind) {
		case "shop":
		case "apothecary":
			return ["counter", "backroom"];
		case "inn":
			return ["counter", "hearth", "backroom"];
		case "smithy":
			return ["counter", "hearth"];
		case "temple":
		case "shrine":
			return ["hearth"];
		case "barracks":
		case "tower":
			return ["hearth", "backroom"];
		default:
			return ["hearth"];
	}
}

export interface BuildResult {
	readonly placement: BuildingPlacement;
	readonly anchors: readonly Anchor[];
}

/**
 * Stamp one building into a patch.
 *
 * The door is placed on the plot edge *facing the nearest street tile*, chosen
 * by construction rather than found by searching afterwards. That ordering is
 * what makes the carve pass able to treat building walls as infinitely
 * expensive: there is always a legitimate way in, so nothing ever needs to
 * punch through a wall to reach the inside.
 */
export function buildStructure(
	patch: FeaturePatch,
	index: number,
	kind: StructureKind,
	rect: Rect,
	streetTarget: Vec2,
	interiorId: number,
	rng: Rng,
	details?: { readonly name?: string; readonly signText?: string },
): BuildResult {
	const { wall, cover } = materialsFor(kind);
	const anchors: Anchor[] = [];

	// Roofed, not floored. Interiors are separate grids, so the tiles inside the
	// wall ring are only ever seen from outside and from above — writing the floor
	// there drew the floorboards of a closed building through its own roof, and a
	// town came out looking like an architect's plan rather than a place.
	for (let y = rect.y; y < rect.y + rect.h; y++) {
		for (let x = rect.x; x < rect.x + rect.w; x++) {
			const onEdge =
				x === rect.x || y === rect.y || x === rect.x + rect.w - 1 || y === rect.y + rect.h - 1;
			patchWrite(patch, x, y, onEdge ? wall : cover, onEdge ? 0 : TFlag.Interior);
		}
	}

	const door = pickDoor(rect, streetTarget);
	patchWrite(patch, door.x, door.y, T.doorClosed);

	// Windows flank the door along the same wall, strictly between the corners
	// so a window never replaces a load-bearing corner tile.
	const onHorizontalWall = door.y === rect.y || door.y === rect.y + rect.h - 1;
	for (const offset of [-2, 2]) {
		const wx = onHorizontalWall ? door.x + offset : door.x;
		const wy = onHorizontalWall ? door.y : door.y + offset;
		const withinWall = onHorizontalWall
			? wx > rect.x && wx < rect.x + rect.w - 1
			: wy > rect.y && wy < rect.y + rect.h - 1;
		if (withinWall) patchWrite(patch, wx, wy, T.window);
	}

	// The step outside the door is always walkable: it is the seam between the
	// building and the street, and the carve pass routes to it.
	const step = outwardOf(rect, door);
	patchWrite(patch, step.x, step.y, T.path);
	anchors.push({
		id: `b${index}:doorstep`,
		kind: "doorstep",
		x: step.x,
		y: step.y,
		building: index,
	});

	let signAt: Vec2 | undefined;
	if (hasSign(kind)) {
		const beside = besideStep(rect, door, step);
		if (beside) {
			patchWrite(patch, beside.x, beside.y, T.path);
			patchDecor(patch, beside.x, beside.y, D.sign);
			signAt = beside;
		}
	}

	/**
	 * Somewhere to stand that is not the doorway.
	 *
	 * The doorstep is the *only* tile a door can be entered from — the other three
	 * neighbours are its own wall — so anyone standing there seals the building.
	 * Reported by nothing, because it looks like a shopkeeper waiting outside their
	 * shop; found by trying to walk into one. In one measured village every single
	 * door had its owner in it and not one building could be entered at any hour.
	 *
	 * No terrain is written here. Claiming the tile could overwrite a neighbour's
	 * wall, and the ground pass has already made everything buildable walkable, so
	 * a tile that is not passable now is one that belongs to something else.
	 */
	const yard = yardBeside(rect, door, step, signAt);
	if (yard && (patch.flags[patchIndex(patch, yard.x, yard.y)] ?? 0) & TFlag.Passable) {
		anchors.push({ id: `b${index}:yard`, kind: "yard", x: yard.x, y: yard.y, building: index });
	}

	// Interior anchors sit on floor tiles, away from the door.
	const inner = { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 };
	for (const anchorKind of interiorAnchors(kind)) {
		const spot = interiorSpot(inner, anchorKind, rng);
		if (!spot) continue;
		anchors.push({
			id: `b${index}:${anchorKind}`,
			kind: anchorKind,
			x: spot.x,
			y: spot.y,
			building: index,
		});
	}

	const placement: BuildingPlacement = {
		index,
		kind,
		rect,
		door,
		interiorId,
		...(signAt ? { signAt } : {}),
		...(details?.name ? { name: details.name } : {}),
		...(details?.signText ? { signText: details.signText } : {}),
	};

	return { placement, anchors };
}

/** The edge cell closest to the street, clamped away from the corners. */
function pickDoor(rect: Rect, target: Vec2): Vec2 {
	const right = rect.x + rect.w - 1;
	const bottom = rect.y + rect.h - 1;
	const clampX = (v: number) => Math.min(right - 1, Math.max(rect.x + 1, v));
	const clampY = (v: number) => Math.min(bottom - 1, Math.max(rect.y + 1, v));

	const candidates: readonly Vec2[] = [
		{ x: clampX(target.x), y: rect.y },
		{ x: clampX(target.x), y: bottom },
		{ x: rect.x, y: clampY(target.y) },
		{ x: right, y: clampY(target.y) },
	];

	let best = candidates[0] as Vec2;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of candidates) {
		const d = (candidate.x - target.x) ** 2 + (candidate.y - target.y) ** 2;
		if (d < bestDistance) {
			bestDistance = d;
			best = candidate;
		}
	}
	return best;
}

function outwardOf(rect: Rect, door: Vec2): Vec2 {
	if (door.y === rect.y) return { x: door.x, y: door.y - 1 };
	if (door.y === rect.y + rect.h - 1) return { x: door.x, y: door.y + 1 };
	if (door.x === rect.x) return { x: door.x - 1, y: door.y };
	return { x: door.x + 1, y: door.y };
}

/** A tile beside the doorstep, along the wall, for the shop sign. */
function besideStep(rect: Rect, door: Vec2, step: Vec2): Vec2 | undefined {
	const horizontalWall = door.y === rect.y || door.y === rect.y + rect.h - 1;
	const candidate = horizontalWall ? { x: step.x + 1, y: step.y } : { x: step.x, y: step.y + 1 };
	return candidate;
}

/**
 * A tile next to the doorstep for somebody to stand on.
 *
 * Along the wall first, so they read as belonging to the building, and on the
 * side the sign did not take. Then one further out, for a doorway wedged against
 * a neighbour.
 */
function yardBeside(rect: Rect, door: Vec2, step: Vec2, sign: Vec2 | undefined): Vec2 | undefined {
	const horizontalWall = door.y === rect.y || door.y === rect.y + rect.h - 1;
	const out = { x: step.x - door.x, y: step.y - door.y };
	const candidates: readonly Vec2[] = horizontalWall
		? [
				{ x: step.x - 1, y: step.y },
				{ x: step.x + 1, y: step.y },
				{ x: step.x - 1, y: step.y + out.y },
				{ x: step.x + 1, y: step.y + out.y },
			]
		: [
				{ x: step.x, y: step.y - 1 },
				{ x: step.x, y: step.y + 1 },
				{ x: step.x + out.x, y: step.y - 1 },
				{ x: step.x + out.x, y: step.y + 1 },
			];
	return candidates.find((c) => !(sign && c.x === sign.x && c.y === sign.y));
}

function interiorSpot(inner: Rect, kind: Anchor["kind"], rng: Rng): Vec2 | undefined {
	if (inner.w < 1 || inner.h < 1) return undefined;
	switch (kind) {
		case "counter":
			// Counters face the entrance, so put them at the front of the room.
			return { x: inner.x + Math.floor(inner.w / 2), y: inner.y };
		case "hearth":
			return { x: inner.x + inner.w - 1, y: inner.y + inner.h - 1 };
		case "backroom":
			return { x: inner.x, y: inner.y + inner.h - 1 };
		default:
			return {
				x: inner.x + rng.int(Math.max(1, inner.w)),
				y: inner.y + rng.int(Math.max(1, inner.h)),
			};
	}
}

/** Minimum plot a given structure needs, as `[width, height]`. */
export function minimumPlot(kind: StructureKind, size: "small" | "medium" | "large"): Vec2 {
	const base = size === "large" ? 9 : size === "medium" ? 7 : 5;
	switch (kind) {
		case "temple":
		case "barracks":
		case "warehouse":
		case "barn":
			return { x: base + 2, y: base + 1 };
		case "tower":
			return { x: 5, y: 5 };
		default:
			return { x: base, y: base };
	}
}
