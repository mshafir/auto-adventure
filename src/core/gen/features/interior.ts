import { rngFor } from "../../rand/rng.js";
import { D, type DecorId } from "../../tiles/decor.js";
import { TFlag } from "../../tiles/flags.js";
import { T, type TerrainId, terrainDef } from "../../tiles/terrain.js";
import type { StructureKind } from "./patch.js";

export interface Interior {
	readonly id: number;
	readonly kind: StructureKind;
	readonly width: number;
	readonly height: number;
	readonly terrain: Uint16Array;
	readonly decor: Uint16Array;
	readonly flags: Uint8Array;
	/** Where the player appears on entering, and where the exit door is. */
	readonly entrance: { readonly x: number; readonly y: number };
	readonly anchors: readonly { readonly kind: string; readonly x: number; readonly y: number }[];
}

const interiorCache = new Map<string, Interior>();

/**
 * Interiors are separate grids, generated on demand.
 *
 * They are deliberately *not* stamped into the world. Stamping would force a
 * building's exterior footprint to be as large as everything inside it, which
 * collapses town density — a inn with a common room, a hearth and four beds
 * would need a twenty-tile frontage. Keeping them separate means a modest
 * building can hold a room worth walking into.
 *
 * Generated lazily and cached, because most buildings in a town are never
 * entered.
 */
export function getInterior(seed: number, interiorId: number, kind: StructureKind): Interior {
	// Keyed on all three inputs, not on the id alone. An id identifies a building
	// only within one world, so a process that opens a second world — which the
	// launcher does — would otherwise serve the first world's rooms for it. It also
	// makes the cache agree with `buildInterior`, which is a pure function of the
	// same three arguments.
	const key = `${seed}:${interiorId}:${kind}`;
	const cached = interiorCache.get(key);
	if (cached) return cached;
	const built = buildInterior(seed, interiorId, kind);
	interiorCache.set(key, built);
	return built;
}

export function clearInteriorCache(): void {
	interiorCache.clear();
}

interface Furnishing {
	readonly decor: DecorId;
	readonly count: number;
	readonly anchor?: string;
}

function planFor(kind: StructureKind): {
	readonly size: readonly [number, number];
	readonly floor: TerrainId;
	readonly wall: TerrainId;
	readonly furnishings: readonly Furnishing[];
} {
	switch (kind) {
		case "inn":
			return {
				size: [17, 11],
				floor: T.floorWood,
				wall: T.woodWall,
				furnishings: [
					{ decor: D.counter, count: 4, anchor: "counter" },
					{ decor: D.hearth, count: 1, anchor: "hearth" },
					{ decor: D.table, count: 3 },
					{ decor: D.chair, count: 4 },
					{ decor: D.bed, count: 3, anchor: "backroom" },
					{ decor: D.barrel, count: 2 },
				],
			};
		case "shop":
		case "apothecary":
			return {
				size: [13, 9],
				floor: T.floorWood,
				wall: T.woodWall,
				furnishings: [
					{ decor: D.counter, count: 3, anchor: "counter" },
					{ decor: D.shelf, count: 4 },
					{ decor: D.crate, count: 3 },
					{ decor: D.barrel, count: 2 },
				],
			};
		case "smithy":
			return {
				size: [13, 9],
				floor: T.floorStone,
				wall: T.stoneWall,
				furnishings: [
					{ decor: D.anvil, count: 1, anchor: "counter" },
					{ decor: D.hearth, count: 1, anchor: "hearth" },
					{ decor: D.crate, count: 2 },
					{ decor: D.barrel, count: 1 },
				],
			};
		case "temple":
		case "shrine":
			return {
				size: [15, 11],
				floor: T.floorStone,
				wall: T.stoneWall,
				furnishings: [
					{ decor: D.statue, count: 1, anchor: "hearth" },
					{ decor: D.bench, count: 6 },
					{ decor: D.lamp, count: 2 },
				],
			};
		case "barracks":
			return {
				size: [15, 11],
				floor: T.floorStone,
				wall: T.stoneWall,
				furnishings: [
					{ decor: D.bed, count: 6 },
					{ decor: D.crate, count: 2 },
					{ decor: D.hearth, count: 1, anchor: "hearth" },
				],
			};
		case "warehouse":
		case "barn":
		case "stable":
			return {
				size: [15, 11],
				floor: T.floorWood,
				wall: T.woodWall,
				furnishings: [
					{ decor: D.crate, count: 8 },
					{ decor: D.barrel, count: 6 },
				],
			};
		case "mill":
			// A mill used to fall through to the household plan — a hearth, two beds
			// and a shelf — so the one building most likely to be sent an errand about
			// had nothing in it and did not read as a mill either.
			return {
				size: [13, 11],
				floor: T.floorStone,
				wall: T.woodWall,
				furnishings: [
					{ decor: D.counter, count: 1, anchor: "counter" },
					{ decor: D.crate, count: 4 },
					{ decor: D.barrel, count: 3 },
					{ decor: D.shelf, count: 2 },
				],
			};
		case "ruin":
			return {
				size: [11, 9],
				floor: T.rubble,
				wall: T.stoneWall,
				furnishings: [{ decor: D.chest, count: 1 }],
			};
		default:
			return {
				size: [11, 9],
				floor: T.floorWood,
				wall: T.woodWall,
				furnishings: [
					{ decor: D.hearth, count: 1, anchor: "hearth" },
					{ decor: D.bed, count: 2 },
					{ decor: D.table, count: 1 },
					{ decor: D.chair, count: 2 },
					{ decor: D.shelf, count: 1 },
				],
			};
	}
}

function buildInterior(seed: number, interiorId: number, kind: StructureKind): Interior {
	const rng = rngFor(seed, "interior", interiorId);
	const plan = planFor(kind);
	const width = plan.size[0];
	const height = plan.size[1];

	const terrain = new Uint16Array(width * height);
	const decor = new Uint16Array(width * height);
	const flags = new Uint8Array(width * height);
	const anchors: { kind: string; x: number; y: number }[] = [];

	const set = (x: number, y: number, id: TerrainId, extra = 0) => {
		const i = y * width + x;
		terrain[i] = id;
		flags[i] = terrainDef(id).flags | extra;
	};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
			set(x, y, edge ? plan.wall : plan.floor, edge ? 0 : TFlag.Interior);
		}
	}

	// The exit sits in the middle of the south wall; the player arrives just
	// inside it, so stepping back out is always one move.
	const doorX = Math.floor(width / 2);
	set(doorX, height - 1, T.doorOpen);
	const entrance = { x: doorX, y: height - 2 };

	// A rug marks the entry so the room does not read as an empty box. Rug is
	// terrain rather than decor: it replaces the floor, it does not sit on it.
	if (kind !== "ruin" && kind !== "barn" && kind !== "warehouse") {
		set(doorX, height - 3, T.rug, TFlag.Interior);
	}

	// Furnish the interior ring, leaving the middle and the path to the door
	// clear so nothing can seal the player in.
	const free: { x: number; y: number }[] = [];
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			if (x === doorX && y >= height - 3) continue;
			free.push({ x, y });
		}
	}
	const shuffled = rng.shuffled(free);
	let cursor = 0;

	for (const furnishing of plan.furnishings) {
		for (let n = 0; n < furnishing.count; n++) {
			const spot = shuffled[cursor++];
			if (!spot) break;
			decor[spot.y * width + spot.x] = furnishing.decor;
			if (n === 0 && furnishing.anchor) {
				anchors.push({ kind: furnishing.anchor, x: spot.x, y: spot.y });
			}
		}
	}

	return { id: interiorId, kind, width, height, terrain, decor, flags, entrance, anchors };
}
