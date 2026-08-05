import { DECOR } from "../../core/tiles/decor.js";
import { TERRAIN } from "../../core/tiles/terrain.js";
import { assertSafeGlyphs } from "./glyph-safety.js";
import {
	allRegisteredGlyphs,
	buildGlyphTable,
	DECOR_GLYPH,
	type GlyphDraft,
	type GlyphSource,
	PLAYER_GLYPH,
	TERRAIN_GLYPH,
} from "./glyphs.js";
import { DEFAULT_PALETTE, type Palette } from "./palette.js";
import type { Sprite, SpriteTheme } from "./sprite.js";

/**
 * Everything about how a world looks, resolved once.
 *
 * The palette, the glyph tables and the sprite overrides were three module constants
 * read directly by the compositor and the rasteriser, which is fine for a game with
 * one look and impossible for a game where a scenario chooses its own. A theme is
 * those three lifted into a value built once when a world opens and threaded down.
 *
 * The merge rule is the one `core/content/pack.ts` already established, and for the
 * same reason: **maps merge by key, lists replace**. A pack that wants darker stone
 * says so in one line and inherits everything else; a pack that supplies a glyph for
 * `grass` replaces that tile's whole definition, because half a glyph is not a thing.
 */
export interface TileTheme {
	readonly name: string;
	readonly palette: Palette;
	/** Dense by terrain id, so the render loop never does a string lookup. */
	readonly terrain: readonly GlyphSource[];
	readonly decor: readonly GlyphSource[];
	readonly player: string;
	readonly sprites: SpriteTheme;
	/**
	 * True when any sprite carries its own colour.
	 *
	 * The compositor only records its lighting multiplier when something needs it, and
	 * only a full-colour tile does — so this is what turns that cost on and off.
	 */
	readonly hasBitmaps: boolean;
}

/** What a tile pack may say, once its files have been read and validated. */
export interface TilePackContent {
	readonly name: string;
	readonly palette?: Readonly<Record<string, string>>;
	readonly glyphs?: {
		readonly terrain?: Readonly<Record<string, GlyphDraft>>;
		readonly decor?: Readonly<Record<string, GlyphDraft>>;
	};
	readonly player?: string;
	readonly sprites?: {
		readonly terrain?: Readonly<Record<string, Sprite>>;
		readonly decor?: Readonly<Record<string, Sprite>>;
		readonly glyph?: Readonly<Record<string, Sprite>>;
	};
}

/** The look the game has when nobody has asked for another one. */
export const DEFAULT_THEME: TileTheme = {
	name: "default",
	palette: DEFAULT_PALETTE,
	terrain: TERRAIN_GLYPH,
	decor: DECOR_GLYPH,
	player: PLAYER_GLYPH,
	sprites: {},
	hasBitmaps: false,
};

/**
 * Build a theme from a pack.
 *
 * `assertSafeGlyphs` runs on the result, not merely on the built-in tables — which is
 * the point of doing it here. A pack that ships a double-width character would tear
 * every row it appears on, and the failure would look like a terminal bug rather than
 * like a bad file. Refusing the pack by name is the honest outcome.
 */
export function resolveTheme(pack: TilePackContent | undefined): TileTheme {
	if (!pack) return DEFAULT_THEME;

	const palette: Record<string, RGBLike> = { ...DEFAULT_PALETTE };
	for (const [key, value] of Object.entries(pack.palette ?? {})) {
		palette[key] = hexToRgb(value);
	}
	const resolved = palette as Palette;

	const terrain = buildGlyphTable("terrain", pack.glyphs?.terrain, resolved);
	const decor = buildGlyphTable("decor", pack.glyphs?.decor, resolved);
	const player = pack.player ?? PLAYER_GLYPH;

	assertSafeGlyphs(allRegisteredGlyphs([terrain, decor], player), `tile pack "${pack.name}"`);

	const sprites: SpriteTheme = {
		...(pack.sprites?.terrain ? { byTerrain: pack.sprites.terrain } : {}),
		...(pack.sprites?.decor ? { byDecor: pack.sprites.decor } : {}),
		...(pack.sprites?.glyph ? { byGlyph: pack.sprites.glyph } : {}),
	};

	const hasBitmaps = [
		...Object.values(pack.sprites?.terrain ?? {}),
		...Object.values(pack.sprites?.decor ?? {}),
		...Object.values(pack.sprites?.glyph ?? {}),
	].some((sprite) => sprite.kind === "bitmap");

	return { name: pack.name, palette: resolved, terrain, decor, player, sprites, hasBitmaps };
}

type RGBLike = readonly [number, number, number];

function hexToRgb(hex: string): RGBLike {
	const clean = hex.replace("#", "");
	const full =
		clean.length === 3
			? clean
					.split("")
					.map((c) => c + c)
					.join("")
			: clean;
	return [
		Number.parseInt(full.slice(0, 2), 16) || 0,
		Number.parseInt(full.slice(2, 4), 16) || 0,
		Number.parseInt(full.slice(4, 6), 16) || 0,
	];
}

/** Every terrain and decor key a pack may name, for validation and for docs. */
export function themableKeys(): { terrain: string[]; decor: string[] } {
	return {
		terrain: TERRAIN.map((def) => def.key),
		decor: DECOR.map((def) => def.key),
	};
}
