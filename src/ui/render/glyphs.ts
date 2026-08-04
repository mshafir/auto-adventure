import { D, DECOR, type DecorId } from "../../core/tiles/decor.js";
import { T, TERRAIN, type TerrainId } from "../../core/tiles/terrain.js";
import {
	type AutotileSet,
	DOUBLE_SPAN,
	HEAVY_WALL,
	LIGHT_FENCE,
	MASS_EDGE,
	WATER_EDGE,
} from "./autotile.js";
import type { RGB } from "./color.js";
import { assertSafeGlyphs } from "./glyph-safety.js";
import { PAL } from "./palette.js";

export interface GlyphSpec {
	/** Exactly one terminal column wide. Enforced by `assertSafeGlyphs`. */
	readonly ch: string;
	readonly fg: RGB;
	/** Absent means "inherit whatever the layer below painted". */
	readonly bg?: RGB;
	readonly bold?: boolean;
	readonly dim?: boolean;
}

export type GlyphSource =
	| { readonly kind: "static"; readonly glyph: GlyphSpec }
	/** Indexed by the tile's stable per-position variant, for texture. */
	| { readonly kind: "variants"; readonly glyphs: readonly GlyphSpec[] }
	| { readonly kind: "autotile"; readonly set: AutotileSet; readonly base: Omit<GlyphSpec, "ch"> };

function stat(
	ch: string,
	fg: RGB,
	bg?: RGB,
	extra?: { bold?: boolean; dim?: boolean },
): GlyphSource {
	return { kind: "static", glyph: { ch, fg, ...(bg ? { bg } : {}), ...extra } };
}

function vary(chars: readonly string[], fg: RGB, bg: RGB): GlyphSource {
	return { kind: "variants", glyphs: chars.map((ch) => ({ ch, fg, bg })) };
}

function auto(set: AutotileSet, fg: RGB, bg: RGB, extra?: { bold?: boolean }): GlyphSource {
	return { kind: "autotile", set, base: { fg, bg, ...extra } };
}

const TERRAIN_GLYPHS: Readonly<Record<string, GlyphSource>> = {
	void: stat(" ", PAL.ash),

	deepWater: auto(WATER_EDGE, PAL.deep, PAL.abyss),
	water: auto(WATER_EDGE, PAL.foam, PAL.shallow),
	ice: vary(["░", "▒"], PAL.ice, PAL.iceDark),

	sand: vary(["░", "·", "░", "."], PAL.sand, PAL.sandDark),
	grass: vary(["░", ",", "'", ".", "░", "░"], PAL.moss, PAL.mossDark),
	tallGrass: vary(["▒", "▓"], PAL.leaf, PAL.leafDark),
	forestFloor: vary([".", ",", "·", "'"], PAL.leafDark, PAL.loam),
	dirt: vary([" ", "·", " ", "."], PAL.dirtDark, PAL.dirt),
	gravel: vary(["░", ":", "░", "."], PAL.gravel, PAL.gravelDark),
	marsh: vary(["~", "░", ",", "~"], PAL.reedDark, PAL.mud),
	reeds: vary(["|", "!", "|"], PAL.reed, PAL.reedDark),
	farmland: vary(["=", "-", "="], PAL.dirtDark, PAL.dirt),
	snow: vary(["░", " ", "░", "."], PAL.snow, PAL.snowShadow),

	// Roads read as a background band. Keeping them nearly untextured is what
	// lets the eye follow a route across a busy map: any repeated glyph dense
	// enough to see is also dense enough to be confused with tall grass.
	dirtRoad: vary([" ", " ", " ", "·", " ", " "], PAL.dirtDark, PAL.dirt),
	cobbleRoad: vary([" ", "░", " ", " ", " ", "░"], PAL.cobble, PAL.cobbleDark),
	path: vary([" ", " ", "·", " ", " ", " "], PAL.sandDark, PAL.dirtDark),
	bridge: auto(DOUBLE_SPAN, PAL.plank, PAL.shallow),

	conifer: stat("▲", PAL.pine, PAL.pineDark, { bold: true }),
	broadleaf: auto(MASS_EDGE, PAL.oak, PAL.oakDark),
	deadTree: stat("†", PAL.gravel, PAL.loam),
	bush: stat("▒", PAL.leaf, PAL.leafDark),
	flowers: stat("*", PAL.bloom[1] as RGB, PAL.mossDark, { bold: true }),
	crops: vary(["≡", "="], PAL.wheat, PAL.wheatDark),
	stump: stat("o", PAL.timberDark, PAL.loam),

	rock: stat("●", PAL.slate, PAL.slateDark),
	cliff: auto(MASS_EDGE, PAL.slate, PAL.slateDark),
	mountain: stat("▲", PAL.stone, PAL.slateDark, { bold: true }),
	rubble: vary(["░", ":", "░"], PAL.slate, PAL.stoneDark),

	stoneWall: auto(HEAVY_WALL, PAL.stone, PAL.stoneDark, { bold: true }),
	woodWall: auto(HEAVY_WALL, PAL.timber, PAL.timberDark, { bold: true }),
	fence: auto(LIGHT_FENCE, PAL.timber, PAL.mossDark),
	roof: vary(["▒", "▓"], PAL.tile, PAL.tileDark),
	window: stat("▤", PAL.glass, PAL.timberDark, { bold: true }),
	doorClosed: stat("+", PAL.brass, PAL.timberDark, { bold: true }),
	doorOpen: stat("/", PAL.brass, PAL.soot, { bold: true }),
	floorWood: vary(["─", " ", "─", " "], PAL.plankDark, PAL.plank),
	floorStone: vary(["░", " ", "░"], PAL.cobbleDark, PAL.cobble),
	rug: stat("▒", PAL.blood, PAL.timberDark),
	stairsDown: stat(">", PAL.bone, PAL.ash, { bold: true }),
	stairsUp: stat("<", PAL.bone, PAL.ash, { bold: true }),
};

const DECOR_GLYPHS: Readonly<Record<string, GlyphSource>> = {
	none: stat(" ", PAL.ash),
	sign: stat("╤", PAL.lamplight, undefined, { bold: true }),
	signpost: stat("╪", PAL.timber, undefined, { bold: true }),
	well: stat("▢", PAL.stone, undefined, { bold: true }),
	stall: stat("∩", PAL.blood, undefined, { bold: true }),
	bench: stat("▬", PAL.timber),
	barrel: stat("◍", PAL.timberDark),
	crate: stat("▨", PAL.timber),
	chest: stat("▣", PAL.brass, undefined, { bold: true }),
	table: stat("▤", PAL.timber),
	chair: stat("⊓", PAL.timberDark),
	bed: stat("▭", PAL.bone),
	hearth: stat("▩", PAL.blood, undefined, { bold: true }),
	anvil: stat("▟", PAL.slate, undefined, { bold: true }),
	counter: stat("▬", PAL.plank, undefined, { bold: true }),
	shelf: stat("≣", PAL.timberDark),
	statue: stat("§", PAL.stone, undefined, { bold: true }),
	grave: stat("†", PAL.stone),
	shrine: stat("╫", PAL.lamplight, undefined, { bold: true }),
	campfire: stat("※", PAL.bloom[0] as RGB, undefined, { bold: true }),
	lamp: stat("¡", PAL.lamplight, undefined, { bold: true }),
	item: stat("·", PAL.bone, undefined, { bold: true }),
};

/** Dense arrays indexed by id, so the render loop never does a string lookup. */
export const TERRAIN_GLYPH: readonly GlyphSource[] = TERRAIN.map(
	(def) => TERRAIN_GLYPHS[def.key] ?? stat("?", PAL.blood),
);

export const DECOR_GLYPH: readonly GlyphSource[] = DECOR.map(
	(def) => DECOR_GLYPHS[def.key] ?? stat("?", PAL.blood),
);

/**
 * The player is `@` regardless of facing.
 *
 * Directional triangles read well in isolation but `▲` is also the conifer and
 * mountain glyph, so on a wooded map the player vanishes into the treeline.
 * `@` is the roguelike convention precisely because nothing else uses it.
 * Facing is shown instead by highlighting the tile being faced, which is more
 * useful anyway — it shows exactly what SPACE would interact with.
 */
export const PLAYER_GLYPH = "@";

/** Marks the tile the player is facing. */
export const FACING_MARKER = "·";

export function terrainGlyphSource(id: TerrainId): GlyphSource {
	return TERRAIN_GLYPH[id] ?? (TERRAIN_GLYPH[T.void] as GlyphSource);
}

export function decorGlyphSource(id: DecorId): GlyphSource {
	return DECOR_GLYPH[id] ?? (DECOR_GLYPH[D.none] as GlyphSource);
}

/** Every glyph this module can emit, for validation and for tests. */
export function allRegisteredGlyphs(): string[] {
	const out: string[] = [];
	for (const source of [...TERRAIN_GLYPH, ...DECOR_GLYPH]) {
		switch (source.kind) {
			case "static":
				out.push(source.glyph.ch);
				break;
			case "variants":
				out.push(...source.glyphs.map((g) => g.ch));
				break;
			case "autotile":
				out.push(...source.set.table);
				break;
		}
	}
	out.push(PLAYER_GLYPH, FACING_MARKER);
	return out;
}

// Fail at import time rather than shipping a torn map to the player.
assertSafeGlyphs(allRegisteredGlyphs(), "tile glyph registry");
