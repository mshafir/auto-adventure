import { D } from "../../core/tiles/decor.js";
import { T } from "../../core/tiles/terrain.js";
import { FULL_MASK } from "../render/autotile.js";
import { toHex } from "../render/color.js";
import {
	decorGlyphSource,
	type GlyphSource,
	PLAYER_GLYPH,
	terrainGlyphSource,
} from "../render/glyphs.js";
import type { TileMode } from "../render/mode.js";
import { PAL } from "../render/palette.js";

/**
 * What the glyphs on the map mean.
 *
 * Read out of the same registry the renderer draws from rather than written out
 * by hand, so a legend cannot quietly start describing a colour or a character
 * the game stopped using. Only the things worth acting on are listed — a key
 * long enough to name every terrain would be a wall of text nobody reads.
 */
export interface LegendEntry {
	readonly ch: string;
	/** `#rrggbb`, taken from the tile's own palette entry. */
	readonly color: string;
	readonly label: string;
	readonly bold?: boolean;
}

/** One representative glyph for a source that may have several. */
function sample(source: GlyphSource): { ch: string; color: string; bold: boolean } {
	switch (source.kind) {
		case "static":
			return {
				ch: source.glyph.ch,
				color: toHex(source.glyph.fg),
				bold: source.glyph.bold ?? false,
			};
		case "variants": {
			// The first variant is the plain one; the rest are texture.
			const first = source.glyphs[0];
			return first
				? { ch: first.ch, color: toHex(first.fg), bold: first.bold ?? false }
				: { ch: "?", color: toHex(PAL.blood), bold: false };
		}
		case "autotile":
			// The fully-surrounded entry: the body of the mass rather than its edge,
			// which is what the eye actually picks out on the map.
			return {
				ch: source.set.table[FULL_MASK] ?? "?",
				color: toHex(source.base.fg),
				bold: source.base.bold ?? false,
			};
	}
}

function fromTerrain(id: number, label: string): LegendEntry {
	const { ch, color, bold } = sample(terrainGlyphSource(id));
	return { ch, color, label, bold };
}

function fromDecor(id: number, label: string): LegendEntry {
	const { ch, color, bold } = sample(decorGlyphSource(id));
	return { ch, color, label, bold };
}

/**
 * The map key, in reading order: you, people, then things worth walking to.
 *
 * Takes the renderer because the answer genuinely differs. In glyph mode the key
 * is a list of characters; in pixel mode there are no characters on the map at
 * all, and printing `♠ ▒ ~` beside "trees" and "water" describes a screen the
 * player is not looking at.
 */
export function mapLegend(mode: TileMode = "glyph"): readonly LegendEntry[] {
	return mode === "kitty" ? pixelLegend() : glyphLegend();
}

function glyphLegend(): readonly LegendEntry[] {
	return [
		{ ch: PLAYER_GLYPH, color: toHex(PAL.player), label: "you", bold: true },
		{ ch: "A", color: toHex(PAL.neutral), label: "folk" },
		...THINGS.map((thing) => thing.entry()),
	];
}

/**
 * A block of colour and a few words about the shape, rather than a character.
 *
 * The colour comes from the same registry entry the glyph renderer takes its
 * character from, so a swatch cannot drift from the map any more than a character
 * could. The shape does not: it is written down, because a `Shape` is a predicate
 * over the unit square and there is no honest way to reduce one to a single
 * terminal cell.
 *
 * Both halves are needed, and the reason is visible in the table itself — a door
 * and a chest are the same amber, so a key of pure colour would have two entries
 * nobody could tell apart. Colour narrows it down; the shape settles it.
 *
 * People are the case where this is not merely a translation. Every person is the
 * same figure at tile size, because a letter is not legible in forty pixels; what
 * distinguishes them is `dispositionColor`, and that is a fact about pixel mode
 * that the glyph key never had to state. So the four shades get a line each.
 *
 * Not a strip of the real sprites, tempting as that is. A placeholder cell beside
 * a text label puts two things on one screen row, which is exactly where Ink slices
 * U+10EEEE by UTF-16 code unit and halves the run — the defect that cost the side
 * panel. Colour survives that; an image would not.
 */
function pixelLegend(): readonly LegendEntry[] {
	return [
		{ ch: SWATCH, color: toHex(PAL.player), label: "you — a figure, wedge on the side you face" },
		{ ch: SWATCH, color: toHex(PAL.friendly), label: "folk, well disposed" },
		{ ch: SWATCH, color: toHex(PAL.neutral), label: "folk, indifferent" },
		{ ch: SWATCH, color: toHex(PAL.wary), label: "folk, wary" },
		{ ch: SWATCH, color: toHex(PAL.hostile), label: "folk, hostile" },
		...THINGS.map((thing) => {
			const entry = thing.entry();
			return { ...entry, ch: SWATCH, bold: false, label: `${entry.label} — ${thing.drawn}` };
		}),
	];
}

/**
 * A full block, which is the whole point: it is a sample of a colour and nothing
 * else. U+2588 is in Block Elements, one of the ranges `glyph-safety.ts` allows,
 * so it cannot tear a row the way a symbol from an emoji-presenting block would.
 */
const SWATCH = "█";

/**
 * The things worth naming, where each one's colour comes from, and what the pixel
 * renderer actually draws for it.
 *
 * `drawn` was read off the sprites rather than imagined: each was rasterised and
 * printed as ASCII before the phrase was written. A wall has no shape at all — it
 * is a density sprite, which folds its shade into the ground colour and draws
 * nothing — and saying so is more use than inventing an outline for it.
 */
const THINGS: readonly { readonly entry: () => LegendEntry; readonly drawn: string }[] = [
	{ entry: () => fromTerrain(T.doorClosed, "door"), drawn: "an upright cross" },
	{ entry: () => fromDecor(D.sign, "sign"), drawn: "a board on a post" },
	{ entry: () => fromDecor(D.chest, "chest"), drawn: "a ring round a block" },
	{ entry: () => fromDecor(D.crate, "crate"), drawn: "a diagonal band" },
	{ entry: () => fromTerrain(T.crops, "crops"), drawn: "rows of upright stalks" },
	{ entry: () => fromTerrain(T.conifer, "trees"), drawn: "a cone on a trunk" },
	{ entry: () => fromTerrain(T.rock, "rock"), drawn: "a round boulder" },
	{ entry: () => fromTerrain(T.water, "water"), drawn: "two wave bands" },
	{ entry: () => fromTerrain(T.stoneWall, "wall"), drawn: "a solid fill" },
];
