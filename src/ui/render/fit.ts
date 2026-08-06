/**
 * How much of the window the map takes, and how much world that is.
 *
 * The old rule was one line — fill the window, and see whatever that comes to —
 * and it made the game *worse* the larger the terminal got. Measured across four
 * window sizes on a 19x42 cell, with tiles wanting 38 pixels each:
 *
 * ```
 * 100x30 cells -> camera  50x26 tiles, tile drawn 38px (full)
 * 163x37 cells -> camera  81x34 tiles, tile drawn 38px (full)
 * 200x64 cells -> camera 100x64 tiles, tile drawn 25px
 * 240x80 cells -> camera 120x70 tiles, tile drawn 21px   <- 55%, upscaled back
 * ```
 *
 * Two things go wrong at once, and they compound. The field of view grows, so the
 * world is *smaller* on a bigger screen — a person walking a road that filled a
 * third of a laptop window is a speck on a monitor. And the frame budget in
 * `mode.ts` holds the pixel count down by shrinking the tiles, so what is left is
 * drawn at half resolution and scaled back up: smaller *and* softer.
 *
 * So the map stops growing. Past the cap it draws the same amount of world at the
 * same tile size whatever the window is, and the cells it does not need are left
 * blank around it — which is the ordinary answer, and the one that keeps a frame's
 * cost fixed instead of quadratic in the window's area. Wanting the picture bigger
 * is what zoom is for, and zoom now has keys on it.
 */
import { MAX_PLACEHOLDER_INDEX } from "./kitty.js";
import type { CellSize, TileMode } from "./mode.js";
import { tilePixels } from "./mode.js";
import { TILE_WIDTH, tilesAcross } from "./scale.js";

/**
 * The most world the map will show, in tiles, at zoom 1.
 *
 * Chosen so that nothing changes for the windows people actually play in — a
 * 163-column terminal fits 81 tiles across today and this asks for 72 — while a
 * window twice that size stops at the same 72 rather than going to 120. The height
 * is the looser of the two on purpose: the map is a wide, short rectangle, so the
 * rows run out long before the columns do and a tight cap here would letterbox the
 * common case for no reason.
 *
 * `FOV=WxH` overrides it, for a player who would rather see more and smaller.
 */
const BASE_FOV = { width: 72, height: 32 };

function baseFov(env: NodeJS.ProcessEnv): { width: number; height: number } {
	const match = /^(\d+)x(\d+)$/.exec(env.FOV?.trim() ?? "");
	if (!match) return BASE_FOV;
	const width = Number(match[1]);
	const height = Number(match[2]);
	return width >= 8 && height >= 6 ? { width, height } : BASE_FOV;
}

export interface MapFit {
	/** The camera, in tiles. */
	readonly width: number;
	readonly height: number;
	/** Terminal cells the map actually draws into. */
	readonly columns: number;
	readonly rows: number;
	/** Blank cells to its left, so it sits in the middle of the window. */
	readonly indent: number;
	/** Pixels per tile, for the renderer that works in them. */
	readonly tilePx: number;
}

export interface FitOptions {
	readonly mode: TileMode;
	/** Cells the map *may* have. What it takes is the answer. */
	readonly columns: number;
	readonly rows: number;
	readonly cell: CellSize;
	/**
	 * Bigger tiles and less world, or the reverse.
	 *
	 * Only the pixel renderer can honour it: a glyph is whatever size the player's
	 * font is, so zooming there could only take world away without giving anything
	 * back for it. Ignored in that mode rather than half-applied.
	 */
	readonly zoom?: number;
	readonly env?: NodeJS.ProcessEnv;
}

export function mapFit(options: FitOptions): MapFit {
	const { mode, columns, rows, cell } = options;
	const env = options.env ?? process.env;
	const zoom = mode === "kitty" ? (options.zoom ?? 1) : 1;
	const base = baseFov(env);
	// Zooming in is showing less world, which is the same statement as drawing it
	// larger — the rectangle on screen does not change, only what is inside it.
	const cap = {
		width: Math.max(8, Math.round(base.width / zoom)),
		height: Math.max(6, Math.round(base.height / zoom)),
	};

	if (mode === "glyph") {
		const width = Math.min(tilesAcross(columns), cap.width);
		const height = Math.min(rows, cap.height);
		const used = width * TILE_WIDTH;
		return {
			width,
			height,
			columns: used,
			rows: height,
			indent: centred(columns, used),
			tilePx: TILE_WIDTH,
		};
	}

	const tilePx = tilePixels(env, cell, zoom);
	/*
	 * The ceiling belongs on *rows of cells*, not on tiles.
	 *
	 * Every placeholder row is anchored by a combining mark from a fixed table of 64,
	 * and running off the end of it throws rather than drawing a shorter map. A tile
	 * is usually shorter than a cell, so capping the tile count looks like the same
	 * thing — until a terminal with a short cell and a zoomed-in tile makes each tile
	 * three rows tall and thirty tiles need ninety marks.
	 */
	const roomRows = Math.min(rows, MAX_PLACEHOLDER_INDEX);
	const width = Math.min(Math.max(1, Math.floor((columns * cell.width) / tilePx)), cap.width);
	const height = Math.min(Math.max(1, Math.floor((roomRows * cell.height) / tilePx)), cap.height);
	/*
	 * The cells the image is placed into, sized from the image rather than from the
	 * window — and this is the load-bearing half of the cap.
	 *
	 * `c` and `r` tell the terminal what rectangle to scale the image into. Leave
	 * them at the window's size while the camera stops short of it and the terminal
	 * happily stretches 72 tiles across 120 tiles' worth of cells, which is the
	 * blurry upscale this exists to avoid, arrived at from the other direction.
	 */
	const usedColumns = Math.min(columns, Math.max(1, Math.round((width * tilePx) / cell.width)));
	const usedRows = Math.min(roomRows, Math.max(1, Math.round((height * tilePx) / cell.height)));

	return {
		width,
		height,
		columns: usedColumns,
		rows: usedRows,
		indent: centred(columns, usedColumns),
		tilePx,
	};
}

/** Half the slack, rounded down, so an odd remainder falls on the right. */
function centred(available: number, used: number): number {
	return Math.max(0, Math.floor((available - used) / 2));
}
