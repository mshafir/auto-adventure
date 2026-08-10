import type { Vec2 } from "../../geom/vec.js";
import { D, type DecorId } from "../../tiles/decor.js";
import { T, type TerrainId } from "../../tiles/terrain.js";
import type { AnchorKind, StructureKind } from "./patch.js";

/**
 * Everything the generator knows about one kind of building, in one place.
 *
 * It was in eight places. What a building is walled with was a switch in
 * `building.ts`, whether it puts a board out was a second one beside it, which anchors
 * it offers a third, and how small a plot it will accept a fourth; the room inside it
 * was a switch in `interior.ts`; how big a plot it asks for and how badly it wants one
 * were two tables in `fallback-spec.ts`; and who lives in it is a table in the content
 * pack. Adding a kind meant finding all eight, and the only way to discover you had
 * missed one was to walk into the building.
 *
 * Worse, the *list of kinds* was three lists. `StructureKind` had sixteen entries, the
 * director's `STRUCTURE_KINDS` had fifteen, and the fallback roster's keys were a third
 * hand-maintained copy, with no test tying any two together. `STRUCTURE_KINDS` is what
 * the model is allowed to say and what the scenario schema enforces, so a drift between
 * the first two is a scenario that validates and then generates a building nobody has a
 * plan for. That list is now derived from this registry, so the drift is not possible.
 *
 * **Registration is code, not data, and that is deliberate.** `getComplex` caches
 * interiors under `(seed, interiorId, kind)`, and the moment a kind's plan can differ
 * between two worlds open in one process — which the launcher does routinely — that key
 * is wrong in exactly the way `worldKey`'s does not dare to be. A registered kind is a
 * build-time fact, identical in every world, so the key stays honest. A *world* that
 * wants different rooms says so in its recipe, where it hashes into a key.
 */

/** A piece of furniture, and the anchor it establishes if it is the first of its sort. */
export interface Furnishing {
	readonly decor: DecorId;
	readonly count: number;
	readonly anchor?: string;
}

/** The room behind a door. */
export interface Plan {
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

export interface BuildingMaterials {
	readonly wall: TerrainId;
	/** What fills the footprint as seen from outside: a roof, or open sky. */
	readonly cover: TerrainId;
}

export interface StructureDef {
	readonly id: StructureKind;
	/** Plot size the deterministic roster asks for. */
	readonly size: "small" | "medium" | "large";
	/** 1..5. Decides who gets a plot when there are more specs than plots. */
	readonly importance: number;
	readonly materials: BuildingMaterials;
	/** Whether it puts a board out front. A shop does; a farmhouse does not. */
	readonly sign: boolean;
	/** Anchors inside it, which is where a scenario may stand somebody. */
	readonly anchors: readonly AnchorKind[];
	readonly plan: Plan;
	/**
	 * Added to the minimum plot the size implies. A hall needs frontage.
	 */
	readonly plotPad?: Vec2;
	/** Overrides the minimum plot outright, ignoring the size. */
	readonly plotFixed?: Vec2;
	/**
	 * Whether an author may ask for one.
	 *
	 * `cave` is the only kind that cannot be: it is built by the cave feature as the
	 * mouth of a volume, and a settlement roster asking for one would produce a doorway
	 * into a hillside that is not there.
	 */
	readonly authorable: boolean;
}

const structures = new Map<StructureKind, StructureDef>();

export function registerStructure(def: StructureDef): void {
	const already = structures.get(def.id);
	if (already) throw new Error(`two structure definitions claim "${def.id}"`);
	structures.set(def.id, def);
}

/**
 * What a kind of building is.
 *
 * Falls back to `house` rather than throwing, because the kind is not always a
 * `StructureKind` by the time it gets here: `obtainable.ts` reads building kinds off an
 * artifact and casts, so a scenario written against a build that had a kind this one does
 * not would otherwise crash the validator rather than report the mismatch.
 */
export function structureDef(kind: StructureKind | string): StructureDef {
	return structures.get(kind as StructureKind) ?? (structures.get("house") as StructureDef);
}

/** Every registered kind, in registration order. For tests and tooling. */
export function registeredStructures(): readonly StructureDef[] {
	return [...structures.values()];
}

/**
 * The kinds an author may name, which is the model's contract.
 *
 * Derived rather than written down a second time. This is what `STRUCTURE_KINDS` is,
 * and what the scenario and draft schemas enforce.
 */
export function authorableStructureKinds(): readonly StructureKind[] {
	return registeredStructures()
		.filter((def) => def.authorable)
		.map((def) => def.id);
}

// --- the built-in kinds ------------------------------------------------------
//
// Registration order is the order an author sees them in, so it is the old
// `STRUCTURE_KINDS` order rather than anything tidier: changing it changes the prompt.

const WOOD: BuildingMaterials = { wall: T.woodWall, cover: T.roof };
const STONE: BuildingMaterials = { wall: T.stoneWall, cover: T.roof };

/**
 * The room a building has when it is somewhere people live.
 *
 * The loom is not decoration. `house` is the commonest building in every world and its
 * room was five pieces of furniture that said only "somebody sleeps here" — while the
 * default pack's householders are weavers, coopers and brewers, so the room contradicted
 * the person standing in it. One piece of work in the corner is the difference between a
 * dwelling and a *living*, and it costs a tile.
 */
const HOUSEHOLD: Plan = {
	size: [11, 9],
	floor: T.floorWood,
	wall: T.woodWall,
	furnishings: [
		{ decor: D.hearth, count: 1, anchor: "hearth" },
		{ decor: D.bed, count: 2 },
		{ decor: D.table, count: 1 },
		{ decor: D.chair, count: 2 },
		{ decor: D.shelf, count: 1 },
		{ decor: D.loom, count: 1 },
	],
};

/** Four walls and a lot of floor. A warehouse, a barn and a stable are the same room. */
const STOREROOM: Plan = {
	size: [15, 11],
	floor: T.floorWood,
	wall: T.woodWall,
	furnishings: [
		{ decor: D.crate, count: 8 },
		{ decor: D.barrel, count: 6 },
	],
};

const COUNTER_ROOM: Plan = {
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

const SANCTUARY: Plan = {
	size: [15, 11],
	floor: T.floorStone,
	wall: T.stoneWall,
	furnishings: [
		{ decor: D.statue, count: 1, anchor: "hearth" },
		{ decor: D.bench, count: 6 },
		{ decor: D.lamp, count: 2 },
	],
};

registerStructure({
	id: "house",
	size: "small",
	importance: 1,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	plan: HOUSEHOLD,
	authorable: true,
});

registerStructure({
	id: "shop",
	size: "medium",
	importance: 4,
	materials: WOOD,
	sign: true,
	anchors: ["counter", "backroom"],
	plan: COUNTER_ROOM,
	authorable: true,
});

registerStructure({
	id: "inn",
	size: "medium",
	importance: 5,
	materials: WOOD,
	sign: true,
	anchors: ["counter", "hearth", "backroom"],
	plan: {
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
			{ decor: D.keg, count: 2 },
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
	},
	authorable: true,
});

registerStructure({
	id: "smithy",
	size: "medium",
	importance: 4,
	materials: STONE,
	sign: true,
	anchors: ["counter", "hearth"],
	plan: {
		size: [13, 9],
		floor: T.floorStone,
		wall: T.stoneWall,
		furnishings: [
			{ decor: D.anvil, count: 1, anchor: "counter" },
			{ decor: D.hearth, count: 1, anchor: "hearth" },
			{ decor: D.crate, count: 2 },
			{ decor: D.barrel, count: 1 },
		],
	},
	authorable: true,
});

registerStructure({
	id: "temple",
	size: "large",
	importance: 5,
	materials: STONE,
	sign: false,
	anchors: ["hearth"],
	plan: SANCTUARY,
	plotPad: { x: 2, y: 1 },
	authorable: true,
});

registerStructure({
	id: "barracks",
	size: "large",
	importance: 5,
	materials: STONE,
	sign: false,
	anchors: ["hearth", "backroom"],
	plan: {
		size: [15, 11],
		floor: T.floorStone,
		wall: T.stoneWall,
		furnishings: [
			{ decor: D.bed, count: 6 },
			{ decor: D.crate, count: 2 },
			{ decor: D.hearth, count: 1, anchor: "hearth" },
		],
	},
	plotPad: { x: 2, y: 1 },
	authorable: true,
});

registerStructure({
	id: "tower",
	size: "small",
	importance: 3,
	materials: STONE,
	sign: false,
	anchors: ["hearth", "backroom"],
	// The one building that is *mostly* vertical. Small rooms, three of them, and the
	// top one is where anything worth climbing for is kept.
	plan: {
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
	},
	plotFixed: { x: 5, y: 5 },
	authorable: true,
});

registerStructure({
	id: "farmhouse",
	size: "small",
	importance: 1,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	plan: HOUSEHOLD,
	authorable: true,
});

registerStructure({
	id: "barn",
	size: "large",
	importance: 2,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	plan: STOREROOM,
	plotPad: { x: 2, y: 1 },
	authorable: true,
});

registerStructure({
	id: "warehouse",
	size: "large",
	importance: 2,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	plan: STOREROOM,
	plotPad: { x: 2, y: 1 },
	authorable: true,
});

registerStructure({
	id: "mill",
	size: "medium",
	importance: 3,
	materials: WOOD,
	sign: true,
	anchors: ["hearth"],
	// A mill used to fall through to the household plan — a hearth, two beds and a
	// shelf — so the one building most likely to be sent an errand about had nothing in
	// it and did not read as a mill either.
	plan: {
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
	},
	authorable: true,
});

registerStructure({
	id: "stable",
	size: "small",
	importance: 2,
	materials: WOOD,
	sign: true,
	anchors: ["hearth"],
	plan: STOREROOM,
	authorable: true,
});

registerStructure({
	id: "apothecary",
	size: "small",
	importance: 4,
	materials: WOOD,
	sign: true,
	anchors: ["counter", "backroom"],
	// The counter room with something boiling on it. An apothecary and a general shop
	// shared a plan exactly, so the one building in the world whose whole business is
	// preparation looked like a place that sells rope.
	plan: {
		...COUNTER_ROOM,
		furnishings: [...COUNTER_ROOM.furnishings, { decor: D.cauldron, count: 1 }],
	},
	authorable: true,
});

registerStructure({
	id: "ruin",
	size: "small",
	importance: 1,
	// A ruin is roofless by definition, and its rubble is the point.
	materials: { wall: T.stoneWall, cover: T.rubble },
	sign: false,
	anchors: ["hearth"],
	plan: {
		size: [11, 9],
		floor: T.rubble,
		wall: T.stoneWall,
		furnishings: [{ decor: D.chest, count: 1 }],
	},
	authorable: true,
});

/**
 * A roadside shrine, which is a marker and a bench and not a small cathedral.
 *
 * It shared `SANCTUARY` with the temple, so the thing a `landmark` puts in an empty
 * stretch of moor — the one building a player is most likely to meet alone, miles from
 * anywhere — was a fifteen-by-eleven nave with lamps and six pews in it. A waystone in a
 * one-room hut is what a shrine is, and it is why `totem` exists.
 */
registerStructure({
	id: "shrine",
	size: "small",
	importance: 1,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	plan: {
		size: [9, 7],
		floor: T.floorStone,
		wall: T.stoneWall,
		furnishings: [
			{ decor: D.totem, count: 1, anchor: "hearth" },
			{ decor: D.bench, count: 2 },
			{ decor: D.lamp, count: 1 },
		],
	},
	authorable: true,
});

/**
 * Somewhere a settlement gathers that is not a church.
 *
 * `temple` was the only large room without beds in it, so every world's civic building
 * was a sanctuary with a statue in it whether or not the world had a religion — a
 * longhouse, a stoa and a guild hall all came out as the same nave. A hall is a long
 * table, benches down both sides and a fire at one end, and the difference is not
 * decoration: `temple` puts a statue at the `hearth` anchor, which is where a scenario
 * stands the person it wants found.
 *
 * Registered last so it is last in the prompt's list of kinds, which leaves the order
 * every existing scenario was authored against untouched.
 */
registerStructure({
	id: "hall",
	size: "large",
	importance: 5,
	materials: WOOD,
	sign: false,
	anchors: ["hearth", "counter", "backroom"],
	plan: {
		size: [19, 11],
		floor: T.floorWood,
		wall: T.woodWall,
		furnishings: [
			{ decor: D.hearth, count: 1, anchor: "hearth" },
			{ decor: D.table, count: 4, anchor: "counter" },
			{ decor: D.bench, count: 8 },
			{ decor: D.keg, count: 2 },
			{ decor: D.banner, count: 2 },
			{ decor: D.chest, count: 1, anchor: "backroom" },
		],
	},
	plotPad: { x: 3, y: 1 },
	authorable: true,
});

registerStructure({
	id: "cave",
	size: "small",
	importance: 1,
	materials: WOOD,
	sign: false,
	anchors: ["hearth"],
	// Never consulted: `buildComplex` sends a cave to its own cavern generator. Present
	// so that every kind has a complete definition and the fallback is never the reason
	// a cave looks like a cottage.
	plan: HOUSEHOLD,
	authorable: false,
});
