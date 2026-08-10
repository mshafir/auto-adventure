import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { clampLine, wrapBlock, wrapToLines } from "./text.js";

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

describe("wrapping and the ellipsis", () => {
	it("does not mark a cut that did not happen", () => {
		// The old test for "did anything get dropped" compared `lines * width`
		// against the character count, which ignores the spaces wrapping removes —
		// so a journal entry that wrapped neatly onto two lines came back with a
		// trailing ellipsis and read as truncated when it was whole.
		const text = "Somebody has been taking the sluice gates apart at night.";
		const lines = wrapToLines(text, 28, 4);
		expect(lines.join(" ")).toBe(text);
		expect(lines.at(-1)?.endsWith("…")).toBe(false);
	});

	it("still marks one that did", () => {
		const text = "Somebody has been taking the sluice gates apart at night.";
		expect(wrapToLines(text, 28, 1).at(-1)?.endsWith("…")).toBe(true);
	});

	it("keeps every word when there is room for them", () => {
		const text = "the old roads still run between the holdfasts";
		expect(wrapToLines(text, 12, 10).join(" ")).toBe(text);
	});
});

/**
 * A document rather than a paragraph.
 *
 * `wrapToLines` splits on `\s+`, which folds every newline into a space. That is right
 * for a quest description and wrong for a prompt, which is a structured document —
 * headed sections, one fact per line, a numbered list of a town's buildings. Read back
 * as one flowed paragraph it is unreadable, which defeats the point of keeping it.
 */
describe("wrapping a whole document", () => {
	it("keeps the line breaks it was given", () => {
		expect(wrapBlock("one\ntwo\nthree", 20)).toEqual(["one", "two", "three"]);
	});

	it("keeps blank lines, which are what separate its sections", () => {
		expect(wrapBlock("head\n\nbody", 20)).toEqual(["head", "", "body"]);
	});

	it("wraps a long line without joining it to the next one", () => {
		const lines = wrapBlock("the old roads still run between the holdfasts\nnext", 20);
		expect(lines.at(-1)).toBe("next");
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
	});

	it("breaks a word too long for the column rather than overflowing", () => {
		// A hallucinated id or a URL in an answer. Left alone it would push the frame
		// wider than the terminal, which Ink resolves by mangling the whole row.
		for (const line of wrapBlock("x".repeat(50), 12)) {
			expect(line.length).toBeLessThanOrEqual(12);
		}
	});

	it("returns everything, because the caller is the one scrolling", () => {
		// Unbounded on purpose: the reader needs the total to say "40 of 380" and to
		// know where the bottom is.
		expect(
			wrapBlock(Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"), 20),
		).toHaveLength(200);
	});
});
