import { describe, expect, it } from "vitest";
import type { Cell } from "./compose.js";
import { PAL } from "./palette.js";
import { clearTileCache, rasterScene, tileFit } from "./raster.js";

function cell(ch: string, fg = PAL.moss, bg = PAL.loam): Cell {
	return { ch, fg, bg, bold: false, dim: false };
}

/** A scene with a bit of everything: a flat shade, a speck, and a figure. */
function scene(): Cell[][] {
	return [
		[cell("░"), cell("▲", PAL.oak), cell("~", PAL.deep)],
		[cell("@", PAL.player), cell("░"), cell("▲", PAL.oak)],
		[cell("~", PAL.deep), cell("@", PAL.player), cell("░")],
	];
}

describe("rasterScene", () => {
	it("fills every pixel of the rectangle it claims", () => {
		const frame = rasterScene(scene(), { tilePx: 8 });
		expect(frame.width).toBe(24);
		expect(frame.height).toBe(24);
		expect(frame.rgb).toHaveLength(24 * 24 * 3);
	});

	/*
	 * The tile cache is the whole optimisation and the whole risk: tiles that were
	 * drawn once and copied everywhere could be copied to the wrong place, or a
	 * later tile could be handed an earlier one's bitmap. Drawing the same scene
	 * cold and warm has to give the same bytes.
	 */
	it("draws the same bytes whether its cache is cold or warm", () => {
		clearTileCache();
		const cold = rasterScene(scene(), { tilePx: 12 });
		const warm = rasterScene(scene(), { tilePx: 12 });
		expect(warm.rgb.equals(cold.rgb)).toBe(true);

		clearTileCache();
		const again = rasterScene(scene(), { tilePx: 12 });
		expect(again.rgb.equals(cold.rgb)).toBe(true);
	});

	// Keyed on the colours as well as the shape, because lighting and shadow are
	// already folded into them. Two cells sharing a glyph but not a colour must
	// not share a bitmap.
	it("does not confuse two tiles that share a glyph but not a colour", () => {
		clearTileCache();
		const frame = rasterScene([[cell("░", PAL.moss), cell("░", PAL.blood)]], { tilePx: 4 });
		const left = frame.rgb.subarray(0, 12);
		const right = frame.rgb.subarray(12, 24);
		expect(left.equals(right)).toBe(false);
	});

	// Same shape and colours in two places is the case the cache exists for, and
	// the case where a bad offset would show.
	it("puts a repeated tile in both places", () => {
		clearTileCache();
		const size = 6;
		const frame = rasterScene([[cell("▲", PAL.oak), cell("▲", PAL.oak)]], { tilePx: size });
		for (let y = 0; y < size; y++) {
			const rowStart = y * frame.width * 3;
			const left = frame.rgb.subarray(rowStart, rowStart + size * 3);
			const right = frame.rgb.subarray(rowStart + size * 3, rowStart + size * 6);
			expect(left.equals(right), `row ${y}`).toBe(true);
		}
	});

	it("draws the same picture at any tile size", () => {
		clearTileCache();
		// A shape is a function over the unit square, so the centre of a tile is the
		// same colour however many pixels it is given.
		const small = rasterScene([[cell("▲", PAL.oak)]], { tilePx: 8 });
		const large = rasterScene([[cell("▲", PAL.oak)]], { tilePx: 32 });
		const centre = (f: typeof small) => {
			const at = (Math.floor(f.height / 2) * f.width + Math.floor(f.width / 2)) * 3;
			return [f.rgb[at], f.rgb[at + 1], f.rgb[at + 2]];
		};
		expect(centre(large)).toEqual(centre(small));
	});
});

describe("tileFit", () => {
	// The reason the tile size is derived rather than fixed. At sixteen pixels a
	// tile is smaller than a cell, so the map showed far more world at far less
	// size than the glyph renderer alongside it.
	it("fits many more tiles at a small tile size than a large one", () => {
		const cell19x42 = { width: 19, height: 42 };
		expect(tileFit(163, 29, cell19x42, 16)).toEqual({ width: 193, height: 76 });
		expect(tileFit(163, 29, cell19x42, 38)).toEqual({ width: 81, height: 32 });
	});
});
