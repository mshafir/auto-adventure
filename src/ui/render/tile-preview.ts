import { terrainByKey } from "../../core/tiles/terrain.js";
import type { RGB } from "./color.js";
import type { GlyphSpec } from "./glyphs.js";
import type { TileTheme } from "./theme.js";

/**
 * A few rows of a world, so a tile pack can be seen before it is chosen.
 *
 * Choosing a look from a list of names is choosing blind. The names are the least
 * informative thing about a pack — `gramarye` and `inkwell` tell a player nothing about
 * whether one is warm and one is cold — and the cost of finding out was generating a
 * world and looking at it.
 *
 * The data lives here rather than in the launcher component for the reason
 * `minimap-data.ts` gives: what to draw and how to draw it are different questions, and
 * only one of them needs Ink. A pixel renderer could composite the same cells.
 */

export interface PreviewCell {
	readonly ch: string;
	readonly fg: RGB;
	readonly bg?: RGB;
	readonly bold?: boolean;
	readonly dim?: boolean;
}

/**
 * The scene, as terrain keys.
 *
 * Composed rather than sampled, and every tile in it is doing a job. Water through sand
 * to grass is the coast, because the sea is the single biggest block of colour a pack
 * chooses; the trees say what a wood looks like; the two roads are the pair most often
 * confused after a recolour; the walls, roof and door are the only chance to see a
 * building, which is where a pack is most likely to look wrong; and the last column
 * climbs to rock and snow so a cold pack and a warm one differ at the end of the row as
 * well as the start.
 *
 * Sixteen wide because that fits beside a body paragraph on an eighty-column terminal
 * with the indent this list uses, and three tall because two cannot hold a building.
 */
export const PREVIEW_SCENE: readonly (readonly string[])[] = [
	[
		"deepWater",
		"water",
		"sand",
		"grass",
		"tallGrass",
		"broadleaf",
		"conifer",
		"forestFloor",
		"grass",
		"crops",
		"farmland",
		"grass",
		"bush",
		"rock",
		"cliff",
		"mountain",
	],
	[
		"water",
		"sand",
		"grass",
		"dirtRoad",
		"dirtRoad",
		"dirtRoad",
		"cobbleRoad",
		"cobbleRoad",
		"cobbleRoad",
		"dirtRoad",
		"grass",
		"flowers",
		"gravel",
		"rock",
		"cliff",
		"snow",
	],
	[
		"sand",
		"grass",
		"grass",
		"stoneWall",
		"roof",
		"doorClosed",
		"roof",
		"stoneWall",
		"grass",
		"fence",
		"woodWall",
		"roof",
		"woodWall",
		"grass",
		"marsh",
		"reeds",
	],
];

export const PREVIEW_WIDTH = PREVIEW_SCENE[0]?.length ?? 0;
export const PREVIEW_HEIGHT = PREVIEW_SCENE.length;

/**
 * One glyph out of a source, without a world to ask.
 *
 * A variant glyph is chosen by position rather than by the per-tile hash the renderer
 * uses, which keeps a preview stable between frames and still lets a textured tile show
 * that it *has* texture. An autotile is drawn as its fully-connected form: a wall in a
 * preview has no neighbours to read, and the isolated form is a stub that makes every
 * pack's masonry look broken.
 */
function pick(source: TileTheme["terrain"][number], column: number): GlyphSpec {
	if (source.kind === "static") return source.glyph;
	if (source.kind === "variants") {
		const glyphs = source.glyphs;
		return (glyphs[column % glyphs.length] ?? glyphs[0]) as GlyphSpec;
	}
	// Mask 15 is "joined on all four sides", the middle of a run of wall.
	const ch = source.set.table[15] ?? source.set.table[0] ?? "?";
	return { ch, ...source.base };
}

/** The scene, drawn in a theme. */
export function previewRows(theme: TileTheme): PreviewCell[][] {
	return PREVIEW_SCENE.map((row) =>
		row.map((key, column) => {
			const def = terrainByKey(key);
			// A pack cannot remove a terrain, so this only fires if the scene above names
			// one that has been renamed — in which case a blank is better than a crash on
			// the launcher's first frame.
			const source = def ? theme.terrain[def.id] : undefined;
			if (!source) return { ch: " ", fg: [0, 0, 0] as RGB };
			const glyph = pick(source, column);
			return {
				ch: glyph.ch,
				fg: glyph.fg,
				...(glyph.bg ? { bg: glyph.bg } : {}),
				...(glyph.bold ? { bold: true } : {}),
				...(glyph.dim ? { dim: true } : {}),
			};
		}),
	);
}
