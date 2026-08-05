import { describe, expect, it } from "vitest";
import type { Facing } from "../../core/rules/state.js";
import type { RGB } from "./color.js";
import { allRegisteredGlyphs } from "./glyphs.js";
import { PAL } from "./palette.js";
import { inkAt, paintFor, spriteCoverage, spriteFor, TILE_PX } from "./sprite.js";

const FG: RGB = [255, 0, 0];
const BG: RGB = [0, 0, 255];

/** Render a sprite to one string per row, for readable assertions. */
function draw(ch: string, size = 8, entity = false): string[] {
	const { shape } = paintFor({ ch, fg: FG, bg: BG, entity });
	return Array.from({ length: size }, (_, y) =>
		Array.from({ length: size }, (_, x) => (inkAt(shape, x, y, size) ? "#" : ".")).join(""),
	);
}

/** What fraction of a tile a sprite inks, at a given size. */
function coverage(ch: string, size: number): number {
	const rows = draw(ch, size);
	const ink = rows.join("").split("#").length - 1;
	return ink / (size * size);
}

describe("sprite coverage", () => {
	// The registry is the source of truth for what the game can draw, so a new
	// terrain glyph fails here rather than quietly rendering as the fallback
	// lozenge on somebody's map.
	it("has a sprite for every glyph the tile registry can emit", () => {
		expect(spriteCoverage(allRegisteredGlyphs()).missing).toEqual([]);
	});
});

describe("resolution independence", () => {
	// The reason sprites are procedures rather than bitmaps. A fixed 4x4 mask
	// upscaled to 16x16 is a blocky 4x4; a shape drawn from the unit square is
	// the same picture at any size, which is what makes TILE_PX a free choice.
	// Compared at 32 and 64 rather than at 16 and 32 because the measurement has
	// to outrun its own quantisation: a 0.3-wide line is 4.8px at 16, and which
	// way that rounds moves the coverage by more than a genuinely size-dependent
	// sprite would. Above 32 the rounding error is small enough that a shape
	// that failed to scale would stand out.
	it("inks the same fraction of a tile as resolution grows", () => {
		for (const ch of ["▲", "●", "━", "│", "+", "▢", "@"]) {
			const small = coverage(ch, 32);
			const large = coverage(ch, 64);
			expect(Math.abs(small - large), `${ch}: ${small} vs ${large}`).toBeLessThan(0.03);
		}
	});

	/**
	 * Below about twelve pixels the thinnest shapes stop scaling, and it is worth
	 * knowing where the floor is rather than discovering it as a wrong-looking
	 * fence. A light line is 0.14 of a tile: 2.2px at 16 and 4.5px at 32, both of
	 * which round to the same fraction — but 1.1px at 8, which rounds *up* to 2
	 * and draws a fence at twice its intended weight. Shapes stay correct, they
	 * just stop being proportional.
	 */
	it("quantises thin lines upward below about twelve pixels", () => {
		expect(coverage("│", 8)).toBeGreaterThan(coverage("│", 16));
		expect(coverage("│", 16)).toBeCloseTo(coverage("│", 32), 2);
	});

	it("draws something at every size it could be asked for", () => {
		for (const size of [4, 8, 16, 32]) {
			expect(draw("▲", size).join(""), `size ${size}`).toContain("#");
		}
	});
});

describe("box-drawing sprites", () => {
	it("draws a heavy horizontal wall as a bar across the middle", () => {
		const rows = draw("━");
		// Top and bottom rows are clear; the middle band spans the full width.
		expect(rows[0]).toBe("........");
		expect(rows[7]).toBe("........");
		expect(rows[4]).toBe("########");
	});

	it("draws a heavy vertical wall as a bar down the middle", () => {
		for (const row of draw("┃")) {
			expect(row).toBe("...##...");
		}
	});

	it("draws a corner that opens the way its arms point", () => {
		// ┏ has east and south arms, so its top-left quarter is empty and its
		// bottom-right is not.
		const rows = draw("┏", 8);
		expect(rows[0]?.slice(0, 3)).toBe("...");
		expect(rows[6]?.slice(3, 5)).toBe("##");
		expect(rows[4]?.slice(6)).toBe("##");
	});

	it("keeps light, heavy and double at visibly different weights", () => {
		expect(coverage("─", 16)).toBeLessThan(coverage("━", 16));
		expect(coverage("═", 16)).toBeGreaterThan(coverage("─", 16));
	});

	// Walls must meet across tile boundaries or every run comes out dashed.
	it("runs arms to the tile edge so walls join up", () => {
		const east = draw("╺", 16);
		const west = draw("╸", 16);
		expect(east.some((row) => row[15] === "#")).toBe(true);
		expect(west.some((row) => row[0] === "#")).toBe(true);
		expect(draw("╹", 16)[0]).toContain("#");
		expect(draw("╻", 16)[15]).toContain("#");
	});

	it("draws a double span as two rails with a gap between them", () => {
		// A horizontal double line has a clear track through its middle; a heavy
		// one of the same weight does not. That gap is the whole difference.
		const double = draw("═", 16);
		const middle = double[Math.floor(16 / 2)] as string;
		expect(middle).not.toContain("#");
		expect(draw("━", 16)[8]).toContain("#");
	});

	it("draws a glyph with no arms as a pillar rather than an empty tile", () => {
		expect(draw("■").join("")).toContain("#");
		expect(draw("○", 16).join("")).toContain("#");
	});
});

describe("density sprites", () => {
	// The finding that drove this design: dithering sub-tile texture turns a
	// field of grass into static. A shade is a value, not a pattern.
	it("blends to a flat colour instead of drawing anything", () => {
		const paint = paintFor({ ch: "░", fg: FG, bg: BG });
		expect(draw("░", 8).join("")).not.toContain("#");
		expect(paint.bg).not.toEqual(BG);
		expect(paint.bg).not.toEqual(FG);
	});

	it("blends further toward the ink as the glyph gets denser", () => {
		const shade = (ch: string) => paintFor({ ch, fg: FG, bg: BG }).bg[0] as number;
		expect(shade("░")).toBeLessThan(shade("▒"));
		expect(shade("▒")).toBeLessThan(shade("▓"));
		expect(shade("▓")).toBeLessThan(shade("█"));
	});

	it("resolves a full block to the ink colour exactly", () => {
		expect(paintFor({ ch: "█", fg: FG, bg: BG }).bg).toEqual(FG);
	});
});

describe("entities", () => {
	// NPC glyphs are letters, and a letter is not legible at tile size. Anything
	// flagged as an entity is a figure regardless of its glyph; only the colour
	// says who it is.
	it("draws any entity as the same figure whatever its letter", () => {
		expect(draw("G", 16, true)).toEqual(draw("M", 16, true));
		expect(draw("G", 16, true).join("")).toContain("#");
	});

	it("does not use the figure for terrain that happens to share a glyph", () => {
		expect(draw("▲", 16, true)).not.toEqual(draw("▲", 16, false));
	});

	/*
	 * Which way you face decides what SPACE acts on, so it has to be visible. It
	 * used to be a mark painted on the tile in *front*, which cost that tile its
	 * own glyph — at forty pixels that means a hole punched through the signpost
	 * you are about to read. So it lives on the player's own sprite instead.
	 */
	describe("facing", () => {
		const SIZE = 24;
		const EDGE = 2;
		/** Ink in the outermost band of each side: top, bottom, left, right. */
		function edges(facing?: Facing): [boolean, boolean, boolean, boolean] {
			const paint = paintFor({
				ch: "@",
				fg: PAL.player,
				bg: PAL.loam,
				entity: true,
				...(facing ? { facing } : {}),
			});
			const ink = (x: number, y: number) => inkAt(paint.shape, x, y, SIZE);
			const band = (pick: (n: number) => [number, number]) => {
				for (let n = 0; n < SIZE; n++) {
					const [x, y] = pick(n);
					if (ink(x, y)) return true;
				}
				return false;
			};
			return [
				band((n) => [n, EDGE]),
				band((n) => [n, SIZE - 1 - EDGE]),
				band((n) => [EDGE, n]),
				band((n) => [SIZE - 1 - EDGE, n]),
			];
		}

		it("marks the edge it is facing and no other", () => {
			expect(edges("up")).toEqual([true, false, false, false]);
			expect(edges("down")).toEqual([false, true, false, false]);
			expect(edges("left")).toEqual([false, false, true, false]);
			expect(edges("right")).toEqual([false, false, false, true]);
		});

		it("keeps its edges to itself when it has no facing", () => {
			expect(edges()).toEqual([false, false, false, false]);
		});

		/*
		 * A tile has two colours, so the wedge and the figure are the same ink. If
		 * they touch anywhere they merge into one blob and the direction stops
		 * reading — which is what the first attempt did, with the wedge swallowed by
		 * the head.
		 */
		it("leaves a gap between the wedge and the figure", () => {
			const paint = paintFor({
				ch: "@",
				fg: PAL.player,
				bg: PAL.loam,
				entity: true,
				facing: "up",
			});
			const column = Math.floor(SIZE / 2);
			const rows: boolean[] = [];
			for (let y = 0; y < SIZE; y++) rows.push(inkAt(paint.shape, column, y, SIZE));
			// Down the middle: wedge, gap, then figure. Two runs of ink, not one.
			const runs = rows
				.join("")
				.split(/false+/)
				.filter(Boolean).length;
			expect(runs).toBeGreaterThanOrEqual(2);
		});
	});
});

describe("inkAt", () => {
	// Sampling at the pixel corner instead of its centre shifts every shape half
	// a pixel up and left, which shows as a lopsided tree and walls that meet
	// their neighbours unevenly.
	it("samples the centre of a pixel", () => {
		// A disc of radius 0.1 at the centre covers only the middle of a 4px tile,
		// and only centre sampling puts it in both middle pixels symmetrically.
		const dot = paintFor({ ch: "·", fg: FG, bg: BG }).shape;
		expect(inkAt(dot, 1, 1, 4)).toBe(inkAt(dot, 2, 2, 4) || inkAt(dot, 1, 1, 4));
		expect(inkAt(dot, 0, 0, 4)).toBe(false);
	});

	it("defaults to the configured tile size", () => {
		const s = paintFor({ ch: "█", fg: FG, bg: BG }).shape;
		expect(inkAt(s, 0, 0)).toBe(inkAt(s, 0, 0, TILE_PX));
	});
});

describe("fallback", () => {
	it("draws something visible for an unknown glyph rather than a blank", () => {
		expect(spriteFor("¿")).toEqual(spriteFor("©"));
		expect(draw("¿", 16).join("")).toContain("#");
	});
});
