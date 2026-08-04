/**
 * Pack a composed scene into quadrant block elements, two pixels per cell edge.
 *
 * A terminal cell is about twice as tall as it is wide, so splitting it into a
 * 2x2 grid of quadrants gives four square pixels. Every one of the sixteen
 * patterns exists as a single code point in U+2580..U+259F (Block Elements),
 * which `glyph-safety.ts` already allowlists — so this buys 4x the resolution
 * with *no* new font requirement. That is the whole reason to prefer quadrants
 * over sextants or the Unicode 16 octants, which need fonts a player may not
 * have.
 *
 * The constraint is that a cell carries only two colours, one for the set
 * quadrants and one for the clear ones. Ordinarily that forces a quantisation
 * pass and loses colour. Here it costs nothing: a tile is `TILE_PX` square and
 * a cell is two pixels square, so a cell never straddles a tile boundary, and a
 * tile is two-coloured by construction because `sprite.ts` paints a bitmask
 * with the `Cell`'s own fg and bg. **This encoder is lossless.**
 *
 * `scale.ts` is not used in this path and is not needed: splitting the cell
 * vertically already makes pixels square, so the 2:1 correction — and all of
 * its CONTINUATION / FILL / SPECK heuristics — has nothing left to correct.
 */
import {
	bgSequence,
	type ColorDepth,
	fgSequence,
	type RGB,
	SGR_RESET,
	sameColor,
} from "./color.js";
import type { Cell } from "./compose.js";
import { inkAt, paintFor, TILE_PX } from "./sprite.js";

/**
 * The sixteen quadrant patterns, indexed by `TL|TR<<1|BL<<2|BR<<3`.
 *
 * Index 0 is a space and index 15 a full block, which matters for the encoder:
 * those two are the cases where only one of the two colours is needed at all.
 */
export const QUADRANTS: readonly string[] = [
	" ",
	"▘", // ▘ TL
	"▝", // ▝ TR
	"▀", // ▀ TL TR
	"▖", // ▖ BL
	"▌", // ▌ TL BL
	"▞", // ▞ TR BL
	"▛", // ▛ TL TR BL
	"▗", // ▗ BR
	"▚", // ▚ TL BR
	"▐", // ▐ TR BR
	"▜", // ▜ TL TR BR
	"▄", // ▄ BL BR
	"▙", // ▙ TL BL BR
	"▟", // ▟ TR BL BR
	"█", // █ all
];

const FULL = 15;

/** One terminal cell: four pixels, drawn in at most two colours. */
export interface QuadCell {
	/** Which of the four quadrants take `fg`. */
	readonly bits: number;
	readonly fg: RGB;
	readonly bg: RGB;
}

export interface QuadOptions {
	/**
	 * Let the encoder redraw a cell in inverse video when that avoids an SGR.
	 * On by default; the preview tool turns it off to measure what it saves.
	 */
	readonly polarity?: boolean;
}

/**
 * Rasterise a composed scene into quadrant cells.
 *
 * `rows` are in **tile** space, straight out of `composeScene` with no
 * horizontal expansion. A W x H tile scene becomes a `2W x 2H` cell grid, so
 * the map shows the same number of tiles across as the 2x glyph renderer but
 * half as many down.
 *
 * Note there is no world origin here, and none is needed. `expandScene` takes
 * one because it scatters specks by absolute position, and keying that to a
 * viewport index instead makes the entire ground shimmer on every footfall —
 * the bug its comment is mostly about. A sprite is addressed by its offset
 * *within* a tile, so a tile draws identically wherever the camera is, by
 * construction. Pixel mode does not have that class of bug to avoid.
 */
export function quadrantScene(rows: readonly (readonly Cell[])[]): QuadCell[][] {
	const half = TILE_PX / 2;
	const out: QuadCell[][] = [];

	for (let ty = 0; ty < rows.length; ty++) {
		const tiles = rows[ty] as readonly Cell[];
		// Each tile row produces `TILE_PX / 2` cell rows.
		for (let sy = 0; sy < half; sy++) {
			const line: QuadCell[] = new Array(tiles.length * half);
			let i = 0;

			for (let tx = 0; tx < tiles.length; tx++) {
				const cell = tiles[tx] as Cell;
				const paint = paintFor(cell.ch, cell.fg, cell.bg, cell.entity);

				for (let sx = 0; sx < half; sx++) {
					// Offsets within the tile; `inkAt` masks to the tile anyway.
					const x = sx * 2;
					const y = sy * 2;
					const bits =
						(inkAt(paint.mask, x, y) ? 1 : 0) |
						(inkAt(paint.mask, x + 1, y) ? 2 : 0) |
						(inkAt(paint.mask, x, y + 1) ? 4 : 0) |
						(inkAt(paint.mask, x + 1, y + 1) ? 8 : 0);
					line[i++] = { bits, fg: paint.fg, bg: paint.bg };
				}
			}

			out.push(line);
		}
	}

	return out;
}

/**
 * How many SGR sequences a given (fg, bg) pair would cost against the running
 * style. `null` means "not currently known", which always costs.
 */
function cost(curFg: RGB | null, curBg: RGB | null, fg: RGB | null, bg: RGB | null): number {
	let n = 0;
	if (fg !== null && !sameColor(curFg, fg)) n++;
	if (bg !== null && !sameColor(curBg, bg)) n++;
	return n;
}

/**
 * Encode one row of quadrant cells.
 *
 * Three things keep this near the byte cost of the glyph renderer despite
 * carrying four times the pixels:
 *
 *  1. **Polarity.** Every pattern has two encodings — the glyph on (fg, bg), or
 *     its complement on (bg, fg). `▘` on moss-over-loam and `▟` on
 *     loam-over-moss are the same four pixels. So the encoder is free to pick
 *     whichever orientation already matches the colours it is carrying.
 *     Measured over four chunks this saves between 0% and 7% — real, but far
 *     less than it looks like it should, because (3) has usually already
 *     collapsed the run and there is no style change left to avoid. It earns
 *     its keep on built-up ground, where tiles alternate, and nothing in open
 *     country.
 *  2. **Uniform cells.** An all-clear cell is a space and needs no foreground;
 *     an all-set cell can be drawn as a full block needing no background, *or*
 *     as a space with the background set to the ink colour. Either way one of
 *     the two registers is left alone, so a run of solid water or roof costs
 *     almost nothing.
 *  3. **Run-length**, as in `ansi.ts`: an SGR is emitted only on an actual
 *     change. Sprites are two-coloured per tile, so both cells of a tile share
 *     a style and adjacent tiles of the same terrain and light level do too.
 */
export function encodeQuadrantRow(
	cells: readonly QuadCell[],
	depth: ColorDepth,
	options: QuadOptions = {},
): string {
	if (depth === "none") {
		return cells.map((c) => QUADRANTS[c.bits] ?? " ").join("");
	}
	const polarity = options.polarity ?? true;

	let out = "";
	let curFg: RGB | null = null;
	let curBg: RGB | null = null;

	for (const cell of cells) {
		// What to draw, and which registers actually have to be right for it.
		let ch: string;
		let needFg: RGB | null;
		let needBg: RGB | null;

		if (cell.bits === 0) {
			// Only the background shows.
			ch = " ";
			needFg = null;
			needBg = cell.bg;
		} else if (cell.bits === FULL) {
			// Only the ink shows, and there are two ways to say so. Prefer whichever
			// register already holds the colour.
			if (sameColor(curBg, cell.fg)) {
				ch = " ";
				needFg = null;
				needBg = cell.fg;
			} else {
				ch = "█";
				needFg = cell.fg;
				needBg = null;
			}
		} else {
			const direct = cost(curFg, curBg, cell.fg, cell.bg);
			const inverse = polarity ? cost(curFg, curBg, cell.bg, cell.fg) : Number.POSITIVE_INFINITY;
			if (inverse < direct) {
				ch = QUADRANTS[FULL - cell.bits] as string;
				needFg = cell.bg;
				needBg = cell.fg;
			} else {
				ch = QUADRANTS[cell.bits] as string;
				needFg = cell.fg;
				needBg = cell.bg;
			}
		}

		if (needFg !== null && !sameColor(curFg, needFg)) {
			out += fgSequence(needFg, depth);
			curFg = needFg;
		}
		if (needBg !== null && !sameColor(curBg, needBg)) {
			out += bgSequence(needBg, depth);
			curBg = needBg;
		}
		out += ch;
	}

	// Always reset, for the same reason `encodeRow` does: a trailing background
	// would otherwise bleed into whatever Ink draws beside the viewport.
	return out.length > 0 ? `${out}${SGR_RESET}` : "";
}

export function encodeQuadrantScene(
	rows: readonly (readonly QuadCell[])[],
	depth: ColorDepth,
	options: QuadOptions = {},
): string[] {
	return rows.map((row) => encodeQuadrantRow(row, depth, options));
}

/**
 * How many tiles fit in `columns` terminal columns.
 *
 * The counterpart of `tilesAcross` in `scale.ts`. Rounds down and never returns
 * zero: one column too many makes Ink wrap every row, which doubles the
 * rendered height and reads as flicker.
 */
export function tilesAcrossQuadrant(columns: number): number {
	return Math.max(1, Math.floor(columns / (TILE_PX / 2)));
}

/** How many tiles fit in `rows` terminal rows. Pixel mode costs vertical field of view. */
export function tilesDownQuadrant(rows: number): number {
	return Math.max(1, Math.floor(rows / (TILE_PX / 2)));
}
