import type { Cell } from "./compose.js";

/**
 * Terminal columns per world tile.
 *
 * Two, because a cell is about twice as tall as it is wide, so one column per
 * tile renders the world stretched 2:1 vertically. `TILE_WIDTH=1` restores the
 * old geometry and shows twice as much world.
 *
 * Lives here rather than with the viewport so that command-line tools can render
 * exactly what the game renders without pulling in React and Ink.
 */
export const TILE_WIDTH = (() => {
	const raw = Number(process.env.TILE_WIDTH);
	return Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 2;
})();

/**
 * How many whole tiles fit in `columns` terminal columns.
 *
 * Rounds down and never returns zero. Overflow is the dangerous direction: one
 * column too many makes Ink wrap every row, which doubles the rendered height
 * and reads as flicker.
 */
export function tilesAcross(columns: number): number {
	return Math.max(1, Math.floor(columns / TILE_WIDTH));
}

/**
 * Widen a composed scene horizontally so tiles are square.
 *
 * A terminal cell is about twice as tall as the character advance width, so one
 * tile per cell renders the world stretched 2:1 vertically — a round town comes
 * out as a tall ellipse. Drawing each tile two columns wide fixes the geometry.
 * The cost is field of view, not bandwidth: the added column carries its
 * neighbour's style, so the row encoder still collapses the pair into a single
 * escape sequence and a frame grows only about a tenth for the same region.
 *
 * What goes in the added column is the whole question. Three rules, in order:
 *
 *  1. A box-drawing glyph with an east arm continues its line (`┏` → `┏━`).
 *     These are *shapes*: `┏┏` is two corners and `┏ ` is a broken wall, so
 *     continuation is the only reading that survives doubling.
 *  2. An area fill — water, canopy, roof shingle, cliff shading — covers the
 *     whole tile.
 *  3. A speck — grass, gravel, a tree, a rock — is drawn once, in whichever half
 *     of the tile its position selects, so it reads as scatter.
 *  4. Everything else keeps the left column and blanks the right: people, doors,
 *     windows, chests, and box-drawing that has no east arm to continue.
 *
 * Rules 2 and 3 are the same question answered two ways, and getting it wrong is
 * visible from across the room. Density for a speck is *per glyph* — `▲▲` is two
 * trees where `▲` is one — so a speck must never be repeated. Density for a fill
 * is *per area*: `▓▓` is the same shade as `▓` covering the same ground, and
 * drawing it once leaves the other half of the tile empty. Treating fills as
 * specks turned every roof into a chequerboard and rendered water and forest
 * canopy at half the density they were composed at.
 */

/**
 * The line to continue eastward, per box-drawing glyph.
 *
 * Only glyphs with an east arm appear here; `┃ ┓ ┛` and friends have nothing to
 * continue and fall through to rule 3. Each autotile family keeps its own weight,
 * so a fence continues light and a bridge continues double.
 */
const CONTINUATION: Readonly<Record<string, string>> = {
	// Heavy box: stone and timber walls.
	"╺": "━",
	"┗": "━",
	"┏": "━",
	"┣": "━",
	"━": "━",
	"┻": "━",
	"┳": "━",
	"╋": "━",
	// Light box: fences and rails.
	"╶": "─",
	"└": "─",
	"┌": "─",
	"├": "─",
	"─": "─",
	"┴": "─",
	"┬": "─",
	"┼": "─",
	// Double box: bridges and formal stonework.
	"╞": "═",
	"╚": "═",
	"╔": "═",
	"╠": "═",
	"═": "═",
	"╩": "═",
	"╦": "═",
	"╬": "═",
};

/**
 * Glyphs that shade an area rather than mark a spot.
 *
 * These repeat across the whole tile. They are mostly autotile output — the
 * mass-edge and water-edge tables — plus the roof and bush fills, and what they
 * all have in common is that the glyph *is* the ground: half a tile of `▓` and
 * half a tile of nothing is not a lighter shade, it is a hole.
 */
const FILL: ReadonlySet<string> = new Set(["░", "▒", "▓", "█", "~", "≈"]);

/**
 * Glyphs that may be placed in either half of their tile.
 *
 * Only countable ground marks qualify. Everything structural — a door, a window,
 * a wall end-cap, a chest — is a shape at a known place, and shifting it half a
 * tile breaks whatever it was lining up with: dithering `┓` opens a gap between
 * the corner and the wall arriving from the west.
 */
const SPECK: ReadonlySet<string> = new Set([
	// Grass, gravel, sand, flowers, crops, reeds.
	",",
	".",
	"'",
	":",
	"·",
	"*",
	'"',
	"!",
	"|",
	"=",
	"-",
	"≡",
	// Scenery that appears in quantity and reads as texture at distance.
	"▲",
	"●",
	"†",
	"o",
]);

/**
 * Which half of a widened tile holds its single glyph.
 *
 * Always choosing the left half lines every speck of grass up into vertical
 * pinstripes — an artifact the 1x view does not have, and the most obvious tell
 * that a scene has been stretched. Alternating by position breaks the columns up
 * and reads as scatter again.
 *
 * The arguments must be **world** coordinates, not viewport indices. Keying this
 * on the index within the row is the same arithmetic and looks correct in a still
 * frame, but every tile's index shifts by one when the camera moves a step, so
 * each speck flips to the other half of its tile on every footfall and the whole
 * ground appears to shimmer. Tying it to world position instead means a tile's
 * texture is fixed for as long as it exists.
 */
function slotFor(worldX: number, worldY: number, scale: number): number {
	return (((worldX + worldY) % scale) + scale) % scale;
}

/**
 * Widen one row by `scale`.
 *
 * `worldX` is the world coordinate of the first cell and `worldY` the world row,
 * so texture placement is stable under camera movement. `worldY` also
 * participates in the choice, so the offset alternates between adjacent rows
 * rather than producing diagonal banding.
 */
export function expandRow(cells: readonly Cell[], scale: number, worldX = 0, worldY = 0): Cell[] {
	if (scale <= 1) return [...cells];

	const out: Cell[] = new Array(cells.length * scale);
	let i = 0;

	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col] as Cell;
		const line = cell.entity ? undefined : CONTINUATION[cell.ch];

		if (line !== undefined) {
			// Rule 1: carry the wall east through the rest of the tile.
			out[i++] = cell;
			for (let n = 1; n < scale; n++) out[i++] = { ...cell, ch: line };
			continue;
		}

		if (!cell.entity && FILL.has(cell.ch)) {
			// Rule 2: a shade covers its whole tile. Repeating is what preserves the
			// density here, rather than what destroys it.
			for (let n = 0; n < scale; n++) out[i++] = cell;
			continue;
		}

		// Rules 3 and 4. Only a speck is free to move within its tile; a person
		// that drifted between halves would appear to wobble as they walk.
		const dither = !cell.entity && SPECK.has(cell.ch);
		const slot = dither ? slotFor(worldX + col, worldY, scale) : 0;
		for (let n = 0; n < scale; n++) {
			// The style is identical across the pair either way, so the run-length
			// encoder still emits one escape sequence for the whole tile. The
			// background in particular must carry: a road or a shadow belongs to the
			// ground, and stopping it halfway through a tile would undo the geometry
			// this widening exists to fix.
			out[i++] = n === slot ? cell : { ...cell, ch: " " };
		}
	}

	return out;
}

/**
 * Widen a whole scene, anchored at the world position of its top-left cell.
 *
 * The origin is required in practice: default it and texture placement keys off
 * viewport indices again, which shimmers as the camera moves.
 */
export function expandScene(
	rows: readonly (readonly Cell[])[],
	scale: number,
	origin: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
): Cell[][] {
	if (scale <= 1) return rows.map((row) => [...row]);
	return rows.map((row, y) => expandRow(row, scale, origin.x, origin.y + y));
}
