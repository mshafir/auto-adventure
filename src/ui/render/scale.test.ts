import { describe, expect, it } from "vitest";
import type { RGB } from "./color.js";
import type { Cell } from "./compose.js";
import { expandRow, expandScene } from "./scale.js";

const FG: RGB = [200, 200, 200];
const BG: RGB = [20, 30, 40];

const cell = (ch: string, extra?: Partial<Cell>): Cell => ({
	ch,
	fg: FG,
	bg: BG,
	bold: false,
	dim: false,
	...extra,
});
const glyphs = (cells: readonly Cell[]) => cells.map((c) => c.ch).join("");

describe("horizontal expansion", () => {
	it("is the identity at 1x", () => {
		expect(glyphs(expandRow([cell("a"), cell("░")], 1))).toBe("a░");
	});

	it("widens every row by exactly the scale", () => {
		const out = expandScene([[cell("a"), cell("b")], [cell("c")]], 2);
		expect(out.map((r) => r.length)).toEqual([4, 2]);
	});

	it("carries the background across every added column", () => {
		// A road or a shadow belongs to the ground, so stopping it halfway through
		// a tile would undo the geometry this widening exists to fix.
		const road: RGB = [90, 80, 60];
		for (const ch of ["┏", "░", "@", " "]) {
			const out = expandRow([cell(ch, { bg: road, entity: ch === "@" })], 2);
			expect(out.map((c) => c.bg)).toEqual([road, road]);
		}
	});

	it("keeps the style identical across the pair, so runs still collapse", () => {
		for (const ch of ["┏", "░", "*"]) {
			const out = expandRow([cell(ch)], 2);
			expect(out[0]?.fg).toEqual(out[1]?.fg);
			expect(out[0]?.bold).toBe(out[1]?.bold);
		}
	});

	describe("rule 1 — lines continue", () => {
		it("carries a wall east where the glyph has an east arm", () => {
			// A corner is a shape: `┏┏` is two corners and `┏ ` is a broken wall, so
			// continuation is the only reading that survives doubling.
			expect(glyphs(expandRow([cell("┏")], 2))).toBe("┏━");
			expect(glyphs(expandRow([cell("┣")], 2))).toBe("┣━");
			expect(glyphs(expandRow([cell("━")], 2))).toBe("━━");
			expect(glyphs(expandRow([cell("╋")], 2))).toBe("╋━");
		});

		it("keeps each autotile family at its own line weight", () => {
			expect(glyphs(expandRow([cell("├")], 2))).toBe("├─");
			expect(glyphs(expandRow([cell("╠")], 2))).toBe("╠═");
		});

		it("does not continue a glyph with no east arm", () => {
			for (const ch of ["┃", "┓", "┛", "│", "║"]) {
				expect(glyphs(expandRow([cell(ch)], 2, 0))).toBe(`${ch} `);
			}
		});

		it("runs an unbroken wall across a whole row", () => {
			const wall = [cell("┏"), cell("━"), cell("━"), cell("┓")];
			expect(glyphs(expandRow(wall, 2))).toBe("┏━━━━━┓ ");
		});
	});

	describe("rule 3 — structural glyphs hold their column", () => {
		it("never moves a person between halves of a tile", () => {
			// Placing by position would shift the player half a tile left and right
			// on every step, which reads as a wobble.
			for (const row of [0, 1, 2, 3]) {
				expect(glyphs(expandRow([cell("@", { entity: true })], 2, row))).toBe("@ ");
			}
		});

		it("holds the column at every position along a row", () => {
			const cells = [cell("."), cell("@", { entity: true }), cell(".")];
			const out = expandRow(cells, 2, 0);
			expect(out[2]?.ch).toBe("@");
			expect(out[3]?.ch).toBe(" ");
		});

		it("does not let an entity glyph pick up a line continuation", () => {
			// A cursor overlay drawing a box glyph must not grow an arm.
			expect(glyphs(expandRow([cell("━", { entity: true })], 2))).toBe("━ ");
		});
	});

	describe("rule 2 — ground texture is drawn once", () => {
		it("never repeats a glyph, so density is preserved", () => {
			// Doubling a glyph doubles the apparent density of whatever it depicts.
			for (const ch of ["░", "▒", "▓", "█", "≈", "~", "*", ",", "▲", "†"]) {
				const out = expandRow([cell(ch)], 2, 0);
				expect(out.filter((c) => c.ch === ch)).toHaveLength(1);
			}
		});

		it("alternates which half holds the glyph, so texture reads as scatter", () => {
			// Always choosing the left half lines every speck into vertical
			// pinstripes, the most obvious tell that a scene has been stretched.
			const even = glyphs(expandRow([cell("*")], 2, 0));
			const odd = glyphs(expandRow([cell("*")], 2, 1));
			expect(even).not.toBe(odd);
			expect([even, odd].sort()).toEqual([" *", "* "]);
		});

		it("offsets the choice between adjacent rows", () => {
			const scene = [
				[cell("*"), cell("*")],
				[cell("*"), cell("*")],
			];
			const out = expandScene(scene, 2);
			expect(glyphs(out[0] as Cell[])).not.toBe(glyphs(out[1] as Cell[]));
		});

		it("places a blank tile consistently rather than dithering nothing", () => {
			expect(glyphs(expandRow([cell(" ")], 2, 0))).toBe("  ");
			expect(glyphs(expandRow([cell(" ")], 2, 1))).toBe("  ");
		});

		it("chooses the same half for a given tile every time it is drawn", () => {
			// Placement is a function of position only, so terrain texture never
			// crawls as the camera moves.
			for (const row of [0, 5, 40]) {
				expect(glyphs(expandRow([cell(","), cell(",")], 2, row))).toBe(
					glyphs(expandRow([cell(","), cell(",")], 2, row)),
				);
			}
		});

		it("handles a negative row index without leaving a tile empty", () => {
			// Rows are indexed within the scene, but guard the modulo anyway: a
			// negative slot would blank both halves and punch a hole in the map.
			const out = expandRow([cell("*")], 2, -1);
			expect(out.filter((c) => c.ch === "*")).toHaveLength(1);
		});
	});
});
