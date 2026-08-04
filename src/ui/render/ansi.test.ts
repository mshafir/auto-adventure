import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { generateChunk } from "../../core/gen/pipeline.js";
import { hashString } from "../../core/rand/hash.js";
import { CHUNK } from "../../core/world/coords.js";
import { encodeRow, encodeScene } from "./ansi.js";
import type { ColorDepth, RGB } from "./color.js";
import { detectColorDepth, rgb, toAnsi16, toAnsi256 } from "./color.js";
import { type Cell, composeScene } from "./compose.js";
import { createWorldTileSource } from "./world-source.js";

const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const BLACK: RGB = [0, 0, 0];

function cell(ch: string, fg: RGB = RED, bg: RGB = BLACK, extra?: Partial<Cell>): Cell {
	return { ch, fg, bg, bold: false, dim: false, ...extra };
}

const DEPTHS: ColorDepth[] = ["truecolor", "ansi256", "ansi16", "none"];

const ESC = "\u001B";

/** Count literal occurrences. Avoids putting a control character in a regex. */
function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe("encodeRow", () => {
	it("round-trips the visible text at every colour depth", () => {
		const cells = [cell("a"), cell("b", BLUE), cell("c")];
		for (const depth of DEPTHS) {
			expect(stripAnsi(encodeRow(cells, depth))).toBe("abc");
		}
	});

	it("emits no escapes at all when colour is unavailable", () => {
		const out = encodeRow([cell("x"), cell("y", BLUE)], "none");
		expect(out).toBe("xy");
	});

	it("run-length encodes: one style change costs one pair of sequences", () => {
		const uniform = Array.from({ length: 40 }, () => cell("░"));
		const out = encodeRow(uniform, "truecolor");
		// One fg + one bg up front, one reset at the end. Not 40 of each.
		expect(count(out, `${ESC}[38;2;`)).toBe(1);
		expect(count(out, `${ESC}[48;2;`)).toBe(1);
		expect(stripAnsi(out)).toHaveLength(40);
	});

	it("re-emits a sequence only where the style actually changes", () => {
		const cells = [cell("a"), cell("b"), cell("c", BLUE), cell("d", BLUE), cell("e")];
		const out = encodeRow(cells, "truecolor");
		expect(count(out, `${ESC}[38;2;`)).toBe(3);
	});

	it("always terminates with a reset so the background cannot bleed", () => {
		const out = encodeRow([cell("x", RED, BLUE)], "truecolor");
		expect(out.endsWith("\u001B[0m")).toBe(true);
	});

	it("returns an empty string for an empty row", () => {
		expect(encodeRow([], "truecolor")).toBe("");
	});

	it("clears bold with a reset rather than leaking it onto later cells", () => {
		const cells = [cell("a", RED, BLACK, { bold: true }), cell("b")];
		const out = encodeRow(cells, "truecolor");
		const boldIndex = out.indexOf("\u001B[1m");
		const resetIndex = out.indexOf("\u001B[0m", boldIndex);
		expect(boldIndex).toBeGreaterThanOrEqual(0);
		// A reset must appear between the two cells, not only at end of row.
		expect(resetIndex).toBeLessThan(out.lastIndexOf("b"));
	});

	it("re-establishes colour after a reset forced by clearing bold", () => {
		const cells = [cell("a", RED, BLUE, { bold: true }), cell("b", RED, BLUE)];
		const out = encodeRow(cells, "truecolor");
		expect(count(out, `${ESC}[38;2;255;0;0m`)).toBe(2);
		expect(count(out, `${ESC}[48;2;0;0;255m`)).toBe(2);
	});
});

describe("column alignment", () => {
	const seed = hashString("render-alignment");
	const { chunk } = generateChunk({ seed }, { cx: 0, cy: 0 });
	const source = createWorldTileSource({
		seed,
		chunkAt: (cx, cy) => (cx === 0 && cy === 0 ? chunk : undefined),
	});

	it("every encoded row of a scene has identical visible width", () => {
		// The guarantee that makes the map readable: if any glyph were rendered
		// double-width, that row would measure wider than its neighbours and the
		// whole map below it would shear.
		const camera = { x: 0, y: 0, width: 40, height: 20 };
		for (const depth of DEPTHS) {
			const rows = encodeScene(composeScene(source, camera), depth);
			expect(rows).toHaveLength(20);
			const widths = rows.map((row) => stringWidth(row));
			expect(new Set(widths).size, `depth ${depth} produced ragged rows`).toBe(1);
			expect(widths[0]).toBe(40);
		}
	});

	it("keeps rows aligned when the camera straddles a chunk boundary", () => {
		// Half the viewport resolves into a generated chunk and half into empty
		// space; both halves must still be exactly one column per tile.
		const camera = { x: CHUNK - 10, y: CHUNK - 6, width: 30, height: 12 };
		const rows = encodeScene(composeScene(source, camera), "truecolor");
		for (const row of rows) {
			expect(stringWidth(row)).toBe(30);
		}
	});

	it("renders ungenerated area as void without changing row width", () => {
		const rows = encodeScene(
			composeScene(source, { x: -500, y: -500, width: 12, height: 4 }),
			"truecolor",
		);
		for (const row of rows) {
			expect(stringWidth(row)).toBe(12);
		}
	});

	it("draws entities above terrain at the position given", () => {
		const withPlayer = createWorldTileSource(
			{ seed, chunkAt: (cx, cy) => (cx === 0 && cy === 0 ? chunk : undefined) },
			{ entityAt: (x, y) => (x === 5 && y === 5 ? { ch: "@", fg: [0, 255, 0] } : undefined) },
		);
		const cells = composeScene(withPlayer, { x: 0, y: 0, width: 10, height: 10 });
		expect(cells[5]?.[5]?.ch).toBe("@");
		expect(cells[4]?.[5]?.ch).not.toBe("@");
	});
});

describe("colour quantization", () => {
	it("maps greys onto the 256-colour grey ramp", () => {
		expect(toAnsi256([0, 0, 0])).toBe(16);
		expect(toAnsi256([255, 255, 255])).toBe(231);
		const mid = toAnsi256([128, 128, 128]);
		expect(mid).toBeGreaterThanOrEqual(232);
		expect(mid).toBeLessThanOrEqual(255);
	});

	it("keeps every 256-colour index in range for arbitrary inputs", () => {
		for (let r = 0; r < 256; r += 17) {
			for (let g = 0; g < 256; g += 17) {
				for (let b = 0; b < 256; b += 17) {
					const idx = toAnsi256([r, g, b]);
					expect(idx).toBeGreaterThanOrEqual(16);
					expect(idx).toBeLessThanOrEqual(255);
				}
			}
		}
	});

	it("maps saturated colours to the expected ANSI-16 slots", () => {
		expect(toAnsi16([255, 0, 0])).toBe(9);
		expect(toAnsi16([0, 0, 0])).toBe(0);
		expect(toAnsi16([255, 255, 255])).toBe(15);
	});

	it("parses both short and long hex", () => {
		expect(rgb("#fff")).toEqual([255, 255, 255]);
		expect(rgb("#2f6fb5")).toEqual([47, 111, 181]);
		expect(rgb("2f6fb5")).toEqual([47, 111, 181]);
	});
});

describe("detectColorDepth", () => {
	it("honours NO_COLOR and FORCE_COLOR ahead of terminal sniffing", () => {
		expect(detectColorDepth({ NO_COLOR: "1", COLORTERM: "truecolor" })).toBe("none");
		expect(detectColorDepth({ FORCE_COLOR: "3", TERM: "dumb" })).toBe("truecolor");
		expect(detectColorDepth({ FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe("none");
	});

	it("reads COLORTERM and TERM", () => {
		expect(detectColorDepth({ COLORTERM: "truecolor" })).toBe("truecolor");
		expect(detectColorDepth({ COLORTERM: "24bit" })).toBe("truecolor");
		expect(detectColorDepth({ TERM: "xterm-256color" })).toBe("ansi256");
		expect(detectColorDepth({ TERM: "xterm" })).toBe("ansi16");
		expect(detectColorDepth({ TERM: "dumb" })).toBe("none");
		expect(detectColorDepth({})).toBe("none");
	});
});
