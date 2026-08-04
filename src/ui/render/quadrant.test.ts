import { describe, expect, it } from "vitest";
import type { RGB } from "./color.js";
import type { Cell } from "./compose.js";
import { checkGlyph } from "./glyph-safety.js";
import {
	encodeQuadrantRow,
	QUADRANTS,
	type QuadCell,
	quadrantScene,
	tilesAcrossQuadrant,
	tilesDownQuadrant,
} from "./quadrant.js";
import { TILE_PX } from "./sprite.js";

const FG: RGB = [200, 100, 50];
const BG: RGB = [10, 20, 30];

function cell(ch: string, fg: RGB = FG, bg: RGB = BG): Cell {
	return { ch, fg, bg, bold: false, dim: false };
}

/**
 * Read an encoded row back into the four pixel colours of each cell.
 *
 * The point of decoding rather than asserting on the escape sequences is that
 * the encoder is *allowed* to choose how it says a thing — inverse video, a
 * space instead of a full block — so the only stable contract is the picture
 * that comes out. Every optimisation in the encoder is checked against this.
 */
function decodeRow(row: string): RGB[][] {
	const out: RGB[][] = [];
	let fg: RGB = [0, 0, 0];
	let bg: RGB = [0, 0, 0];
	// Built rather than written as a literal: an ESC in a regex literal is a
	// control character, which the linter rejects on sight.
	const ESC = "\u001B";
	const pattern = new RegExp(
		`${ESC}\\[(38|48);2;(\\d+);(\\d+);(\\d+)m|${ESC}\\[0m|([^${ESC}])`,
		"g",
	);

	for (const m of row.matchAll(pattern)) {
		if (m[1]) {
			const c: RGB = [Number(m[2]), Number(m[3]), Number(m[4])];
			if (m[1] === "38") fg = c;
			else bg = c;
			continue;
		}
		const ch = m[5];
		if (ch === undefined) continue; // a reset
		const bits = QUADRANTS.indexOf(ch);
		expect(bits, `unexpected glyph ${JSON.stringify(ch)}`).toBeGreaterThanOrEqual(0);
		// TL, TR, BL, BR.
		out.push([0, 1, 2, 3].map((q) => ((bits >> q) & 1 ? fg : bg)));
	}
	return out;
}

describe("quadrant glyphs", () => {
	it("has all sixteen patterns, space at 0 and full block at 15", () => {
		expect(QUADRANTS).toHaveLength(16);
		expect(QUADRANTS[0]).toBe(" ");
		expect(QUADRANTS[15]).toBe("█");
		expect(new Set(QUADRANTS).size).toBe(16);
	});

	// The compatibility claim for this whole renderer: quadrants need no font a
	// player does not already need, because they are in a block the existing
	// glyph registry already validates against.
	it("passes the same safety check as every other glyph the game emits", () => {
		for (const ch of QUADRANTS) {
			expect(checkGlyph(ch), `${ch} rejected`).toEqual({ ok: true });
		}
	});
});

describe("encodeQuadrantRow", () => {
	const cells: QuadCell[] = [
		{ bits: 0b0001, fg: FG, bg: BG },
		{ bits: 0b1111, fg: FG, bg: BG },
		{ bits: 0b0000, fg: FG, bg: BG },
		{ bits: 0b1010, fg: [1, 2, 3], bg: [4, 5, 6] },
	];

	it("round-trips every pixel", () => {
		const pixels = decodeRow(encodeQuadrantRow(cells, "truecolor"));
		expect(pixels).toEqual([
			[FG, BG, BG, BG],
			[FG, FG, FG, FG],
			[BG, BG, BG, BG],
			[
				[4, 5, 6],
				[1, 2, 3],
				[4, 5, 6],
				[1, 2, 3],
			],
		]);
	});

	// Polarity is a pure byte optimisation. If it ever changes a pixel it is a
	// bug, and one that would be very hard to see by eye on a busy map.
	it("draws the same picture with and without polarity choice", () => {
		const on = decodeRow(encodeQuadrantRow(cells, "truecolor", { polarity: true }));
		const off = decodeRow(encodeQuadrantRow(cells, "truecolor", { polarity: false }));
		expect(on).toEqual(off);
	});

	it("saves an SGR by inverting a cell whose colours are the other way round", () => {
		// Second cell is the first one's mirror image. Drawn directly it would
		// need two new colour changes; inverted it needs none.
		const mirrored: QuadCell[] = [
			{ bits: 0b0011, fg: FG, bg: BG },
			{ bits: 0b1100, fg: BG, bg: FG },
		];
		const on = encodeQuadrantRow(mirrored, "truecolor", { polarity: true });
		const off = encodeQuadrantRow(mirrored, "truecolor", { polarity: false });
		expect(on.length).toBeLessThan(off.length);
		expect(decodeRow(on)).toEqual(decodeRow(off));
	});

	it("needs no foreground for an empty cell or background for a full one", () => {
		expect(encodeQuadrantRow([{ bits: 0, fg: FG, bg: BG }], "truecolor")).not.toContain("38;2");
		expect(encodeQuadrantRow([{ bits: 15, fg: FG, bg: BG }], "truecolor")).not.toContain("48;2");
	});

	it("emits plain glyphs with no colour at depth none", () => {
		expect(encodeQuadrantRow(cells, "none")).toBe("▘█ ▐");
	});

	it("resets at the end so the background cannot bleed into the panels", () => {
		expect(encodeQuadrantRow(cells, "truecolor").endsWith("[0m")).toBe(true);
		expect(encodeQuadrantRow([], "truecolor")).toBe("");
	});
});

describe("quadrantScene", () => {
	it("turns a W x H tile scene into a 2W x 2H cell grid", () => {
		const scene = [
			[cell("█"), cell("█"), cell("█")],
			[cell("█"), cell("█"), cell("█")],
		];
		const quads = quadrantScene(scene);
		expect(quads).toHaveLength(2 * (TILE_PX / 2));
		expect(quads[0]).toHaveLength(3 * (TILE_PX / 2));
	});

	// `expandScene` has to work to avoid this: its specks are placed by absolute
	// position, so getting it wrong makes the ground shimmer on every footfall.
	// Sprites are addressed within their tile, so the property is free — but it
	// is the property the renderer is actually relying on, so it gets a test.
	it("draws a tile the same way wherever it sits in the viewport", () => {
		const tile = cell("▲");
		const scene = [
			[cell("░"), tile, cell("░")],
			[tile, cell("░"), cell("░")],
		];
		const quads = quadrantScene(scene);
		const half = TILE_PX / 2;
		// The tree at tile (1,0) and the tree at tile (0,1) must rasterise alike.
		for (let sy = 0; sy < half; sy++) {
			for (let sx = 0; sx < half; sx++) {
				expect(quads[sy]?.[half + sx]?.bits).toBe(quads[half + sy]?.[sx]?.bits);
			}
		}
	});

	it("gives every cell at most two colours, so no quantisation is needed", () => {
		const scene = [[cell("▲"), cell("━"), cell("░")]];
		for (const row of quadrantScene(scene)) {
			for (const c of row) {
				expect(new Set([c.fg.join(), c.bg.join()]).size).toBeLessThanOrEqual(2);
			}
		}
	});
});

describe("viewport sizing", () => {
	it("rounds down and never returns zero", () => {
		expect(tilesAcrossQuadrant(88)).toBe(44);
		expect(tilesDownQuadrant(34)).toBe(17);
		expect(tilesAcrossQuadrant(1)).toBe(1);
		expect(tilesDownQuadrant(0)).toBe(1);
	});
});
