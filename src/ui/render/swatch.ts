/**
 * Naming a colour, for tables that want to be data.
 *
 * The renderer's glyph and colour tables are on their way out of TypeScript and
 * into theme packs, alongside the content packs in `assets/content`. A pack is
 * JSON, so it cannot hold a `PAL.moss` reference — but it should not be reduced
 * to hex literals either, because naming the swatch is what keeps a legend, a
 * minimap and the tile they describe the same green after somebody retunes the
 * palette.
 *
 * So a themed colour is a string: the name of a palette entry, or a literal
 * `#rrggbb` for the cases the palette has no word for.
 */
import { type RGB, rgb } from "./color.js";
import { PAL } from "./palette.js";

/** A palette entry's name, or `#rrggbb`. */
export type Swatch = string;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A palette entry that is a single colour; `PAL.bloom` is a list, so not one. */
function named(name: string): RGB | undefined {
	const found = (PAL as Readonly<Record<string, unknown>>)[name];
	return Array.isArray(found) && found.length === 3 && typeof found[0] === "number"
		? (found as unknown as RGB)
		: undefined;
}

/**
 * Resolve a themed colour.
 *
 * Falls back to magenta rather than throwing. A theme is data, and once it can
 * come from a pack a typo in it must not stop the game from starting — but it
 * should be impossible to miss on screen, so the fallback is a colour the
 * palette never produces.
 */
export function swatch(name: Swatch): RGB {
	const fromPalette = named(name);
	if (fromPalette) return fromPalette;
	if (HEX.test(name)) return rgb(name);
	return MISSING;
}

/** Not in the palette: nothing in the world is this colour. */
export const MISSING: RGB = rgb("#ff00ff");
