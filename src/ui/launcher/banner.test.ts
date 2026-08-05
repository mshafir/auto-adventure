import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGlyph } from "../render/glyph-safety.js";
import { bannerFor, bannerVariants, clearBannerCache, PLAIN_TITLE } from "./banner.js";

let dir: string;
let file: string;

const TALL = 99;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "auto-adventure-banner-"));
	file = join(dir, "title.txt");
	clearBannerCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	clearBannerCache();
});

describe("the shipped title", () => {
	it("comes in several sizes, each with square edges", () => {
		const variants = bannerVariants();
		expect(variants.length).toBeGreaterThan(2);
		for (const variant of variants) {
			expect(variant.height).toBe(variant.lines.length);
			for (const line of variant.lines) {
				expect(stringWidth(line), line).toBeLessThanOrEqual(variant.width);
			}
		}
	});

	/*
	 * The art is Block Elements, which `glyph-safety.ts` vouches for and the map
	 * already draws thousands of every frame. It matters more here than anywhere: the
	 * title is the one screen drawn before anything has been asked of the terminal, so
	 * a character that turns out double-width would shear it with nothing to fall back
	 * on.
	 */
	it("is drawn in characters that occupy exactly one column", () => {
		for (const variant of bannerVariants()) {
			for (const line of variant.lines) {
				for (const character of line) {
					if (character === " ") continue;
					expect(checkGlyph(character), character).toEqual({ ok: true });
					expect(stringWidth(character), character).toBe(1);
				}
			}
		}
	});

	it("has a size for eighty columns, and one for a short window", () => {
		// Eighty is the width everything else is designed against, and a title screen
		// that only works on a big terminal is one most people see broken.
		expect(bannerVariants().some((variant) => variant.width <= 76)).toBe(true);
		// Six rows or fewer, so the menu under it still fits a 24-row terminal.
		expect(bannerVariants().some((variant) => variant.height <= 6)).toBe(true);
	});
});

describe("choosing a size", () => {
	function write(...blocks: string[]) {
		writeFileSync(file, blocks.join("\n---\n"));
	}

	it("takes the widest that fits", () => {
		write("WIDEWIDEWIDE", "NARROW");
		expect(bannerFor(20, TALL, file)).toEqual(["WIDEWIDEWIDE"]);
		expect(bannerFor(11, TALL, file)).toEqual(["NARROW"]);
	});

	/*
	 * The failure worth designing against. A banner one column too wide does not look
	 * like a small title — it wraps, and a wrapped banner reads as a rendering fault
	 * on the first screen anybody sees of the game.
	 */
	it("never returns art too wide for the terminal", () => {
		write("WIDEWIDEWIDE", "NARROW");
		for (let columns = 1; columns < 30; columns++) {
			for (const line of bannerFor(columns, TALL, file)) {
				if (line === PLAIN_TITLE) continue;
				expect(line.length, `${columns} columns`).toBeLessThanOrEqual(columns);
			}
		}
	});

	/*
	 * And too tall is its own failure, with a different shape. The big sizes are
	 * eleven rows and five; on a short terminal the tall one would push the menu off
	 * the bottom of the frame, which is worse than a smaller title.
	 */
	it("skips a size that would not leave room for the menu", () => {
		// The tall one is also the wider one, which is the real shape of this: sizes
		// are tried widest first, so the tall variant is the one reached for.
		write("TALLTALL\nTALLTALL\nTALLTALL\nTALLTALL", "SHORT");
		expect(bannerFor(80, 4, file)).toHaveLength(4);
		expect(bannerFor(80, 3, file)).toEqual(["SHORT"]);
	});

	it("falls back to the plain words when nothing fits", () => {
		write("WIDEWIDEWIDE");
		expect(bannerFor(4, TALL, file)).toEqual([PLAIN_TITLE]);
		expect(bannerFor(80, 0, file)).toEqual([PLAIN_TITLE]);
	});

	it("falls back when the file is not there at all", () => {
		// A missing asset is not worth failing a launch over.
		expect(bannerFor(200, TALL, join(dir, "absent.txt"))).toEqual([PLAIN_TITLE]);
	});

	it("reads the sizes in any order they are written", () => {
		write("NARROW", "WIDEWIDEWIDE");
		expect(bannerFor(20, TALL, file)).toEqual(["WIDEWIDEWIDE"]);
	});

	it("treats blank lines around a block as formatting, not as art", () => {
		writeFileSync(file, "\n\nTOP\nBOTTOM\n\n");
		expect(bannerFor(20, TALL, file)).toEqual(["TOP", "BOTTOM"]);
	});
});
