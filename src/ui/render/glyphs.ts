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
import { DEFAULT_PALETTE, type Palette, paletteColor } from "./palette.js";

/**
 * How a tile is drawn in glyph mode, once its colours are resolved.
 *
 * Two shapes exist for everything below: a *spec*, which names its colours by palette
 * key, and a *source*, which carries the resolved RGB. Authoring in keys is what makes
 * a tile pack able to change the whole map's colour by supplying eleven numbers rather
 * than restating sixty glyphs — and it is why `PAL` is no longer read here directly.
 */
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

/** The same, with colours as palette keys. What the tables below are written in. */
export interface GlyphDraft {
	readonly ch: string | readonly string[];
	readonly fg: string;
	readonly bg?: string;
	readonly bold?: boolean;
	readonly dim?: boolean;
	/** Named autotile set, when the tile connects to its neighbours. */
	readonly autotile?: AutotileSet;
}

function stat(
	ch: string,
	fg: string,
	bg?: string,
	extra?: { bold?: boolean; dim?: boolean },
): GlyphDraft {
	return { ch, fg, ...(bg ? { bg } : {}), ...extra };
}

function vary(chars: readonly string[], fg: string, bg: string): GlyphDraft {
	return { ch: chars, fg, bg };
}

function auto(set: AutotileSet, fg: string, bg: string, extra?: { bold?: boolean }): GlyphDraft {
	return { ch: set.table, fg, bg, autotile: set, ...extra };
}

/** Turn a draft into something the compositor can read, against a palette. */
export function resolveGlyph(draft: GlyphDraft, palette: Palette): GlyphSource {
	const fg = paletteColor(palette, draft.fg);
	const bg = draft.bg === undefined ? undefined : paletteColor(palette, draft.bg);
	const extra = {
		...(draft.bold ? { bold: true } : {}),
		...(draft.dim ? { dim: true } : {}),
	};
	if (draft.autotile) {
		return { kind: "autotile", set: draft.autotile, base: { fg, ...(bg ? { bg } : {}), ...extra } };
	}
	if (Array.isArray(draft.ch)) {
		return {
			kind: "variants",
			glyphs: draft.ch.map((ch) => ({ ch, fg, ...(bg ? { bg } : {}), ...extra })),
		};
	}
	return { kind: "static", glyph: { ch: draft.ch as string, fg, ...(bg ? { bg } : {}), ...extra } };
}

export const TERRAIN_GLYPH_DRAFTS: Readonly<Record<string, GlyphDraft>> = {
	void: stat(" ", "ash"),

	deepWater: auto(WATER_EDGE, "deep", "abyss"),
	water: auto(WATER_EDGE, "foam", "shallow"),
	ice: vary(["░", "▒"], "ice", "iceDark"),

	sand: vary(["░", "·", "░", "."], "sand", "sandDark"),
	grass: vary(["░", ",", "'", ".", "░", "░"], "moss", "mossDark"),
	tallGrass: vary(["▒", "▓"], "leaf", "leafDark"),
	forestFloor: vary([".", ",", "·", "'"], "leafDark", "loam"),
	dirt: vary([" ", "·", " ", "."], "dirtDark", "dirt"),
	gravel: vary(["░", ":", "░", "."], "gravel", "gravelDark"),
	marsh: vary(["~", "░", ",", "~"], "reedDark", "mud"),
	reeds: vary(["|", "!", "|"], "reed", "reedDark"),
	farmland: vary(["=", "-", "="], "dirtDark", "dirt"),
	snow: vary(["░", " ", "░", "."], "snow", "snowShadow"),

	// Roads read as a background band. Keeping them nearly untextured is what
	// lets the eye follow a route across a busy map: any repeated glyph dense
	// enough to see is also dense enough to be confused with tall grass.
	dirtRoad: vary([" ", " ", " ", "·", " ", " "], "dirtDark", "dirt"),
	cobbleRoad: vary([" ", "░", " ", " ", " ", "░"], "cobble", "cobbleDark"),
	path: vary([" ", " ", "·", " ", " ", " "], "sandDark", "dirtDark"),
	bridge: auto(DOUBLE_SPAN, "plank", "shallow"),

	conifer: stat("▲", "pine", "pineDark", { bold: true }),
	broadleaf: auto(MASS_EDGE, "oak", "oakDark"),
	deadTree: stat("†", "gravel", "loam"),
	bush: stat("▒", "leaf", "leafDark"),
	flowers: stat("*", "bloom1", "mossDark", { bold: true }),
	crops: vary(["≡", "="], "wheat", "wheatDark"),
	stump: stat("o", "timberDark", "loam"),

	rock: stat("●", "slate", "slateDark"),
	cliff: auto(MASS_EDGE, "slate", "slateDark"),
	mountain: stat("▲", "stone", "slateDark", { bold: true }),
	rubble: vary(["░", ":", "░"], "slate", "stoneDark"),

	stoneWall: auto(HEAVY_WALL, "stone", "stoneDark", { bold: true }),
	woodWall: auto(HEAVY_WALL, "timber", "timberDark", { bold: true }),
	fence: auto(LIGHT_FENCE, "timber", "mossDark"),
	roof: vary(["▒", "▓"], "tile", "tileDark"),
	window: stat("▤", "glass", "timberDark", { bold: true }),
	doorClosed: stat("+", "brass", "timberDark", { bold: true }),
	doorOpen: stat("/", "brass", "soot", { bold: true }),
	// Bars across the way, and the arch they hang in. Both glyphs already carry a
	// sprite of the right shape — `╫` is a horizontal rail over two uprights, which
	// is a portcullis, and `∩` is an archway — so the pixel renderer needs nothing
	// added for these to read correctly.
	gateClosed: stat("╫", "brass", "stoneDark", { bold: true }),
	gateOpen: stat("∩", "stone", "soot"),
	floorWood: vary(["─", " ", "─", " "], "plankDark", "plank"),
	floorStone: vary(["░", " ", "░"], "cobbleDark", "cobble"),
	rug: stat("▒", "blood", "timberDark"),
	stairsDown: stat(">", "bone", "ash", { bold: true }),
	stairsUp: stat("<", "bone", "ash", { bold: true }),
	// Planks over water: the boards read across the run, and the dark water shows
	// between them, which is what tells a pier from a road at a glance.
	pier: vary(["═", "─"], "plank", "shallow"),
	deck: vary(["─", " "], "plankDark", "plank"),
	caveMouth: stat("∩", "stoneDark", "soot", { bold: true }),
	caveFloor: vary(["░", " ", "·"], "gravelDark", "ash"),
	caveWall: auto(HEAVY_WALL, "slateDark", "soot", { bold: true }),

	// Drawn over sand rather than over moss: these are the tiles that exist so a hot
	// world stops looking like a temperate one recoloured, and putting them on a green
	// ground would put the problem straight back.
	palm: stat("¥", "leaf", "sandDark", { bold: true }),
	saguaro: stat("⋔", "pine", "sandDark", { bold: true }),
	// Sleepers across the run, and the same near-untextured band every other road is,
	// for the reason given above them: a route has to be followable across a busy map.
	track: vary(["‡", "═", "‡", " "], "rail", "railDark"),
	adobeWall: auto(HEAVY_WALL, "adobe", "adobeDark", { bold: true }),
};

export const DECOR_GLYPH_DRAFTS: Readonly<Record<string, GlyphDraft>> = {
	none: stat(" ", "ash"),
	sign: stat("╤", "lamplight", undefined, { bold: true }),
	signpost: stat("╪", "timber", undefined, { bold: true }),
	well: stat("▢", "stone", undefined, { bold: true }),
	stall: stat("∩", "blood", undefined, { bold: true }),
	bench: stat("▬", "timber"),
	barrel: stat("◍", "timberDark"),
	crate: stat("▨", "timber"),
	chest: stat("▣", "brass", undefined, { bold: true }),
	table: stat("▤", "timber"),
	chair: stat("⊓", "timberDark"),
	bed: stat("▭", "bone"),
	hearth: stat("▩", "blood", undefined, { bold: true }),
	anvil: stat("▟", "slate", undefined, { bold: true }),
	counter: stat("▬", "plank", undefined, { bold: true }),
	shelf: stat("≣", "timberDark"),
	statue: stat("§", "stone", undefined, { bold: true }),
	grave: stat("†", "stone"),
	shrine: stat("╫", "lamplight", undefined, { bold: true }),
	campfire: stat("※", "bloom0", undefined, { bold: true }),
	lamp: stat("¡", "lamplight", undefined, { bold: true }),
	item: stat("·", "bone", undefined, { bold: true }),
	boat: stat("◄", "timber", undefined, { bold: true }),
	mooring: stat("¡", "timberDark"),
	banner: stat("▮", "blood", undefined, { bold: true }),
	totem: stat("╥", "timberDark", undefined, { bold: true }),
	keg: stat("◉", "timber"),
	loom: stat("▥", "timber"),
	cauldron: stat("∪", "slateDark", undefined, { bold: true }),
};

const MISSING: GlyphDraft = stat("?", "blood");

/**
 * Dense arrays indexed by id, so the render loop never does a string lookup.
 *
 * Built per theme rather than once at module load. A pack supplies drafts for the keys
 * it wants to change and inherits the rest, which is the same merge rule content packs
 * use: maps merge by key, lists replace.
 */
export function buildGlyphTable(
	kind: "terrain" | "decor",
	overrides: Readonly<Record<string, GlyphDraft>> | undefined,
	palette: Palette,
): readonly GlyphSource[] {
	const defaults = kind === "terrain" ? TERRAIN_GLYPH_DRAFTS : DECOR_GLYPH_DRAFTS;
	const defs = kind === "terrain" ? TERRAIN : DECOR;
	return defs.map((def) =>
		resolveGlyph(overrides?.[def.key] ?? defaults[def.key] ?? MISSING, palette),
	);
}

export const TERRAIN_GLYPH: readonly GlyphSource[] = buildGlyphTable(
	"terrain",
	undefined,
	DEFAULT_PALETTE,
);

export const DECOR_GLYPH: readonly GlyphSource[] = buildGlyphTable(
	"decor",
	undefined,
	DEFAULT_PALETTE,
);

/**
 * The player is `@` regardless of facing.
 *
 * Every directional alternative is worse. `▲▼◀▶` collide with the conifer and
 * mountain glyphs, so on a wooded map the player vanishes into the treeline —
 * and `◀▶` carry emoji presentations that render double-width, which tears the
 * row. `↑↓←→` read as interface rather than as a person and are East-Asian
 * Ambiguous, so the same width risk applies. `@` is the roguelike convention
 * precisely because nothing else uses it.
 *
 * So facing is not in the glyph. It used to be a mark painted on the tile in
 * front, which cost that tile its own character — you could not see the sign you
 * were about to read. It is now the pixel renderer's business, where a sprite
 * has room for a wedge on the side it faces, and in glyph mode it is stated as
 * an arrow beside the line describing what is there.
 */
export const PLAYER_GLYPH = "@";

export function terrainGlyphSource(id: TerrainId): GlyphSource {
	return TERRAIN_GLYPH[id] ?? (TERRAIN_GLYPH[T.void] as GlyphSource);
}

export function decorGlyphSource(id: DecorId): GlyphSource {
	return DECOR_GLYPH[id] ?? (DECOR_GLYPH[D.none] as GlyphSource);
}

/** Every glyph a set of tables can emit, for validation and for tests. */
export function allRegisteredGlyphs(
	tables: readonly (readonly GlyphSource[])[] = [TERRAIN_GLYPH, DECOR_GLYPH],
	player: string = PLAYER_GLYPH,
): string[] {
	const out: string[] = [];
	for (const source of tables.flat()) {
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
	out.push(player);
	return out;
}

// Fail at import time rather than shipping a torn map to the player.
assertSafeGlyphs(allRegisteredGlyphs(), "tile glyph registry");
