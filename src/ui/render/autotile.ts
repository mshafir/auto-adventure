import { T, type TerrainId } from "../../core/tiles/terrain.js";

/**
 * Neighbour bits. A set bit means "the neighbour in that direction matches me",
 * so a wall connects to it.
 */
export const NEIGHBOR = { N: 1, E: 2, S: 4, W: 8 } as const;

export const FULL_MASK = NEIGHBOR.N | NEIGHBOR.E | NEIGHBOR.S | NEIGHBOR.W;

export interface AutotileSet {
	readonly key: string;
	/** Exactly 16 entries, indexed by the NESW neighbour mask. */
	readonly table: readonly string[];
	/** Which neighbouring terrain counts as "the same thing" for connection. */
	readonly matches: (id: TerrainId, self: TerrainId) => boolean;
}

/**
 * Build a table from the 16 mask entries in ascending order. Written out
 * explicitly rather than generated because the box-drawing shapes have no
 * arithmetic relationship to the mask.
 */
function maskTable(...entries: readonly string[]): readonly string[] {
	if (entries.length !== 16) {
		throw new Error(`autotile table needs 16 entries, got ${entries.length}`);
	}
	return entries;
}

/**
 * Build a table that shades by how enclosed a tile is, from fully exposed to
 * fully surrounded. Reads better than corner-matching for organic masses like
 * cliffs and forest canopy, where pretending the quadrants line up looks worse
 * than a straightforward density gradient.
 */
function densityTable(exposed: string, one: string, two: string, three: string, solid: string) {
	const popcount = (n: number) => ((n >> 0) & 1) + ((n >> 1) & 1) + ((n >> 2) & 1) + ((n >> 3) & 1);
	const byCount = [exposed, one, two, three, solid];
	return Object.freeze(Array.from({ length: 16 }, (_, mask) => byCount[popcount(mask)] as string));
}

const sameTerrain = (id: TerrainId, self: TerrainId) => id === self;

/**
 * A wall continues through its own openings.
 *
 * Doors and windows are separate terrain ids, so plain same-terrain matching
 * treated each one as the end of the wall: a cottage front came out as
 * `┗╸▤■+■▤╹` — two end-caps and a pair of isolated pillars — instead of one
 * unbroken run. The opening is *in* the wall, so for connection purposes it is
 * part of it.
 */
const wallPlane = (id: TerrainId, self: TerrainId) =>
	id === self || id === T.window || id === T.doorClosed || id === T.doorOpen;

/** Heavy box drawing: stone and timber walls. Index 0 is an isolated pillar. */
export const HEAVY_WALL: AutotileSet = {
	key: "heavyWall",
	//              0    N    E    NE   S    NS   ES   NES  W    NW   EW   NEW  SW   NSW  ESW  all
	table: maskTable("■", "╹", "╺", "┗", "╻", "┃", "┏", "┣", "╸", "┛", "━", "┻", "┓", "┫", "┳", "╋"),
	matches: wallPlane,
};

/** Light box drawing: fences and rails. Index 0 is a lone post. */
export const LIGHT_FENCE: AutotileSet = {
	key: "lightFence",
	table: maskTable("○", "╵", "╶", "└", "╷", "│", "┌", "├", "╴", "┘", "─", "┴", "┐", "┤", "┬", "┼"),
	matches: sameTerrain,
};

/** Double box drawing: bridges and formal stonework. */
export const DOUBLE_SPAN: AutotileSet = {
	key: "doubleSpan",
	table: maskTable("▬", "╨", "╞", "╚", "╥", "║", "╔", "╠", "╡", "╝", "═", "╩", "╗", "╣", "╦", "╬"),
	matches: sameTerrain,
};

/** Open water feathers toward its shoreline rather than drawing a hard edge. */
export const WATER_EDGE: AutotileSet = {
	key: "waterEdge",
	table: densityTable("░", "░", "▒", "~", "≈"),
	matches: sameTerrain,
};

/** Canopy and cliff masses thicken toward their interior. */
export const MASS_EDGE: AutotileSet = {
	key: "massEdge",
	table: densityTable("░", "▒", "▓", "▓", "█"),
	matches: sameTerrain,
};

export const AUTOTILE_SETS: readonly AutotileSet[] = [
	HEAVY_WALL,
	LIGHT_FENCE,
	DOUBLE_SPAN,
	WATER_EDGE,
	MASS_EDGE,
];

/**
 * Compute the neighbour mask for a tile.
 *
 * Note this runs at *render* time against a stitched view of the world, never
 * at generation time: an edge tile's mask depends on the neighbouring chunk,
 * which may not have been generated when the tile was written. Baking masks
 * into chunk data yields seamless terrain with visibly seamed glyphs.
 */
export function neighborMask(
	set: AutotileSet,
	self: TerrainId,
	north: TerrainId,
	east: TerrainId,
	south: TerrainId,
	west: TerrainId,
): number {
	let mask = 0;
	if (set.matches(north, self)) mask |= NEIGHBOR.N;
	if (set.matches(east, self)) mask |= NEIGHBOR.E;
	if (set.matches(south, self)) mask |= NEIGHBOR.S;
	if (set.matches(west, self)) mask |= NEIGHBOR.W;
	return mask;
}

export function autotileGlyph(set: AutotileSet, mask: number): string {
	return set.table[mask & FULL_MASK] ?? set.table[0] ?? "?";
}
