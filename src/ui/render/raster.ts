/**
 * Turn a composed scene into a buffer of pixels.
 *
 * This is the whole of the pixel path's drawing: `composeScene` has already
 * decided what every tile is and what colour it is under the current light, and
 * `sprite.ts` knows what shape it is, so all that is left is to fill in the
 * pixels. Everything atmospheric — day/night tint, field of view, contact
 * shadows, slope relief — arrives already folded into each cell's two colours
 * and needs no code here at all.
 *
 * Output is packed RGB, three bytes per pixel, row-major: the layout the kitty
 * protocol takes with `f=24`, and the layout a PNG encoder wants, so neither
 * has to copy it again.
 */
import type { RGB } from "./color.js";
import type { Cell } from "./compose.js";
import { paintFor, TILE_PX } from "./sprite.js";

export interface Frame {
	readonly rgb: Buffer;
	readonly width: number;
	readonly height: number;
	/** Pixels per tile edge, so callers can map back to tiles. */
	readonly tilePx: number;
}

export interface RasterOptions {
	/** Pixels per tile edge. Defaults to {@link TILE_PX}. */
	readonly tilePx?: number;
}

/**
 * Rasterise a tile grid.
 *
 * `rows` is in **tile** space, straight out of `composeScene` with no
 * horizontal expansion — `scale.ts` exists to correct a terminal cell's 2:1
 * aspect, and a pixel grid has no such problem to correct.
 *
 * Note there is no world origin. `expandScene` needs one because it scatters
 * specks by absolute position, and keying that to a viewport index makes the
 * whole ground shimmer on every footfall. A sprite is drawn in its own unit
 * square, so a tile looks the same wherever the camera is, by construction.
 */
export function rasterScene(
	rows: readonly (readonly Cell[])[],
	options: RasterOptions = {},
): Frame {
	const size = options.tilePx ?? TILE_PX;
	const tilesH = rows.length;
	const tilesW = rows[0]?.length ?? 0;
	const width = tilesW * size;
	const height = tilesH * size;
	const rgb = Buffer.alloc(width * height * 3);

	for (let ty = 0; ty < tilesH; ty++) {
		const tiles = rows[ty] as readonly Cell[];
		for (let tx = 0; tx < tilesW; tx++) {
			const cell = tiles[tx] as Cell;
			const paint = paintFor(cell);
			const x0 = tx * size;
			const y0 = ty * size;

			for (let py = 0; py < size; py++) {
				// Row base, computed once rather than per pixel: this is the innermost
				// loop of the renderer and runs a few hundred thousand times a frame.
				let at = ((y0 + py) * width + x0) * 3;
				const v = (py + 0.5) / size;
				for (let px = 0; px < size; px++) {
					const c: RGB = paint.shape((px + 0.5) / size, v) ? paint.fg : paint.bg;
					rgb[at++] = c[0] as number;
					rgb[at++] = c[1] as number;
					rgb[at++] = c[2] as number;
				}
			}
		}
	}

	return { rgb, width, height, tilePx: size };
}

/**
 * How many tiles fit in a terminal rectangle, given a cell's pixel size.
 *
 * The pixel renderer is not bound to the character grid the way the glyph one
 * is: a tile takes whatever fraction of a cell its pixel size implies. With a
 * typical 8x16 cell and 16-pixel tiles that is two columns and one row per
 * tile — the same field of view the 2x glyph renderer shows today, at sixteen
 * times the detail. That is the case for this whole path over quadrants, which
 * bought detail by halving the view.
 */
export function tileFit(
	columns: number,
	rows: number,
	cell: { readonly width: number; readonly height: number },
	tilePx = TILE_PX,
): { width: number; height: number } {
	const across = Math.floor((columns * cell.width) / tilePx);
	const down = Math.floor((rows * cell.height) / tilePx);
	return { width: Math.max(1, across), height: Math.max(1, down) };
}
