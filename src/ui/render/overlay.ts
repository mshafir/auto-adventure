/**
 * Drawing on top of a composed scene.
 *
 * Anything that has to appear over the map is painted *into* the frame rather
 * than laid out beside it. Ink slices a row of kitty placeholders in half the
 * moment anything shares the screen line with it (`ink-astral.test.tsx`), so a
 * floating box is not an option in pixel mode — and doing it the same way in
 * both modes means one placement to reason about instead of two.
 */
import { mix, type RGB } from "./color.js";
import type { Cell } from "./compose.js";
import type { MiniCell } from "./minimap-data.js";
import type { Frame } from "./raster.js";
import { TILE_WIDTH } from "./scale.js";
import { spriteFor } from "./sprite.js";
import { swatch } from "./swatch.js";

export type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

/**
 * The overlay's own chrome, declarative for the same reason the minimap's
 * alphabet is: it should be able to move into a theme pack unchanged.
 *
 * Box Drawing throughout, which `glyph-safety.ts` vouches for as single-width
 * everywhere — a double-width glyph in a map row shifts every cell after it
 * relative to the rows above and below.
 */
const CHROME = {
	corners: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯" },
	horizontal: "─",
	vertical: "│",
	// Light rather than dim. The minimap is drawn over whatever the map happens to
	// be, and a dark frame vanishes against grey highland or a roof.
	border: "stone",
	background: "ash",
} as const;

export interface MinimapOverlayOptions {
	readonly corner?: Corner;
	/** Cells between the box and the edge of the map. */
	readonly margin?: number;
}

/**
 * Paint the minimap into a composed scene.
 *
 * Takes **cell** space, so in glyph mode this runs after `expandScene` — but it
 * does its own widening rather than being handed already-widened input, because
 * a chunk is not a tile and the two do not double the same way. Each chunk gets
 * `TILE_WIDTH` columns for the same reason a tile does: a terminal cell is about
 * twice as tall as it is wide, and one column per chunk draws a journey twenty
 * chunks east as if it were only ten.
 *
 * Returns the scene unchanged when the box will not fit. A minimap clipped
 * against the edge of the map reads as a rendering fault, and on a short
 * terminal the map itself is the thing worth the space.
 */
export function overlayMinimap(
	scene: readonly (readonly Cell[])[],
	mini: readonly (readonly MiniCell[])[],
	options: MinimapOverlayOptions = {},
): Cell[][] {
	const rows = scene.map((row) => [...row]);
	const corner = options.corner ?? "bottomRight";
	const margin = options.margin ?? 1;

	const innerH = mini.length;
	const chunksW = mini[0]?.length ?? 0;
	const innerW = chunksW * TILE_WIDTH;
	if (innerW === 0 || innerH === 0) return rows;

	const boxW = innerW + 2;
	const boxH = innerH + 2;
	const sceneH = rows.length;
	const sceneW = rows[0]?.length ?? 0;
	if (boxW + margin * 2 > sceneW || boxH + margin * 2 > sceneH) return rows;

	const x0 = corner === "topRight" || corner === "bottomRight" ? sceneW - margin - boxW : margin;
	const y0 = corner === "bottomLeft" || corner === "bottomRight" ? sceneH - margin - boxH : margin;

	const border = swatch(CHROME.border);
	const bg = swatch(CHROME.background);
	const chrome = (ch: string): Cell => ({ ch, fg: border, bg, bold: false, dim: false });

	const put = (x: number, y: number, cell: Cell) => {
		const row = rows[y];
		if (row) row[x] = cell;
	};

	for (let x = 1; x < boxW - 1; x++) {
		put(x0 + x, y0, chrome(CHROME.horizontal));
		put(x0 + x, y0 + boxH - 1, chrome(CHROME.horizontal));
	}
	for (let y = 1; y < boxH - 1; y++) {
		put(x0, y0 + y, chrome(CHROME.vertical));
		put(x0 + boxW - 1, y0 + y, chrome(CHROME.vertical));
	}
	put(x0, y0, chrome(CHROME.corners.topLeft));
	put(x0 + boxW - 1, y0, chrome(CHROME.corners.topRight));
	put(x0, y0 + boxH - 1, chrome(CHROME.corners.bottomLeft));
	put(x0 + boxW - 1, y0 + boxH - 1, chrome(CHROME.corners.bottomRight));

	for (let y = 0; y < innerH; y++) {
		const line = mini[y] as readonly MiniCell[];
		for (let x = 0; x < chunksW; x++) {
			const cell = line[x] as MiniCell;
			const style = { fg: cell.fg, bg, bold: cell.bold, dim: false };
			for (let n = 0; n < TILE_WIDTH; n++) {
				// A shade covers the whole chunk, so repeating it is what preserves its
				// density. A mark is one thing in that chunk, so repeating it would say
				// there were two — it takes the first column and the rest go blank.
				// Always the first, rather than scattered the way `scale.ts` scatters
				// ground texture: the minimap is mostly shade, so there are no
				// pinstripes to break up, and a mark that moved within its chunk as the
				// player walked would read as the town having moved.
				const ch = cell.fill || n === 0 ? cell.ch : " ";
				put(x0 + 1 + x * TILE_WIDTH + n, y0 + 1 + y, { ch, ...style });
			}
		}
	}

	return rows;
}

// --- the pixel path ---------------------------------------------------------

export interface PixelMinimapOptions {
	readonly corner?: Corner;
	/** Pixels between the box and the edge of the image. */
	readonly margin?: number;
	/** Pixels per chunk. Pass the cell size so both renderers agree on how big. */
	readonly chunk: { readonly width: number; readonly height: number };
}

/** Pixels of border, matching the one cell the glyph path spends on it. */
const PIXEL_BORDER = 2;

/**
 * How much of its own colour a chunk keeps when it also has a mark to draw.
 *
 * A shaded chunk is its colour. One with a mark is a dimmer wash of the same
 * colour, so the mark drawn over it in the full value stands off it — the
 * contrast is what makes a town findable at a glance.
 */
const WASH = 0.45;

/**
 * Paint the minimap into a raster frame.
 *
 * The counterpart of {@link overlayMinimap}, from the same data, and the reason
 * it is data at all. Rather than drawing the glyph a character grid would have
 * to settle for, a chunk here is a solid block of its own colour — biome by
 * colour alone is far clearer at this size than a `░` ever was — with the
 * settlements, errands and the player drawn over it as sprites.
 *
 * Mutates the frame. It is freshly allocated by `rasterScene` on every frame and
 * is a megabyte or two, so copying it to stay pure would cost more than the
 * whole rest of the overlay.
 */
export function paintMinimap(
	frame: Frame,
	mini: readonly (readonly MiniCell[])[],
	options: PixelMinimapOptions,
): void {
	const corner = options.corner ?? "bottomRight";
	const margin = options.margin ?? options.chunk.height;
	const { chunk } = options;

	const chunksH = mini.length;
	const chunksW = mini[0]?.length ?? 0;
	if (chunksW === 0 || chunksH === 0 || chunk.width < 1 || chunk.height < 1) return;

	const boxW = chunksW * chunk.width + PIXEL_BORDER * 2;
	const boxH = chunksH * chunk.height + PIXEL_BORDER * 2;
	if (boxW + margin * 2 > frame.width || boxH + margin * 2 > frame.height) return;

	const x0 =
		corner === "topRight" || corner === "bottomRight" ? frame.width - margin - boxW : margin;
	const y0 =
		corner === "bottomLeft" || corner === "bottomRight" ? frame.height - margin - boxH : margin;

	const border = swatch(CHROME.border);
	const bg = swatch(CHROME.background);

	// The border is drawn as a filled rectangle with the body laid over it, which
	// is both fewer fills than four strips and impossible to leave a corner out of.
	fill(frame, x0, y0, boxW, boxH, border);
	fill(
		frame,
		x0 + PIXEL_BORDER,
		y0 + PIXEL_BORDER,
		boxW - PIXEL_BORDER * 2,
		boxH - PIXEL_BORDER * 2,
		bg,
	);

	for (let cy = 0; cy < chunksH; cy++) {
		const line = mini[cy] as readonly MiniCell[];
		for (let cx = 0; cx < chunksW; cx++) {
			const cell = line[cx] as MiniCell;
			const left = x0 + PIXEL_BORDER + cx * chunk.width;
			const top = y0 + PIXEL_BORDER + cy * chunk.height;

			if (cell.fill) {
				fill(frame, left, top, chunk.width, chunk.height, cell.fg);
				continue;
			}

			fill(frame, left, top, chunk.width, chunk.height, mix(bg, cell.fg, WASH));
			const shape = spriteFor(cell.ch);
			if (shape.kind !== "shape") continue;
			// Sampled against the chunk's own box rather than a square one: a chunk is
			// as wide as it needs to be to undo the terminal's 2:1 cell, and sampling
			// a circle against a square would draw it as an ellipse.
			for (let py = 0; py < chunk.height; py++) {
				for (let px = 0; px < chunk.width; px++) {
					if (!inkOfBox(shape.shape, px, py, chunk.width, chunk.height)) continue;
					pixel(frame, left + px, top + py, cell.fg);
				}
			}
		}
	}
}

/** `sprite.ts`'s `inkAt`, for a box that is not square. */
function inkOfBox(
	shape: (u: number, v: number) => boolean,
	px: number,
	py: number,
	width: number,
	height: number,
): boolean {
	return shape((px + 0.5) / width, (py + 0.5) / height);
}

function pixel(frame: Frame, x: number, y: number, color: RGB): void {
	if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
	const at = (y * frame.width + x) * 3;
	frame.rgb[at] = color[0];
	frame.rgb[at + 1] = color[1];
	frame.rgb[at + 2] = color[2];
}

function fill(
	frame: Frame,
	x0: number,
	y0: number,
	width: number,
	height: number,
	color: RGB,
): void {
	for (let y = y0; y < y0 + height; y++) {
		for (let x = x0; x < x0 + width; x++) pixel(frame, x, y, color);
	}
}

/** As large as the minimap is allowed to get, in chunks. */
const MAX_EXTENT = { width: 13, height: 11 };
/** Below this it shows too little world to be worth the map it covers. */
const MIN_EXTENT = { width: 5, height: 5 };

/** Two cells of border and the one cell of margin holding it off the edge. */
const BOX_CHROME = 3;

/**
 * How many chunks of minimap a map of this size can carry.
 *
 * A third of the map's width and a third of its height, chrome included, which
 * keeps it legible on a wide terminal without letting it eat the map on a small
 * one. Returns undefined when there is no room worth taking — the caller then
 * draws no minimap at all rather than a two-chunk one.
 *
 * The thirds are of the rectangle the *map* got, not the terminal, so a tall
 * dialogue panel shrinks the minimap with it rather than crowding it out.
 *
 * In chunks, not cells, and measured from the terminal rectangle for both
 * renderers: each covers the same fraction of the same screen, so the minimap
 * shows the same amount of world whichever one is drawing it.
 */
export function minimapExtent(
	columns: number,
	rows: number,
): { width: number; height: number } | undefined {
	const width = Math.min(
		MAX_EXTENT.width,
		Math.floor((Math.floor(columns / 3) - BOX_CHROME) / TILE_WIDTH),
	);
	const height = Math.min(MAX_EXTENT.height, Math.floor(rows / 3) - BOX_CHROME);
	if (width < MIN_EXTENT.width || height < MIN_EXTENT.height) return undefined;
	return { width, height };
}
