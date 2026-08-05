import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bannerFor, bannerVariants, clearBannerCache, PLAIN_TITLE } from "./banner.js";

let dir: string;
let file: string;

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
	it("is there, and every variant has square edges", () => {
		const variants = bannerVariants();
		expect(variants.length).toBeGreaterThan(1);
		for (const variant of variants) {
			expect(variant.lines.length).toBeGreaterThan(1);
			for (const line of variant.lines) {
				expect(line.length, line).toBeLessThanOrEqual(variant.width);
			}
		}
	});

	it("is pure ASCII, so it is the same width in every terminal", () => {
		// The one screen drawn before anything has been asked about the terminal. A
		// character that turns out to be double-width there would shear the art with
		// nothing to fall back on.
		for (const variant of bannerVariants()) {
			for (const line of variant.lines) {
				expect(/^[\x20-\x7e]*$/.test(line), JSON.stringify(line)).toBe(true);
			}
		}
	});

	it("has a size that fits eighty columns", () => {
		// The width everything else is designed against. A title screen that only
		// works on a wide terminal is a title screen most people see broken.
		expect(bannerVariants().some((variant) => variant.width <= 76)).toBe(true);
	});
});

describe("choosing a size", () => {
	function write(...blocks: string[]) {
		writeFileSync(file, blocks.join("\n---\n"));
	}

	it("takes the widest that fits", () => {
		write("WIDEWIDEWIDE", "NARROW");
		expect(bannerFor(20, file)).toEqual(["WIDEWIDEWIDE"]);
		expect(bannerFor(11, file)).toEqual(["NARROW"]);
	});

	/*
	 * The failure worth designing against. A banner one column too wide does not look
	 * like a small title — it wraps, and a wrapped banner reads as a rendering fault
	 * on the first screen anybody sees of the game.
	 */
	it("never returns art too wide for the terminal", () => {
		write("WIDEWIDEWIDE", "NARROW");
		for (let columns = 1; columns < 30; columns++) {
			for (const line of bannerFor(columns, file)) {
				if (line === PLAIN_TITLE) continue;
				expect(line.length, `${columns} columns`).toBeLessThanOrEqual(columns);
			}
		}
	});

	it("falls back to the plain words when nothing fits", () => {
		write("WIDEWIDEWIDE");
		expect(bannerFor(4, file)).toEqual([PLAIN_TITLE]);
	});

	it("falls back when the file is not there at all", () => {
		// A missing asset is not worth failing a launch over.
		expect(bannerFor(200, join(dir, "absent.txt"))).toEqual([PLAIN_TITLE]);
	});

	it("reads the sizes in any order they are written", () => {
		write("NARROW", "WIDEWIDEWIDE");
		expect(bannerFor(20, file)).toEqual(["WIDEWIDEWIDE"]);
	});

	it("treats blank lines around a block as formatting, not as art", () => {
		writeFileSync(file, "\n\nTOP\nBOTTOM\n\n");
		expect(bannerFor(20, file)).toEqual(["TOP", "BOTTOM"]);
	});
});
