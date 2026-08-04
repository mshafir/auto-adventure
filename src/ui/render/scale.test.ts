import { describe, expect, it } from "vitest";
import type { RGB } from "./color.js";
import type { Cell } from "./compose.js";
import { expandRow, expandScene } from "./scale.js";

const FG: RGB = [200, 200, 200];
const BG: RGB = [20, 30, 40];

const cell = (ch: string, bg: RGB = BG): Cell => ({ ch, fg: FG, bg, bold: false, dim: false });
const glyphs = (cells: readonly Cell[]) => cells.map((c) => c.ch).join("");

describe("horizontal expansion", () => {
	it("is the identity at 1x", () => {
		const row = [cell("a"), cell("b")];
		expect(glyphs(expandRow(row, 1, "smart"))).toBe("ab");
	});

	it("repeats the glyph in dup mode", () => {
		expect(glyphs(expandRow([cell("┏"), cell("x")], 2, "dup"))).toBe("┏┏xx");
	});

	it("blanks the added column in pad mode", () => {
		expect(glyphs(expandRow([cell("┏"), cell("x")], 2, "pad"))).toBe("┏ x ");
	});

	it("carries the background across every added column", () => {
		// A road or a shadow belongs to the ground, so stopping it halfway through
		// a tile would undo what the extra width is for.
		const road: RGB = [90, 80, 60];
		for (const mode of ["dup", "pad", "smart"] as const) {
			const out = expandRow([cell("·", road)], 2, mode);
			expect(out.map((c) => c.bg)).toEqual([road, road]);
		}
	});

	it("keeps the style identical across the pair, so runs still collapse", () => {
		const out = expandRow([cell("┏")], 2, "smart");
		expect(out[0]?.fg).toEqual(out[1]?.fg);
		expect(out[0]?.bg).toEqual(out[1]?.bg);
		expect(out[0]?.bold).toBe(out[1]?.bold);
	});

	describe("smart mode", () => {
		it("continues a wall eastward where the glyph has an east arm", () => {
			// The reason smart mode exists: a corner is a shape, so `┏┏` is two
			// corners and `┏ ` is a broken wall. Only `┏━` survives doubling.
			expect(glyphs(expandRow([cell("┏")], 2, "smart"))).toBe("┏━");
			expect(glyphs(expandRow([cell("┣")], 2, "smart"))).toBe("┣━");
			expect(glyphs(expandRow([cell("━")], 2, "smart"))).toBe("━━");
		});

		it("does not continue a wall that has no east arm", () => {
			expect(glyphs(expandRow([cell("┃")], 2, "smart"))).toBe("┃ ");
			expect(glyphs(expandRow([cell("┓")], 2, "smart"))).toBe("┓ ");
			expect(glyphs(expandRow([cell("┛")], 2, "smart"))).toBe("┛ ");
		});

		it("matches each autotile family to its own line weight", () => {
			expect(glyphs(expandRow([cell("├")], 2, "smart"))).toBe("├─");
			expect(glyphs(expandRow([cell("╠")], 2, "smart"))).toBe("╠═");
		});

		it("repeats area fills, so water and canopy stay solid", () => {
			expect(glyphs(expandRow([cell("░"), cell("≈")], 2, "smart"))).toBe("░░≈≈");
		});

		it("draws sparse texture once per tile", () => {
			// Repeating a speck would double the apparent density of a meadow.
			const row = expandRow([cell("*"), cell("*")], 2, "smart");
			expect(row.filter((c) => c.ch === "*")).toHaveLength(2);
		});

		it("alternates which column the speck lands in, so it reads as scatter", () => {
			// Always drawing it left lines every speck up into vertical pinstripes,
			// an artifact the 1x view does not have.
			const one = glyphs(expandRow([cell("*")], 2, "smart", 0));
			const next = glyphs(expandRow([cell("*")], 2, "smart", 1));
			expect(one).not.toBe(next);
			expect([one, next].sort()).toEqual([" *", "* "]);
		});

		it("never dithers an entity glyph, so a person cannot wobble as they walk", () => {
			// Alternating `@` by position would shift the player half a tile left
			// and right on every step.
			for (const ch of ["@", "B", "M", "g"]) {
				expect(glyphs(expandRow([cell(ch)], 2, "smart", 0))).toBe(`${ch} `);
				expect(glyphs(expandRow([cell(ch)], 2, "smart", 1))).toBe(`${ch} `);
			}
		});
	});

	it("offsets the dither per row across a whole scene", () => {
		const scene = [
			[cell("*"), cell("*")],
			[cell("*"), cell("*")],
		];
		const out = expandScene(scene, 2, "smart");
		expect(glyphs(out[0] as Cell[])).not.toBe(glyphs(out[1] as Cell[]));
	});

	it("widens every row by exactly the scale", () => {
		const scene = [[cell("a"), cell("b")], [cell("c")]];
		const out = expandScene(scene, 2, "smart");
		expect(out.map((r) => r.length)).toEqual([4, 2]);
	});
});
