import { describe, expect, it } from "vitest";
import { mapFit } from "./fit.js";
import { MAX_PLACEHOLDER_INDEX } from "./kitty.js";
import { DEFAULT_FRAME_PIXELS, renderTilePixels } from "./mode.js";
import { TILE_WIDTH } from "./scale.js";

/** Ghostty's, on the machine all the numbers in these comments came from. */
const CELL = { width: 19, height: 42 };
const ENV = {};

function pixels(columns: number, rows: number, zoom?: number) {
	const fit = mapFit({
		mode: "kitty",
		columns,
		rows,
		cell: CELL,
		env: ENV,
		...(zoom === undefined ? {} : { zoom }),
	});
	const drawn = renderTilePixels(fit.width, fit.height, ENV, CELL, fit.tilePx);
	return { fit, drawn, megapixels: (fit.width * drawn * (fit.height * drawn)) / 1e6 };
}

describe("the map on a window that keeps growing", () => {
	it("stops showing more world past the cap", () => {
		/*
		 * The complaint this exists for. Filling the window meant a monitor showed 120
		 * tiles across where a laptop showed 50 — so a person walking a road was a
		 * speck on the larger screen, and the tile art nobody could make out was being
		 * paid for in full.
		 */
		const small = pixels(100, 24).fit;
		const large = pixels(240, 74).fit;
		expect(large.width).toBe(small.width < 72 ? 72 : small.width);
		expect(large.width).toBeLessThanOrEqual(72);
	});

	it("draws every tile at full size instead of shrinking them to fit a budget", () => {
		// The other half of the same complaint: past four megapixels the frame budget
		// used to shrink the tiles and let the terminal scale them back up, so a big
		// window was blurry as well as small.
		for (const [columns, rows] of [
			[100, 24],
			[163, 30],
			[200, 58],
			[240, 74],
		] as const) {
			const { fit, drawn } = pixels(columns, rows);
			expect(drawn, `${columns}x${rows}`).toBe(fit.tilePx);
		}
	});

	it("keeps a frame inside the pixel budget however large the window is", () => {
		// Eight megapixels of raw RGB, re-sent on every keypress, is what took the
		// terminal down. The cap is what stops the window deciding that number.
		for (const [columns, rows] of [
			[163, 30],
			[240, 74],
			[400, 100],
		] as const) {
			expect(pixels(columns, rows).megapixels * 1e6, `${columns}x${rows}`).toBeLessThanOrEqual(
				DEFAULT_FRAME_PIXELS,
			);
		}
	});

	it("hands back the cells it did not use, and centres in them", () => {
		const fit = pixels(240, 74).fit;
		expect(fit.columns).toBeLessThan(240);
		expect(fit.indent).toBe(Math.floor((240 - fit.columns) / 2));
	});

	it("takes the whole window when the window is small enough to want it all", () => {
		// Nothing changes for the terminal sizes people actually play in.
		const fit = pixels(100, 24).fit;
		expect(fit.indent).toBe(0);
		expect(fit.columns).toBe(100);
	});
});

describe("the placeholder table", () => {
	it("is never overrun, whatever the cell size and zoom", () => {
		/*
		 * Rows of *cells*, not tiles — and the difference is the bug. A tile is
		 * normally shorter than a cell, so capping tiles looks like capping rows until
		 * a terminal with a short cell and a zoomed-in tile makes one tile three rows
		 * tall.
		 */
		for (const cell of [
			{ width: 19, height: 42 },
			{ width: 8, height: 16 },
			{ width: 10, height: 12 },
		]) {
			for (const zoom of [0.5, 1, 2, 3]) {
				const fit = mapFit({ mode: "kitty", columns: 400, rows: 200, cell, env: ENV, zoom });
				expect(fit.rows, `${cell.width}x${cell.height} @${zoom}`).toBeLessThanOrEqual(
					MAX_PLACEHOLDER_INDEX,
				);
			}
		}
	});
});

describe("zoom", () => {
	it("trades world for size", () => {
		const one = pixels(163, 30, 1).fit;
		const two = pixels(163, 30, 2).fit;
		expect(two.tilePx).toBeGreaterThan(one.tilePx);
		expect(two.width).toBeLessThan(one.width);
	});

	it("shows more world when zoomed out", () => {
		const one = pixels(163, 30, 1).fit;
		const half = pixels(163, 30, 0.5).fit;
		expect(half.tilePx).toBeLessThan(one.tilePx);
		expect(half.width).toBeGreaterThan(one.width);
	});

	it("keeps the frame inside the budget at every step", () => {
		for (const zoom of [0.5, 0.75, 1, 1.25, 1.5, 2, 3]) {
			expect(pixels(240, 74, zoom).megapixels * 1e6, `zoom ${zoom}`).toBeLessThanOrEqual(
				DEFAULT_FRAME_PIXELS,
			);
		}
	});

	it("is ignored by the glyph renderer", () => {
		// A glyph is whatever size the player's font is, so zooming there could only
		// take world away without giving anything back for it.
		const one = mapFit({ mode: "glyph", columns: 120, rows: 30, cell: CELL, env: ENV, zoom: 1 });
		const two = mapFit({ mode: "glyph", columns: 120, rows: 30, cell: CELL, env: ENV, zoom: 2 });
		expect(two).toEqual(one);
	});
});

describe("the glyph renderer", () => {
	it("never claims more columns than whole tiles fit in", () => {
		// Overflow is the dangerous direction: one column too many makes Ink wrap
		// every row, which doubles the rendered height and reads as flicker.
		for (const columns of [20, 21, 79, 80, 120, 121, 400]) {
			const fit = mapFit({ mode: "glyph", columns, rows: 30, cell: CELL, env: ENV });
			expect(fit.columns).toBe(fit.width * TILE_WIDTH);
			expect(fit.indent + fit.columns).toBeLessThanOrEqual(columns);
		}
	});

	it("keeps filling the window, however large it gets", () => {
		/*
		 * The cap is a pixel-mode idea and does not belong here. Everything it is for
		 * — the megapixels a frame costs, the budget that shrinks tiles, the zoom that
		 * buys size back — is about pixels. A glyph tile is two columns and one row
		 * whatever happens, so a cap shows less world at exactly the same size and
		 * spends the rest of the terminal on margins.
		 *
		 * This was shipped capped for one commit. On a 300x90 window it drew a
		 * 144-column island twenty-five rows down an otherwise empty screen, and the
		 * report it earned was "it doesn't render at all".
		 */
		const fit = mapFit({ mode: "glyph", columns: 300, rows: 90, cell: CELL, env: ENV });
		expect(fit.width).toBe(150);
		expect(fit.height).toBe(90);
		expect(fit.indent).toBe(0);
	});

	it("grows with the window rather than stopping somewhere", () => {
		const small = mapFit({ mode: "glyph", columns: 120, rows: 30, cell: CELL, env: ENV });
		const large = mapFit({ mode: "glyph", columns: 300, rows: 90, cell: CELL, env: ENV });
		expect(large.width).toBeGreaterThan(small.width);
		expect(large.height).toBeGreaterThan(small.height);
	});
});

describe("FOV", () => {
	it("caps the pixel renderer", () => {
		const fit = mapFit({
			mode: "kitty",
			columns: 400,
			rows: 100,
			cell: CELL,
			env: { FOV: "40x20" },
		});
		expect({ width: fit.width, height: fit.height }).toEqual({ width: 40, height: 20 });
	});

	it("is honoured by the glyph renderer too, when it is asked for by name", () => {
		// Only the *default* cap is pixel-mode. Somebody who sets `FOV` has said what
		// they want, and silently ignoring them in half the modes is its own bug.
		const fit = mapFit({
			mode: "glyph",
			columns: 400,
			rows: 100,
			cell: CELL,
			env: { FOV: "40x20" },
		});
		expect({ width: fit.width, height: fit.height }).toEqual({ width: 40, height: 20 });
		expect(fit.indent).toBeGreaterThan(0);
	});

	it("falls back rather than failing on nonsense", () => {
		for (const FOV of ["banana", "4x4", "40", "40x"]) {
			const fit = mapFit({ mode: "kitty", columns: 400, rows: 100, cell: CELL, env: { FOV } });
			expect({ width: fit.width, height: fit.height }, FOV).toEqual({ width: 72, height: 32 });
		}
	});
});
