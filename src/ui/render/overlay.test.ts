import { describe, expect, it } from "vitest";
import type { Cell } from "./compose.js";
import type { MiniCell } from "./minimap-data.js";
import { minimapExtent, overlayMinimap, paintMinimap } from "./overlay.js";
import { PAL } from "./palette.js";
import { type Frame, rasterScene } from "./raster.js";
import { TILE_WIDTH } from "./scale.js";

function scene(width: number, height: number): Cell[][] {
	return Array.from({ length: height }, () =>
		Array.from({ length: width }, () => ({
			ch: "░",
			fg: PAL.moss,
			bg: PAL.loam,
			bold: false,
			dim: false,
		})),
	);
}

function mini(width: number, height: number): MiniCell[][] {
	return Array.from({ length: height }, () =>
		Array.from({ length: width }, () => ({ ch: "~", fg: PAL.deep, bold: false, fill: true })),
	);
}

/** Cells a `width x height` chunk minimap takes up once widened and framed. */
function boxOf(width: number, height: number) {
	return { width: width * TILE_WIDTH + 2, height: height + 2 };
}

/** Where the map is still showing through. */
function mapCells(rows: readonly (readonly Cell[])[]): number {
	return rows.flat().filter((cell) => cell.ch === "░").length;
}

describe("overlayMinimap", () => {
	const BOX = boxOf(9, 5);
	// One cell of margin, so the box's own top-left corner.
	const top = 20 - 1 - BOX.height;
	const left = 40 - 1 - BOX.width;

	it("lands in the bottom-right corner, inside its own border", () => {
		const rows = overlayMinimap(scene(40, 20), mini(9, 5));

		expect(rows[top]?.[left]?.ch).toBe("╭");
		expect(rows[18]?.[38]?.ch).toBe("╯");
		expect(rows[top + 1]?.[left + 1]?.ch).toBe("~");
		expect(rows[17]?.[37]?.ch).toBe("~");
		// The margin itself is still map.
		expect(rows[19]?.[39]?.ch).toBe("░");
	});

	it("leaves the rest of the map alone", () => {
		const rows = overlayMinimap(scene(40, 20), mini(9, 5));
		expect(mapCells(rows)).toBe(40 * 20 - BOX.width * BOX.height);
		expect(rows[0]?.[0]).toEqual({
			ch: "░",
			fg: PAL.moss,
			bg: PAL.loam,
			bold: false,
			dim: false,
		});
	});

	it("does not paint over the scene it was given", () => {
		const original = scene(40, 20);
		overlayMinimap(original, mini(9, 5));
		expect(mapCells(original)).toBe(40 * 20);
	});

	it("puts the box in whichever corner it was asked for", () => {
		const corners = {
			topLeft: [1, 1],
			topRight: [1, left],
			bottomLeft: [top, 1],
			bottomRight: [top, left],
		} as const;
		for (const [corner, [y, x]] of Object.entries(corners)) {
			const rows = overlayMinimap(scene(40, 20), mini(9, 5), { corner: corner as never });
			expect(rows[y]?.[x]?.ch, corner).toBe("╭");
		}
	});

	// Clipped against the edge of the map it reads as a rendering fault, and on a
	// short terminal the map is the thing worth the space.
	it("draws nothing at all rather than a box that will not fit", () => {
		const rows = overlayMinimap(scene(10, 6), mini(9, 5));
		expect(mapCells(rows)).toBe(10 * 6);
	});

	it("gives the border and the map behind it the same background", () => {
		const rows = overlayMinimap(scene(40, 20), mini(9, 5));
		const border = rows[top]?.[left] as Cell;
		const inner = rows[top + 1]?.[left + 1] as Cell;
		expect(border.bg).toEqual(inner.bg);
		expect(border.bg).not.toEqual(PAL.loam);
	});

	/*
	 * A chunk gets the same widening a tile does, and for the same reason: a
	 * terminal cell is about twice as tall as it is wide, so one column per chunk
	 * draws a journey twenty chunks east as if it were only ten.
	 */
	it("draws each chunk TILE_WIDTH columns wide", () => {
		const rows = overlayMinimap(scene(40, 20), mini(9, 5));
		const line = rows[top + 1] as Cell[];
		const drawn = line.slice(left + 1, left + 1 + 9 * TILE_WIDTH);
		expect(drawn).toHaveLength(9 * TILE_WIDTH);
		expect(drawn.every((cell) => cell.ch === "~")).toBe(true);
	});

	// Density for a shade is per area and density for a mark is per glyph: `░░` is
	// the same open ground `░` is, but `▲▲` is two woods where `▲` is one.
	it("repeats a shade across its chunk but never a mark", () => {
		const shade: MiniCell[][] = [[{ ch: "░", fg: PAL.moss, bold: false, fill: true }]];
		const mark: MiniCell[][] = [[{ ch: "▲", fg: PAL.oak, bold: false, fill: false }]];
		const wide = overlayMinimap(scene(20, 10), shade, { corner: "topLeft" });
		const spot = overlayMinimap(scene(20, 10), mark, { corner: "topLeft" });

		expect(wide[2]?.slice(2, 2 + TILE_WIDTH).map((c) => c.ch)).toEqual(Array(TILE_WIDTH).fill("░"));
		expect(spot[2]?.slice(2, 2 + TILE_WIDTH).map((c) => c.ch)).toEqual([
			"▲",
			...Array(TILE_WIDTH - 1).fill(" "),
		]);
	});
});

describe("minimapExtent", () => {
	it("scales with the map, up to a cap", () => {
		expect(minimapExtent(200, 60)).toEqual({ width: 13, height: 11 });
		expect(minimapExtent(90, 30)).toEqual({ width: 13, height: 7 });
		expect(minimapExtent(60, 30)).toEqual({ width: 8, height: 7 });
	});

	// 120x34 is the size the screenshots are taken at and about the smallest a
	// terminal usually is; the minimap has to survive it.
	it("still fits on a short terminal", () => {
		expect(minimapExtent(120, 26)).toEqual({ width: 13, height: 5 });
	});

	it("gives up rather than showing a minimap of two chunks", () => {
		expect(minimapExtent(40, 12)).toBeUndefined();
		expect(minimapExtent(20, 8)).toBeUndefined();
	});

	// Whatever it returns has to leave room for a border and a margin, in both
	// renderers.
	it("always returns something the overlay can actually place", () => {
		for (let columns = 20; columns <= 200; columns += 3) {
			for (let rows = 8; rows <= 60; rows += 3) {
				const extent = minimapExtent(columns, rows);
				if (!extent) continue;
				const painted = overlayMinimap(scene(columns, rows), mini(extent.width, extent.height));
				expect(mapCells(painted), `${columns}x${rows}`).toBeLessThan(columns * rows);
			}
		}
	});
});

describe("paintMinimap", () => {
	// A chunk gets one terminal cell, doubled across, the same room the glyph path
	// gives it. These stand in for a cell of 4x6 pixels.
	const CHUNK_PX = { width: 8, height: 6 };

	/** A rasterised scene of flat ground, with no minimap on it yet. */
	function frameOf(tilesW: number, tilesH: number) {
		return rasterScene(scene(tilesW, tilesH));
	}

	function at(frame: Frame, x: number, y: number): number[] {
		const i = (y * frame.width + x) * 3;
		return [frame.rgb[i] as number, frame.rgb[i + 1] as number, frame.rgb[i + 2] as number];
	}

	it("fills a shaded chunk with its own colour", () => {
		const frame = frameOf(40, 20);
		paintMinimap(frame, mini(5, 3), { corner: "topLeft", margin: 4, chunk: CHUNK_PX });
		// Four pixels of margin and two of border put the first chunk at (6, 6).
		expect(at(frame, 6, 6)).toEqual([...PAL.deep]);
		expect(at(frame, 6 + 5 * CHUNK_PX.width - 1, 6 + 3 * CHUNK_PX.height - 1)).toEqual([
			...PAL.deep,
		]);
	});

	it("draws a border around it and leaves the map outside alone", () => {
		const frame = frameOf(40, 20);
		paintMinimap(frame, mini(5, 3), { corner: "topLeft", margin: 4, chunk: CHUNK_PX });
		expect(at(frame, 4, 4)).toEqual([...PAL.stone]);
		expect(at(frame, 3, 3)).not.toEqual([...PAL.stone]);
	});

	/*
	 * The counterpart of the glyph path's fill-versus-mark rule. There a mark takes
	 * one column of its chunk and the rest goes blank; here it is drawn as a sprite
	 * over a wash of the chunk's own colour, so it stands off the ground it is on.
	 */
	it("draws a mark as a sprite over a wash rather than filling flat", () => {
		const frame = frameOf(40, 20);
		const mark: MiniCell[][] = [[{ ch: "▲", fg: PAL.oak, bold: false, fill: false }]];
		paintMinimap(frame, mark, { corner: "topLeft", margin: 4, chunk: CHUNK_PX });

		const pixels = new Set<string>();
		for (let y = 0; y < CHUNK_PX.height; y++) {
			for (let x = 0; x < CHUNK_PX.width; x++) pixels.add(at(frame, 6 + x, 6 + y).join(","));
		}
		expect(pixels.size).toBe(2);
		expect(pixels.has(PAL.oak.join(","))).toBe(true);
	});

	it("lands in whichever corner it was asked for", () => {
		const corners = {
			topLeft: [4, 4],
			topRight: [4, -5],
			bottomLeft: [-5, 4],
			bottomRight: [-5, -5],
		} as const;
		for (const [corner, [dy, dx]] of Object.entries(corners)) {
			const frame = frameOf(40, 20);
			paintMinimap(frame, mini(5, 3), { corner: corner as never, margin: 4, chunk: CHUNK_PX });
			const x = dx > 0 ? dx : frame.width + dx;
			const y = dy > 0 ? dy : frame.height + dy;
			expect(at(frame, x, y), corner).toEqual([...PAL.stone]);
		}
	});

	it("draws nothing at all rather than a box that will not fit", () => {
		const frame = frameOf(4, 2);
		const before = Buffer.from(frame.rgb);
		paintMinimap(frame, mini(9, 5), { chunk: CHUNK_PX });
		expect(frame.rgb.equals(before)).toBe(true);
	});

	// Every write goes through a bounds check, so a badly placed box loses the
	// pixels that fell outside rather than corrupting the row below.
	it("never writes outside the buffer", () => {
		const frame = frameOf(40, 20);
		paintMinimap(frame, mini(5, 3), { corner: "bottomRight", margin: 0, chunk: CHUNK_PX });
		expect(frame.rgb).toHaveLength(frame.width * frame.height * 3);
	});
});
