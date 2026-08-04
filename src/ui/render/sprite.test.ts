import { describe, expect, it } from "vitest";
import type { RGB } from "./color.js";
import { allRegisteredGlyphs } from "./glyphs.js";
import { inkAt, paintFor, spriteCoverage, spriteFor, TILE_PX } from "./sprite.js";

const FG: RGB = [255, 0, 0];
const BG: RGB = [0, 0, 255];

/** Render a sprite to four strings, for readable assertions. */
function draw(ch: string): string[] {
	const { mask } = paintFor(ch, FG, BG);
	return Array.from({ length: TILE_PX }, (_, y) =>
		Array.from({ length: TILE_PX }, (_, x) => (inkAt(mask, x, y) ? "#" : ".")).join(""),
	);
}

describe("sprite coverage", () => {
	// The registry is the source of truth for what the game can draw, so a new
	// terrain glyph fails here rather than silently rendering as the fallback
	// lozenge on somebody's map.
	it("has a sprite for every glyph the tile registry can emit", () => {
		const { missing } = spriteCoverage(allRegisteredGlyphs());
		expect(missing).toEqual([]);
	});
});

describe("box-drawing sprites", () => {
	it("draws a heavy horizontal wall as a bar across the middle", () => {
		expect(draw("━")).toEqual(["....", "####", "####", "...."]);
	});

	it("draws a heavy vertical wall as a bar down the middle", () => {
		expect(draw("┃")).toEqual([".##.", ".##.", ".##.", ".##."]);
	});

	it("draws a corner that opens the way its arms point", () => {
		// ┏ has east and south arms: nothing above it or to its left.
		expect(draw("┏")).toEqual(["....", ".###", ".###", ".##."]);
	});

	it("keeps light, heavy and double at visibly different weights", () => {
		const ink = (ch: string) => draw(ch).join("").split("#").length - 1;
		expect(ink("─")).toBeLessThan(ink("━"));
		expect(ink("═")).toBeGreaterThan(ink("─"));
	});

	// Walls have to meet across tile boundaries or every run of wall comes out
	// as a dashed line. An east arm must reach the last column and a west arm
	// the first, so neighbouring tiles touch.
	it("runs arms all the way to the tile edge so walls join up", () => {
		const east = draw("╺");
		const west = draw("╸");
		expect(east.some((row) => row[TILE_PX - 1] === "#")).toBe(true);
		expect(west.some((row) => row[0] === "#")).toBe(true);
		const north = draw("╹");
		const south = draw("╻");
		expect(north[0]).toContain("#");
		expect(south[TILE_PX - 1]).toContain("#");
	});

	it("draws a glyph with no arms as a pillar rather than an empty tile", () => {
		expect(draw("■").join("")).toContain("#");
		expect(draw("○").join("")).toContain("#");
	});
});

describe("density sprites", () => {
	// The finding that drove this design: dithering sub-tile texture at 16
	// pixels a tile turns a field of grass into static. A shade is a value.
	it("blends to a flat colour instead of dithering", () => {
		const paint = paintFor("░", FG, BG);
		expect(paint.mask).toBe(0);
		expect(paint.bg).not.toEqual(BG);
		expect(paint.bg).not.toEqual(FG);
	});

	it("blends further toward the ink as the glyph gets denser", () => {
		const shade = (ch: string) => paintFor(ch, FG, BG).bg[0] as number;
		expect(shade("░")).toBeLessThan(shade("▒"));
		expect(shade("▒")).toBeLessThan(shade("▓"));
		expect(shade("▓")).toBeLessThan(shade("█"));
	});

	it("resolves a full block to the ink colour exactly", () => {
		expect(paintFor("█", FG, BG).bg).toEqual(FG);
	});
});

describe("inkAt", () => {
	it("reads the same offset within a tile at any world position", () => {
		const { mask } = paintFor("▲", FG, BG);
		for (let y = 0; y < TILE_PX; y++) {
			for (let x = 0; x < TILE_PX; x++) {
				expect(inkAt(mask, x + 4 * 7, y + 4 * 3)).toBe(inkAt(mask, x, y));
				// Negative world coordinates are ordinary in an open world.
				expect(inkAt(mask, x - 4 * 5, y - 4 * 9)).toBe(inkAt(mask, x, y));
			}
		}
	});
});

describe("entities", () => {
	// NPC glyphs are letters, and a letter cannot be read in sixteen pixels. So
	// anything flagged as an entity is drawn as a figure regardless of its glyph,
	// and only its colour says who it is.
	it("draws any entity as the same figure whatever its letter", () => {
		const guard = paintFor("G", FG, BG, true);
		const merchant = paintFor("M", FG, BG, true);
		expect(guard.mask).toBe(merchant.mask);
		expect(guard.mask).not.toBe(0);
	});

	it("does not use the figure for terrain that happens to share a glyph", () => {
		expect(paintFor("▲", FG, BG, false).mask).not.toBe(paintFor("▲", FG, BG, true).mask);
	});
});

describe("fallback", () => {
	it("draws something visible for an unknown glyph rather than a blank", () => {
		expect(spriteFor("¿")).toEqual(spriteFor("©"));
		expect(draw("¿").join("")).toContain("#");
	});
});
