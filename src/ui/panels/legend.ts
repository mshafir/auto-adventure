import { D } from "../../core/tiles/decor.js";
import { T } from "../../core/tiles/terrain.js";
import { FULL_MASK } from "../render/autotile.js";
import { toHex } from "../render/color.js";
import {
	decorGlyphSource,
	FACING_MARKER,
	type GlyphSource,
	PLAYER_GLYPH,
	terrainGlyphSource,
} from "../render/glyphs.js";
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

/** The map key, in reading order: you, people, then things worth walking to. */
export function mapLegend(): readonly LegendEntry[] {
	return [
		{ ch: PLAYER_GLYPH, color: toHex(PAL.player), label: "you", bold: true },
		{ ch: "A", color: toHex(PAL.neutral), label: "folk" },
		{ ch: FACING_MARKER, color: toHex(PAL.player), label: "facing", bold: true },
		fromTerrain(T.doorClosed, "door"),
		fromDecor(D.sign, "sign"),
		fromDecor(D.chest, "chest"),
		fromDecor(D.crate, "crate"),
		fromTerrain(T.crops, "crops"),
		fromTerrain(T.conifer, "trees"),
		fromTerrain(T.rock, "rock"),
		fromTerrain(T.water, "water"),
		fromTerrain(T.stoneWall, "wall"),
	];
}
