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
import { paintFor, type Shape, type SpriteTheme, TILE_PX, type TilePaint } from "./sprite.js";

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
	/** A tile pack's sprite overrides, if this world has one. */
	readonly sprites?: SpriteTheme;
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
	// `allocUnsafe` because every byte is written below. At three or four
	// megapixels the zeroing `alloc` does is a measurable fraction of the frame.
	const rgb = Buffer.allocUnsafe(width * height * 3);
	const stride = width * 3;
	const tileStride = size * 3;

	for (let ty = 0; ty < tilesH; ty++) {
		const tiles = rows[ty] as readonly Cell[];
		const top = ty * size;
		for (let tx = 0; tx < tilesW; tx++) {
			const tile = tileBitmap(paintFor(tiles[tx] as Cell, options.sprites), size);
			let at = (top * width + tx * size) * 3;
			// Row at a time. `set` on a subarray is a memcpy, where the loop this
			// replaced evaluated a shape closure once per pixel.
			for (let py = 0; py < size; py++) {
				rgb.set(tile.subarray(py * tileStride, py * tileStride + tileStride), at);
				at += stride;
			}
		}
	}

	return { rgb, width, height, tilePx: size };
}

/**
 * One tile, drawn once and kept.
 *
 * A frame is three or four million pixels and the old loop called a shape
 * function for every one of them. It did not need to: a whole frame of open
 * country uses about forty distinct combinations of shape and two colours —
 * measured, not assumed — so almost every tile is a copy of one already drawn.
 *
 * Keyed on the two colours as well as the shape because lighting, tint, relief
 * and contact shadows are already folded into them by the time the compositor is
 * done. That is what keeps this correct: two tiles share a bitmap only when they
 * would have been drawn identically anyway.
 */
const bitmaps = new Map<string, Buffer>();
const shapeIds = new WeakMap<object, number>();
let nextShapeId = 0;

/**
 * Enough that a frame never evicts its own tiles, small enough that a day's
 * worth of light levels cannot grow this without bound. Cleared wholesale
 * rather than evicted one at a time: the working set turns over completely when
 * the light changes, so picking victims would be work spent to no end.
 */
const BITMAP_LIMIT = 4096;

function shapeKey(shape: Shape): number {
	let id = shapeIds.get(shape);
	if (id === undefined) {
		id = nextShapeId++;
		shapeIds.set(shape, id);
	}
	return id;
}

function tileBitmap(paint: TilePaint, size: number): Buffer {
	const { fg, bg } = paint;
	const key = paint.bitmap
		? `a${atlasKey(paint.bitmap.rgba)}:${size}:${mulKey(paint.mul)}:${bg[0]},${bg[1]},${bg[2]}`
		: `${shapeKey(paint.shape)}:${size}:${fg[0]},${fg[1]},${fg[2]}:${bg[0]},${bg[1]},${bg[2]}`;
	const found = bitmaps.get(key);
	if (found) return found;

	const tile = paint.bitmap ? blitAtlas(paint, size) : drawShape(paint, size);

	if (bitmaps.size >= BITMAP_LIMIT) bitmaps.clear();
	bitmaps.set(key, tile);
	return tile;
}

function drawShape(paint: TilePaint, size: number): Buffer {
	const { fg, bg } = paint;
	const tile = Buffer.allocUnsafe(size * size * 3);
	let at = 0;
	for (let py = 0; py < size; py++) {
		const v = (py + 0.5) / size;
		for (let px = 0; px < size; px++) {
			const c: RGB = paint.shape((px + 0.5) / size, v) ? fg : bg;
			tile[at++] = c[0] as number;
			tile[at++] = c[1] as number;
			tile[at++] = c[2] as number;
		}
	}
	return tile;
}

/**
 * Draw a full-colour tile from a pack's atlas.
 *
 * Two things that a shape sprite gets for free have to be done by hand here, because
 * an atlas tile carries its own colour rather than inheriting the cell's two:
 *
 * - **Lighting.** `cell.mul` is everything the compositor multiplied the cell's
 *   colours by — day/night tint, field of view, contact shadows, slope relief — and
 *   the same factors are applied to these pixels. Without it a bitmap tile would
 *   blaze at noon brightness in the middle of the night.
 * - **Alpha.** Composited over the cell background, which is what lets a decor tile
 *   be a chest with the road showing round it rather than a chest on a black square.
 *
 * Nearest-sampled when the atlas was drawn at a different size from the one being
 * rendered. Scaling art is the pack author's problem to avoid; guessing at it with a
 * filter would blur pixel art, which is worse than the blocks.
 */
function blitAtlas(paint: TilePaint, size: number): Buffer {
	const source = paint.bitmap as NonNullable<TilePaint["bitmap"]>;
	const [mr, mg, mb] = paint.mul ?? [1, 1, 1];
	const bg = paint.bg;
	const tile = Buffer.allocUnsafe(size * size * 3);

	let at = 0;
	for (let py = 0; py < size; py++) {
		const sy = source.size === size ? py : Math.min(source.size - 1, (py * source.size) / size) | 0;
		for (let px = 0; px < size; px++) {
			const sx =
				source.size === size ? px : Math.min(source.size - 1, (px * source.size) / size) | 0;
			const from = (sy * source.size + sx) * 4;
			const alpha = (source.rgba[from + 3] as number) / 255;
			for (let c = 0; c < 3; c++) {
				const lit = (source.rgba[from + c] as number) * (c === 0 ? mr : c === 1 ? mg : mb);
				const over = lit * alpha + (bg[c] as number) * (1 - alpha);
				tile[at++] = over < 0 ? 0 : over > 255 ? 255 : over | 0;
			}
		}
	}
	return tile;
}

/** Atlas tiles are shared objects, so identity keys them the way a shape is keyed. */
const atlasIds = new WeakMap<Uint8Array, number>();
let nextAtlasId = 0;

function atlasKey(rgba: Uint8Array): number {
	let id = atlasIds.get(rgba);
	if (id === undefined) {
		id = nextAtlasId++;
		atlasIds.set(rgba, id);
	}
	return id;
}

/**
 * The multiplier, quantised into the cache key.
 *
 * Lighting is continuous, so keying on the exact triple would give almost every tile
 * its own entry and turn the cache into a memory leak with extra steps. Two hundred
 * and fifty six steps is finer than the eight bits the output has anyway.
 */
function mulKey(mul: TilePaint["mul"]): string {
	if (!mul) return "1";
	return `${(mul[0] * 255) | 0},${(mul[1] * 255) | 0},${(mul[2] * 255) | 0}`;
}

/** Test seam, and what the tools call between measurements. */
export function clearTileCache(): void {
	bitmaps.clear();
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
