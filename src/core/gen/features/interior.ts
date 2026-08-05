import { type Rng, rngFor } from "../../rand/rng.js";
import { D, type DecorId } from "../../tiles/decor.js";
import { TFlag } from "../../tiles/flags.js";
import { T, type TerrainId, terrainDef } from "../../tiles/terrain.js";
import type { StructureKind } from "./patch.js";

/**
 * A way from one level of a complex to another.
 *
 * `kind` is what the stairs look like; `to` is where they go. Both are needed and
 * neither can be derived from the other, because level 1 of a tower is *above* level
 * 0 and level 1 of a cave is *below* it. Inferring the target from the direction —
 * which the first version did — sent everyone who climbed a tower to level −1.
 */
export interface Portal {
	readonly kind: "up" | "down";
	/** Index of the level these stairs lead to. */
	readonly to: number;
	readonly x: number;
	readonly y: number;
}

export interface Interior {
	readonly id: number;
	readonly kind: StructureKind;
	/** 0 is the level the outside door opens onto; higher is further in or up. */
	readonly level: number;
	readonly width: number;
	readonly height: number;
	readonly terrain: Uint16Array;
	readonly decor: Uint16Array;
	readonly flags: Uint8Array;
	/** Where the player appears on entering, and where the exit door is. */
	readonly entrance: { readonly x: number; readonly y: number };
	readonly anchors: readonly { readonly kind: string; readonly x: number; readonly y: number }[];
	/** Stairs to the neighbouring levels. Empty in a single-level interior. */
	readonly portals: readonly Portal[];
}

const complexCache = new Map<string, readonly Interior[]>();

/**
 * Interiors are separate grids, generated on demand.
 *
 * They are deliberately *not* stamped into the world. Stamping would force a
 * building's exterior footprint to be as large as everything inside it, which
 * collapses town density — an inn with a common room, a hearth and four beds
 * would need a twenty-tile frontage. Keeping them separate means a modest
 * building can hold a room worth walking into.
 *
 * Generated lazily and cached, because most buildings in a town are never
 * entered.
 *
 * **A complex is generated as a whole**, not level by level. Stairs have to line up:
 * the tile you go down from and the tile you come up onto are the same coordinate,
 * and the only way to guarantee that from two independent generators is to have them
 * agree — which is another way of saying they are one generator.
 */
export function getComplex(
	seed: number,
	interiorId: number,
	kind: StructureKind,
): readonly Interior[] {
	// Keyed on all three inputs, not on the id alone. An id identifies a building
	// only within one world, so a process that opens a second world — which the
	// launcher does — would otherwise serve the first world's rooms for it. It also
	// makes the cache agree with `buildComplex`, which is a pure function of the
	// same three arguments.
	const key = `${seed}:${interiorId}:${kind}`;
	const cached = complexCache.get(key);
	if (cached) return cached;
	const built = buildComplex(seed, interiorId, kind);
	complexCache.set(key, built);
	return built;
}

/** One level of an interior. Level 0 is what the outside door opens onto. */
export function getInterior(
	seed: number,
	interiorId: number,
	kind: StructureKind,
	level = 0,
): Interior {
	const levels = getComplex(seed, interiorId, kind);
	return levels[level] ?? (levels[0] as Interior);
}

export function clearInteriorCache(): void {
	complexCache.clear();
}

interface Furnishing {
	readonly decor: DecorId;
	readonly count: number;
	readonly anchor?: string;
}

interface Plan {
	readonly size: readonly [number, number];
	readonly floor: TerrainId;
	readonly wall: TerrainId;
	readonly furnishings: readonly Furnishing[];
	/**
	 * How many storeys, including the ground floor.
	 *
	 * A guest storey over an inn and a watch room at the top of a tower are the two
	 * cases that actually matter: they are where a scenario wants to put somebody who
	 * should be hard to walk into by accident.
	 */
	readonly floors?: number;
	/** What furnishes the storeys above the ground floor. */
	readonly upstairs?: readonly Furnishing[];
}

function planFor(kind: StructureKind): Plan {
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
				// Rooms over the taproom, which is where an inn keeps the people worth
				// finding: a guest is upstairs, not standing in the common room all day.
				floors: 2,
				upstairs: [
					{ decor: D.bed, count: 5, anchor: "backroom" },
					{ decor: D.table, count: 2 },
					{ decor: D.chair, count: 3 },
					{ decor: D.shelf, count: 1 },
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
		case "tower":
			// The one building that is *mostly* vertical. Small rooms, three of them, and
			// the top one is where anything worth climbing for is kept.
			return {
				size: [9, 9],
				floor: T.floorStone,
				wall: T.stoneWall,
				furnishings: [
					{ decor: D.crate, count: 2 },
					{ decor: D.barrel, count: 2 },
					{ decor: D.hearth, count: 1, anchor: "hearth" },
				],
				floors: 3,
				upstairs: [
					{ decor: D.table, count: 1, anchor: "counter" },
					{ decor: D.shelf, count: 2 },
					{ decor: D.chest, count: 1, anchor: "backroom" },
					{ decor: D.chair, count: 1 },
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
				floors: 2,
				upstairs: [
					{ decor: D.crate, count: 5 },
					{ decor: D.barrel, count: 3 },
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

function buildComplex(seed: number, interiorId: number, kind: StructureKind): readonly Interior[] {
	if (kind === "cave") return buildCavern(seed, interiorId);

	const plan = planFor(kind);
	const floors = Math.max(1, plan.floors ?? 1);
	const width = plan.size[0] as number;
	const height = plan.size[1] as number;

	// One tile per *boundary between storeys*, chosen once, before anything is built.
	// Upper floors keep the ground floor's footprint precisely so these can be valid on
	// both sides by construction: two storeys of different shapes need their stairs
	// reconciled, and every scheme for doing that is a way of getting it wrong on the
	// fifth building in the fifth town.
	//
	// Distinct per boundary, because a middle storey has two flights and they cannot
	// share a tile — arriving on the stair that sends you straight back is not a
	// staircase, it is a trap.
	const corners = [
		{ x: 1, y: 1 },
		{ x: width - 2, y: 1 },
		{ x: 1, y: height - 2 },
		{ x: width - 2, y: height - 2 },
	];
	const stairs = corners.slice(0, Math.max(0, floors - 1));

	const levels: Interior[] = [];
	for (let level = 0; level < floors; level++) {
		levels.push(
			buildRoom(seed, interiorId, kind, plan, level, {
				width,
				height,
				// Up to the next storey, and down to the one below.
				up: stairs[level],
				down: level > 0 ? stairs[level - 1] : undefined,
			}),
		);
	}
	return levels;
}

interface RoomShape {
	readonly width: number;
	readonly height: number;
	/** Where the flight to the storey above stands, if there is one. */
	readonly up?: { readonly x: number; readonly y: number };
	/** Where the flight to the storey below stands, if there is one. */
	readonly down?: { readonly x: number; readonly y: number };
}

function buildRoom(
	seed: number,
	interiorId: number,
	kind: StructureKind,
	plan: Plan,
	level: number,
	shape: RoomShape,
): Interior {
	// The level is part of the stream, or every storey of a tower comes out with its
	// furniture in exactly the same places. Level 0 keeps the stream it always had, so
	// adding upper floors moved nothing in any ground-floor room that already existed.
	const rng =
		level === 0
			? rngFor(seed, "interior", interiorId)
			: rngFor(seed, "interior", interiorId, level);
	const { width, height } = shape;

	const terrain = new Uint16Array(width * height);
	const decor = new Uint16Array(width * height);
	const flags = new Uint8Array(width * height);
	const anchors: { kind: string; x: number; y: number }[] = [];
	const portals: Portal[] = [];

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
	// inside it, so stepping back out is always one move. Upper storeys have no
	// outside door — the stairs are the only way in and out.
	const doorX = Math.floor(width / 2);
	if (level === 0) set(doorX, height - 1, T.doorOpen);
	const entrance =
		level === 0 ? { x: doorX, y: height - 2 } : { ...(shape.down as { x: number; y: number }) };

	// A rug marks the entry so the room does not read as an empty box. Rug is
	// terrain rather than decor: it replaces the floor, it does not sit on it.
	if (level === 0 && kind !== "ruin" && kind !== "barn" && kind !== "warehouse") {
		set(doorX, height - 3, T.rug, TFlag.Interior);
	}

	// Stairs before furniture, so nothing can be dropped on top of them.
	if (shape.down) {
		set(shape.down.x, shape.down.y, T.stairsDown, TFlag.Interior);
		portals.push({ kind: "down", to: level - 1, x: shape.down.x, y: shape.down.y });
	}
	if (shape.up) {
		set(shape.up.x, shape.up.y, T.stairsUp, TFlag.Interior);
		portals.push({ kind: "up", to: level + 1, x: shape.up.x, y: shape.up.y });
	}

	// Furnish the interior ring, leaving the middle and the path to the door
	// clear so nothing can seal the player in.
	const taken = new Set(portals.map((portal) => `${portal.x},${portal.y}`));
	const free: { x: number; y: number }[] = [];
	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			if (level === 0 && x === doorX && y >= height - 3) continue;
			if (taken.has(`${x},${y}`)) continue;
			free.push({ x, y });
		}
	}
	const shuffled = rng.shuffled(free);
	let cursor = 0;

	const furnishings = level === 0 ? plan.furnishings : (plan.upstairs ?? plan.furnishings);
	for (const furnishing of furnishings) {
		for (let n = 0; n < furnishing.count; n++) {
			const spot = shuffled[cursor++];
			if (!spot) break;
			decor[spot.y * width + spot.x] = furnishing.decor;
			if (n === 0 && furnishing.anchor) {
				anchors.push({ kind: furnishing.anchor, x: spot.x, y: spot.y });
			}
		}
	}

	return {
		id: interiorId,
		kind,
		level,
		width,
		height,
		terrain,
		decor,
		flags,
		entrance,
		anchors,
		portals,
	};
}

// --- caves ------------------------------------------------------------------

const CAVE_SIZE = 33;
const CAVE_LEVELS = 3;

/**
 * A cave: rock with rooms eaten out of it, several levels deep.
 *
 * Carved by random walk rather than laid out, because the whole reason to go
 * underground is that it does not look like a building. The walk starts from the
 * entrance and from each stair, so every part of the level is reachable from the way
 * in by construction — the alternative is to carve first and check afterwards, and a
 * sealed chamber with the only chest in it is not a bug the player can report.
 */
function buildCavern(seed: number, interiorId: number): readonly Interior[] {
	const rng = rngFor(seed, "cavern", interiorId);
	const size = CAVE_SIZE;
	const mouth = { x: Math.floor(size / 2), y: size - 2 };

	// Every level's stairs are decided before any level is carved, so a walk can be
	// told to pass through them. Two independent carvers agreeing on a coordinate
	// afterwards is the thing this design exists to avoid.
	const stairs: { x: number; y: number }[] = [];
	for (let level = 0; level + 1 < CAVE_LEVELS; level++) {
		stairs.push({
			x: 3 + rng.int(size - 6),
			y: 3 + rng.int(size - 6),
		});
	}

	const levels: Interior[] = [];
	for (let level = 0; level < CAVE_LEVELS; level++) {
		const down = stairs[level];
		const up = level > 0 ? stairs[level - 1] : undefined;
		const start = level === 0 ? mouth : (up as { x: number; y: number });

		const terrain = new Uint16Array(size * size);
		const decor = new Uint16Array(size * size);
		const flags = new Uint8Array(size * size);
		const set = (x: number, y: number, id: TerrainId, extra = 0) => {
			const i = y * size + x;
			terrain[i] = id;
			flags[i] = terrainDef(id).flags | extra;
		};

		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) set(x, y, T.caveWall);
		}

		const carve = (x: number, y: number) => {
			if (x < 1 || y < 1 || x >= size - 1 || y >= size - 1) return;
			set(x, y, T.caveFloor, TFlag.Interior);
		};

		// One walk per destination, each starting where the player will be. A walk that
		// merely wanders leaves the far end of the level unreachable a third of the time.
		const destinations = [down, up].filter(Boolean) as { x: number; y: number }[];
		if (destinations.length === 0) destinations.push({ x: mouth.x, y: 3 });
		for (const target of destinations) {
			drunkardsWalk(rng, start, target, carve, size);
		}
		// A few blind galleries, so a level is not simply a corridor to the stairs.
		for (let n = 0; n < 3; n++) {
			const to = { x: 2 + rng.int(size - 4), y: 2 + rng.int(size - 4) };
			drunkardsWalk(rng, start, to, carve, size);
		}

		const portals: Portal[] = [];
		if (up) {
			carve(up.x, up.y);
			set(up.x, up.y, T.stairsUp, TFlag.Interior);
			// Up, out of a cave, means back toward the surface — a lower index.
			portals.push({ kind: "up", to: level - 1, x: up.x, y: up.y });
		}
		if (down) {
			carve(down.x, down.y);
			set(down.x, down.y, T.stairsDown, TFlag.Interior);
			portals.push({ kind: "down", to: level + 1, x: down.x, y: down.y });
		}

		if (level === 0) {
			carve(mouth.x, mouth.y);
			set(mouth.x, mouth.y + 1, T.doorOpen);
		}

		// Something to find, deeper down. A cave with nothing in it is a corridor.
		const spots: { x: number; y: number }[] = [];
		for (let y = 1; y < size - 1; y++) {
			for (let x = 1; x < size - 1; x++) {
				if (terrain[y * size + x] === T.caveFloor) spots.push({ x, y });
			}
		}
		const shuffled = rng.shuffled(spots);
		const anchors: { kind: string; x: number; y: number }[] = [];
		for (let n = 0; n < 2 + level * 2 && n < shuffled.length; n++) {
			const spot = shuffled[n] as { x: number; y: number };
			decor[spot.y * size + spot.x] = n === 0 ? D.chest : D.crate;
			if (n === 0) anchors.push({ kind: "backroom", x: spot.x, y: spot.y });
		}

		levels.push({
			id: interiorId,
			kind: "cave",
			level,
			width: size,
			height: size,
			terrain,
			decor,
			flags,
			entrance: level === 0 ? mouth : (up as { x: number; y: number }),
			anchors,
			portals,
		});
	}
	return levels;
}

/**
 * Carve a wandering passage from one point to another.
 *
 * Biased toward the target so it always arrives, jittered so it does not arrive in a
 * straight line. Two tiles wide at random intervals, which is what turns a corridor
 * into something with chambers in it.
 */
function drunkardsWalk(
	rng: Rng,
	from: { x: number; y: number },
	to: { x: number; y: number },
	carve: (x: number, y: number) => void,
	size: number,
): void {
	let x = from.x;
	let y = from.y;
	// Bounded: the bias guarantees arrival, and the bound guarantees termination even
	// if a future change to the bias does not.
	for (let step = 0; step < size * 8; step++) {
		carve(x, y);
		if (rng.chance(0.35)) {
			carve(x + 1, y);
			carve(x, y + 1);
		}
		if (x === to.x && y === to.y) return;

		const dx = Math.sign(to.x - x);
		const dy = Math.sign(to.y - y);
		// Three times in four, step toward the target on the axis with further to go.
		if (rng.chance(0.75)) {
			if (Math.abs(to.x - x) > Math.abs(to.y - y)) x += dx;
			else y += dy;
		} else {
			if (rng.chance(0.5)) x += rng.chance(0.5) ? 1 : -1;
			else y += rng.chance(0.5) ? 1 : -1;
		}
		x = Math.max(1, Math.min(size - 2, x));
		y = Math.max(1, Math.min(size - 2, y));
	}
}
