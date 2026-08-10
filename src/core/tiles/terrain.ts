import { hasFlag, TFlag } from "./flags.js";

/** Dense index into {@link TERRAIN}. Stored in a `Uint16Array` per chunk. */
export type TerrainId = number;

export interface TerrainDef {
	readonly id: TerrainId;
	readonly key: string;
	readonly name: string;
	readonly flags: number;
	/** Shown when the player examines or stands on this tile. */
	readonly describe: string;
}

const P = TFlag.Passable;
const S = TFlag.BlocksSight;
const W = TFlag.Water;
const D = TFlag.Deep;
const R = TFlag.Road;
const WALL = TFlag.Wall;
const DOOR = TFlag.Door;
const IN = TFlag.Interior;

/**
 * The terrain registry. Order is the wire format: ids are persisted inside
 * chunk deltas, so entries may be appended but never reordered or removed.
 */
const DEFS = [
	{ key: "void", name: "nothing", flags: 0, describe: "Featureless void." },

	// --- water -------------------------------------------------------------
	{
		key: "deepWater",
		name: "deep water",
		flags: W | D,
		describe: "Dark water, far too deep to wade.",
	},
	{
		key: "water",
		name: "shallow water",
		flags: P | W,
		describe: "Cold water lapping around your ankles.",
	},
	{ key: "ice", name: "ice", flags: P, describe: "A sheet of grey ice, groaning underfoot." },

	// --- ground ------------------------------------------------------------
	{ key: "sand", name: "sand", flags: P, describe: "Pale sand, packed hard by the tide." },
	{ key: "grass", name: "grass", flags: P, describe: "Short grass, cropped low." },
	{
		key: "tallGrass",
		name: "tall grass",
		flags: P | S,
		describe: "Grass high enough to hide a crouching figure.",
	},
	{ key: "forestFloor", name: "forest floor", flags: P, describe: "Loam and old needles." },
	{ key: "dirt", name: "bare earth", flags: P, describe: "Trodden earth." },
	{ key: "gravel", name: "gravel", flags: P, describe: "Loose stones that shift as you walk." },
	{ key: "marsh", name: "marsh", flags: P | W, describe: "Sucking black mud." },
	{
		key: "reeds",
		name: "reeds",
		flags: P | S,
		describe: "Reeds taller than you are, rattling in the wind.",
	},
	{ key: "farmland", name: "tilled earth", flags: P, describe: "Furrowed rows, recently turned." },
	{ key: "snow", name: "snow", flags: P, describe: "Fresh snow, unbroken." },

	// --- roads -------------------------------------------------------------
	{ key: "dirtRoad", name: "dirt road", flags: P | R, describe: "A rutted cart track." },
	{
		key: "cobbleRoad",
		name: "cobblestone road",
		flags: P | R,
		describe: "Worn cobbles, laid with some care.",
	},
	{
		key: "path",
		name: "footpath",
		flags: P | R,
		describe: "A narrow path beaten through the ground.",
	},
	{ key: "bridge", name: "bridge", flags: P | R, describe: "Planks laid across the water." },

	// --- vegetation --------------------------------------------------------
	{
		key: "conifer",
		name: "pine",
		flags: S,
		describe: "A tall pine, its lower branches long dead.",
	},
	{ key: "broadleaf", name: "oak", flags: S, describe: "A broad old oak." },
	{ key: "deadTree", name: "dead tree", flags: S, describe: "A bare trunk, split by lightning." },
	{ key: "bush", name: "bush", flags: S, describe: "A dense thicket." },
	{ key: "flowers", name: "flowers", flags: P, describe: "Wildflowers nodding in the breeze." },
	{ key: "crops", name: "crops", flags: P, describe: "Barley, nearly ready to cut." },
	{ key: "stump", name: "stump", flags: P, describe: "A stump, the cut still pale." },

	// --- stone -------------------------------------------------------------
	{ key: "rock", name: "boulder", flags: S, describe: "A boulder, lichen-crusted." },
	{ key: "cliff", name: "cliff", flags: S, describe: "A sheer rock face." },
	{
		key: "mountain",
		name: "mountainside",
		flags: S,
		describe: "Bare stone climbing out of sight.",
	},
	{ key: "rubble", name: "rubble", flags: P, describe: "Fallen masonry." },

	// --- built -------------------------------------------------------------
	{
		key: "stoneWall",
		name: "stone wall",
		flags: WALL | S,
		describe: "Fitted stone, cold to the touch.",
	},
	{ key: "woodWall", name: "timber wall", flags: WALL | S, describe: "Tarred timber planking." },
	{ key: "fence", name: "fence", flags: WALL, describe: "A split-rail fence." },
	{ key: "roof", name: "roof", flags: WALL | S, describe: "Shingled roof." },
	{
		key: "window",
		name: "window",
		flags: WALL,
		describe: "A shuttered window. Lamplight leaks through.",
	},
	{ key: "doorClosed", name: "door", flags: DOOR | WALL | S, describe: "A closed door." },
	{ key: "doorOpen", name: "open door", flags: P | DOOR, describe: "An open doorway." },
	/**
	 * A gate across a way through, as opposed to a door into a building.
	 *
	 * The distinction is not cosmetic. A door is a *transition* — refusing it leaves
	 * the world untouched, because the player simply does not change which grid they
	 * are standing on. A gate is a tile on the route itself, so opening one has to
	 * change the map and stay changed, which is why this is the pair that gets a
	 * delta written for it and a door is not.
	 */
	{
		key: "gateClosed",
		name: "barred gate",
		flags: DOOR | WALL | S,
		describe: "A heavy gate, barred from the far side.",
	},
	{
		key: "gateOpen",
		name: "open gate",
		flags: P | DOOR,
		describe: "The gate stands open.",
	},
	{ key: "floorWood", name: "floorboards", flags: P | IN, describe: "Scuffed floorboards." },
	{ key: "floorStone", name: "flagstones", flags: P | IN, describe: "Worn flagstones." },
	{ key: "rug", name: "rug", flags: P | IN, describe: "A threadbare rug." },
	{
		key: "stairsDown",
		name: "stairs down",
		flags: P,
		describe: "Steps leading down into the dark.",
	},
	{ key: "stairsUp", name: "stairs up", flags: P, describe: "Steps leading up." },

	// --- the waterfront ------------------------------------------------------
	{
		key: "pier",
		name: "pier",
		flags: P,
		// Not flagged Water: it is a walkable surface that happens to be over water,
		// and anything reading the flag wants to know whether you would get wet.
		describe: "Planks over open water, tarred at the joints.",
	},
	{
		key: "deck",
		name: "deck",
		flags: P,
		describe: "A boat's deck, shifting slightly underfoot.",
	},

	// --- underground ---------------------------------------------------------
	/**
	 * The way into a cave, which is a door in every sense the engine cares about.
	 *
	 * Flagged exactly like `doorClosed` rather than being its own kind of thing: the
	 * reducer's whole notion of going indoors is "the tile ahead is a door belonging to
	 * a building", and a cave that used a different mechanism would need every one of
	 * those paths written twice.
	 */
	{
		key: "caveMouth",
		name: "cave mouth",
		flags: DOOR | WALL | S,
		describe: "A dark opening in the rock, taller than a man.",
	},
	{ key: "caveFloor", name: "cave floor", flags: P | IN, describe: "Damp, uneven rock." },
	{
		key: "caveWall",
		name: "rock",
		flags: WALL | S,
		describe: "Solid rock, cold to the touch.",
	},

	// --- appended for the pack batch -----------------------------------------
	//
	// Four terrains a recipe could not otherwise reach. Each is here because a
	// specific world could not be written without it and no recolour of an existing
	// tile would do: a desert scattered with yellow oaks is the failure mode a palette
	// cannot fix, and a rail line is neither a road nor a river.
	//
	// Appended, never inserted. Ids are the wire format.
	{
		key: "palm",
		name: "palm",
		flags: S,
		describe: "A palm, its fronds rattling like paper.",
	},
	{
		key: "saguaro",
		name: "saguaro",
		flags: S,
		describe: "A branched cactus, taller than a man and older than the road.",
	},
	{
		key: "track",
		name: "rail track",
		// Flagged Road: it is a made way through the country, and everything that reads
		// the flag — pathing, the map's sense of a route — wants it counted as one.
		flags: P | R,
		describe: "Rails on rotting sleepers, ballast washed out between them.",
	},
	{
		key: "adobeWall",
		name: "adobe wall",
		flags: WALL | S,
		describe: "Mud brick, rendered smooth and cracked by the sun.",
	},
] as const satisfies readonly Omit<TerrainDef, "id">[];

export const TERRAIN: readonly TerrainDef[] = DEFS.map((def, id) => ({ ...def, id }));

type TerrainKey = (typeof DEFS)[number]["key"];

/** Named ids, e.g. `T.grass`. Built from the registry so the two cannot drift. */
export const T = Object.fromEntries(TERRAIN.map((def) => [def.key, def.id])) as Record<
	TerrainKey,
	TerrainId
>;

const BY_KEY = new Map(TERRAIN.map((def) => [def.key, def]));

export function terrainDef(id: TerrainId): TerrainDef {
	return TERRAIN[id] ?? (TERRAIN[0] as TerrainDef);
}

export function terrainByKey(key: string): TerrainDef | undefined {
	return BY_KEY.get(key);
}

export function isPassable(id: TerrainId): boolean {
	return hasFlag(terrainDef(id).flags, TFlag.Passable);
}

export function blocksSight(id: TerrainId): boolean {
	return hasFlag(terrainDef(id).flags, TFlag.BlocksSight);
}
