import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { clampLine, wrapToLines } from "./text.js";

describe("wrapToLines", () => {
	it("wraps on words and never exceeds the width", () => {
		const lines = wrapToLines("the old roads still run between the holdfasts", 12, 10);
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(12);
	});

	it("never returns more lines than asked for", () => {
		const long = "word ".repeat(200);
		expect(wrapToLines(long, 20, 3)).toHaveLength(3);
	});

	it("marks the cut when something was dropped", () => {
		const lines = wrapToLines("word ".repeat(200), 20, 2);
		expect(lines.at(-1)?.endsWith("…")).toBe(true);
	});

	it("leaves text that fits completely alone", () => {
		expect(wrapToLines("A short line.", 40, 3)).toEqual(["A short line."]);
	});

	it("breaks a word longer than the panel rather than overflowing", () => {
		const lines = wrapToLines("supercalifragilistic", 6, 5);
		for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(6);
	});

	it("terminates on a long word with only one line to give", () => {
		// The break-the-word loop and the line budget have to agree, or this hangs.
		expect(() => wrapToLines("x".repeat(500), 4, 1)).not.toThrow();
		expect(wrapToLines("x".repeat(500), 4, 1)).toHaveLength(1);
	});

	it("copes with degenerate sizes instead of looping", () => {
		expect(wrapToLines("anything", 0, 3)).toEqual([]);
		expect(wrapToLines("anything", 10, 0)).toEqual([]);
		expect(wrapToLines("", 10, 3)).toEqual([]);
	});
});

describe("clampLine", () => {
	it("keeps a short line whole", () => {
		expect(clampLine("Trodden earth.", 40)).toBe("Trodden earth.");
	});

	it("cuts a long one to the column", () => {
		const line = clampLine("A painted board reads something very long indeed.", 20);
		expect(stringWidth(line)).toBeLessThanOrEqual(20);
		expect(line.endsWith("…")).toBe(true);
	});
});
