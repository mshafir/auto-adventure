import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { rgb, SGR_RESET } from "../render/color.js";
import { rampRows } from "./gradient.js";

const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };
const BLOCK = ["████████████████", "████████████████", "████████████████"];

describe("rampRows", () => {
	/*
	 * The reason this is ANSI in one string rather than a `<Text>` per character:
	 * Ink measures with `string-width`, which counts an escape sequence as nothing,
	 * so a coloured row lays out exactly like the plain one it came from. Get this
	 * wrong and the title shifts sideways relative to its own frame.
	 */
	it("changes what a row looks like and not what it measures", () => {
		const painted = rampRows(BLOCK, RAMP, "truecolor");
		for (const [index, line] of painted.entries()) {
			const plain = BLOCK[index] as string;
			expect(stripAnsi(line)).toBe(plain);
			expect(stringWidth(line)).toBe(stringWidth(plain));
		}
	});

	it("runs diagonally, so the corners differ from each other", () => {
		const painted = rampRows(BLOCK, RAMP, "truecolor");
		const first = painted[0] as string;
		const last = painted[painted.length - 1] as string;
		// A ramp that only ran across would make every row identical; one that only
		// ran down would make every row a single flat colour.
		expect(first).not.toBe(last);
		expect(new Set(first.match(/38;2;\d+;\d+;\d+/g)).size).toBeGreaterThan(1);
	});

	/*
	 * The first screen the game draws, before anything has been established about the
	 * terminal. It has to look deliberate on sixteen colours as well as on sixteen
	 * million, and leave no escapes at all where there is no colour to be had.
	 */
	it("speaks whatever the terminal can hear", () => {
		expect(rampRows(BLOCK, RAMP, "truecolor")[0]).toContain("38;2;");
		expect(rampRows(BLOCK, RAMP, "ansi256")[0]).toContain("38;5;");
		expect(rampRows(BLOCK, RAMP, "none")).toEqual(BLOCK);
		for (const line of rampRows(BLOCK, RAMP, "ansi16")) {
			expect(line).not.toContain("38;2;");
			expect(line).not.toContain("38;5;");
		}
	});

	/*
	 * Quantising is what keeps this small: neighbouring characters landing on the
	 * same step share one escape instead of each carrying its own, so a wide row
	 * costs a dozen sequences rather than one per column.
	 */
	it("does not pay for a colour change at every single character", () => {
		const wide = ["█".repeat(77)];
		const painted = rampRows(wide, RAMP, "truecolor")[0] as string;
		// Counted by splitting rather than by matching: a regex holding a raw escape
		// byte is both unreadable and rejected by the linter.
		const changes = painted.split("38;2;").length - 1;
		expect(changes).toBeGreaterThan(1);
		expect(changes).toBeLessThan(20);
	});

	it("leaves a blank row blank rather than ending it with an escape", () => {
		// The gap between two words of the title is not part of the art.
		expect(rampRows(["██", "", "██"], RAMP, "truecolor")[1]).toBe("");
	});

	it("closes every row it paints, so nothing leaks onto the next one", () => {
		for (const line of rampRows(BLOCK, RAMP, "truecolor")) {
			expect(line.endsWith(SGR_RESET)).toBe(true);
		}
	});
});
