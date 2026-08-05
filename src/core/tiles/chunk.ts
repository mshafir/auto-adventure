import { CHUNK, CHUNK_AREA, type ChunkCoord, localIndex } from "../world/coords.js";
import type { DecorId } from "./decor.js";
import { TFlag } from "./flags.js";
import { T, type TerrainId, terrainDef } from "./terrain.js";

/**
 * A generated chunk.
 *
 * Parallel typed arrays rather than an array of cell objects. Twenty-five
 * loaded chunks would be 100k plain objects and constant GC churn; as typed
 * arrays the same data is about 50KB total and serialises in one call.
 */
export interface Chunk {
	readonly cc: ChunkCoord;
	readonly terrain: Uint16Array;
	readonly decor: Uint16Array;
	readonly flags: Uint8Array;
	/** Stable per-tile index used to pick between glyph variants. */
	readonly variant: Uint8Array;
	/**
	 * Terrain height, quantised to 0..255 from the generator's 0..1 field.
	 *
	 * Kept so the renderer can shade by slope without resampling the noise: the
	 * field is pure, so recomputing it would give the same answer, but it would
	 * cost several octaves of fbm per visible cell every frame. 8 bits is far
	 * more precision than a shading gradient can show.
	 */
	readonly elevation: Uint8Array;
	/** True while the chunk was generated before its LLM spec arrived. */
	provisional: boolean;
}

export function createChunk(cc: ChunkCoord): Chunk {
	return {
		cc,
		terrain: new Uint16Array(CHUNK_AREA),
		decor: new Uint16Array(CHUNK_AREA),
		flags: new Uint8Array(CHUNK_AREA),
		variant: new Uint8Array(CHUNK_AREA),
		elevation: new Uint8Array(CHUNK_AREA),
		provisional: false,
	};
}

export function inChunk(localX: number, localY: number): boolean {
	return localX >= 0 && localY >= 0 && localX < CHUNK && localY < CHUNK;
}

/**
 * Write a terrain id and derive its flags. Always prefer this over touching
 * `terrain` directly, so flags cannot drift away from the terrain registry.
 */
export function setTerrain(
	chunk: Chunk,
	localX: number,
	localY: number,
	id: TerrainId,
	extraFlags = 0,
): void {
	if (!inChunk(localX, localY)) return;
	const i = localIndex(localX, localY);
	chunk.terrain[i] = id;
	chunk.flags[i] = terrainDef(id).flags | extraFlags;
}

export function addFlags(chunk: Chunk, localX: number, localY: number, flags: number): void {
	if (!inChunk(localX, localY)) return;
	const i = localIndex(localX, localY);
	chunk.flags[i] = (chunk.flags[i] ?? 0) | flags;
}

export function setDecor(chunk: Chunk, localX: number, localY: number, id: DecorId): void {
	if (!inChunk(localX, localY)) return;
	chunk.decor[localIndex(localX, localY)] = id;
}

export function getTerrain(chunk: Chunk, localX: number, localY: number): TerrainId {
	if (!inChunk(localX, localY)) return T.void;
	return chunk.terrain[localIndex(localX, localY)] ?? T.void;
}

export function getFlags(chunk: Chunk, localX: number, localY: number): number {
	if (!inChunk(localX, localY)) return 0;
	return chunk.flags[localIndex(localX, localY)] ?? 0;
}

export function isPassableAt(chunk: Chunk, localX: number, localY: number): boolean {
	return (getFlags(chunk, localX, localY) & TFlag.Passable) !== 0;
}

/**
 * Debug and golden rendering: exactly one ASCII byte per tile.
 *
 * Strictly ASCII so a golden file is byte-per-tile and diffs align in a
 * fixed-width view; a multi-byte glyph here would silently make some goldens
 * twice the size of others.
 */
const ASCII_BY_KEY: Readonly<Record<string, string>> = {
	void: " ",
	deepWater: "~",
	water: "s",
	ice: "i",
	sand: ".",
	grass: ",",
	tallGrass: '"',
	forestFloor: "`",
	dirt: "-",
	gravel: ":",
	marsh: "%",
	reeds: "|",
	farmland: "F",
	snow: "*",
	dirtRoad: "+",
	cobbleRoad: "#",
	path: "+",
	bridge: "H",
	conifer: "^",
	broadleaf: "&",
	deadTree: "t",
	bush: "o",
	flowers: "v",
	crops: "w",
	stump: "u",
	rock: "0",
	cliff: "M",
	mountain: "A",
	rubble: ";",
	stoneWall: "W",
	woodWall: "B",
	fence: "f",
	roof: "R",
	window: "n",
	doorClosed: "D",
	doorOpen: "d",
	floorWood: "_",
	floorStone: "'",
	rug: "r",
	stairsDown: ">",
	stairsUp: "<",
	gateClosed: "G",
	gateOpen: "g",
	pier: "=",
	deck: "b",
	caveMouth: "C",
	caveFloor: "'",
	caveWall: "W",
};

export function terrainToAscii(id: TerrainId): string {
	return ASCII_BY_KEY[terrainDef(id).key] ?? "?";
}

/**
 * Dump a chunk as ASCII rows.
 *
 * Goldens are stored in this form deliberately: a regression shows up in a diff
 * as a shape you can look at and recognise, rather than as a changed hash.
 */
export function chunkToAscii(chunk: Chunk): string {
	const rows: string[] = [];
	for (let y = 0; y < CHUNK; y++) {
		let row = "";
		for (let x = 0; x < CHUNK; x++) {
			row += terrainToAscii(chunk.terrain[localIndex(x, y)] ?? T.void);
		}
		rows.push(row);
	}
	return rows.join("\n");
}

/** Content hash over the arrays that define a chunk, for determinism tests. */
export function chunkDigest(chunk: Chunk): string {
	let h1 = 0x811c9dc5 | 0;
	let h2 = 0x01000193 | 0;
	for (let i = 0; i < CHUNK_AREA; i++) {
		const value =
			(chunk.terrain[i] ?? 0) | ((chunk.decor[i] ?? 0) << 16) | ((chunk.flags[i] ?? 0) << 8);
		h1 = Math.imul(h1 ^ value, 0x01000193);
		h2 = Math.imul(h2 ^ ((chunk.variant[i] ?? 0) + i), 0x85ebca6b);
		// Elevation is part of what defines a chunk, so the seam and determinism
		// suites must cover it too.
		h2 = Math.imul(h2 ^ (chunk.elevation[i] ?? 0), 0xc2b2ae35);
	}
	return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}
