import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { renderInk } from "../../../test/harness/ink.js";
import type { TerrainSummary } from "../../core/gen/pipeline.js";
import { hashString } from "../../core/rand/hash.js";
import { createInitialState, type GameState } from "../../core/rules/state.js";
import type { Weather } from "../../core/world/weather.js";
import { TOP_BAR_ROWS, TopBar } from "./top-bar.js";

const WORLD = {
	id: "t",
	name: "T",
	seed: hashString("top-bar"),
	createdAt: "2026-01-01T00:00:00.000Z",
};

function stateAt(x: number, y: number, hour: number, minute: number): GameState {
	const base = createInitialState(WORLD, { x, y });
	return { ...base, time: { ...base.time, hour, minute } };
}

const SUMMARY = {
	biomeCounts: { grassland: 2048, forest: 1024, marsh: 512 },
} as unknown as TerrainSummary;

const WEATHER = { description: "Rain, and no sign of it stopping." } as unknown as Weather;

/**
 * `renderInk` rather than `ink-testing-library`, which hardcodes 100 columns —
 * so a bar told it has 120 came back truncated by the harness rather than by
 * anything under test.
 */
function lines(width: number, props: Partial<Parameters<typeof TopBar>[0]> = {}): string[] {
	const { lastFrame, unmount } = renderInk(
		<TopBar state={stateAt(165, 35, 8, 7)} width={width} {...props} />,
		{ columns: width, rows: 24 },
	);
	const out = (lastFrame() ?? "").split("\n").map((line) => stripAnsi(line));
	unmount();
	return out;
}

describe("TopBar", () => {
	it("takes the rows it says it does", () => {
		expect(lines(120)).toHaveLength(TOP_BAR_ROWS);
	});

	/*
	 * Ink trims trailing whitespace off every line it emits, so a bar padded out
	 * with spaces comes back short — and the app asserts every row of the frame is
	 * the same width, because one column of disagreement tears the map. Ending on
	 * the position is what makes the row end on a character.
	 */
	it("fills its width exactly, at any width", () => {
		for (const width of [40, 60, 80, 100, 120, 163]) {
			const [row] = lines(width, {
				placeName: "Ash Crest",
				summary: SUMMARY,
				weather: WEATHER,
				light: "dawn",
			});
			expect(stringWidth(row ?? ""), `${width} columns`).toBe(width);
		}
	});

	it("shows where you are, when it is, and where you are standing", () => {
		const [row] = lines(120, { placeName: "Ash Crest" });
		expect(row).toContain("Ash Crest");
		// Zero-padded, so the column never jumps as the digits change.
		expect(row).toContain("08:07");
		expect(row).toContain("day 1");
		expect(row?.trimEnd()).toMatch(/165, 35$/);
	});

	it("says something rather than nothing when the place has no name", () => {
		const [row] = lines(120);
		expect(row).toContain("The wilds");
	});

	it("names the ground under you", () => {
		const [row] = lines(160, { summary: SUMMARY });
		expect(row).toContain("50%");
		// Only the two it is mostly made of; a third is noise at this width.
		expect(row).toContain("25%");
		expect(row).not.toContain("12%");
	});

	/*
	 * Every row here is a row the map does not get, so it is one row at any width
	 * and drops pieces rather than wrapping. Overflow is the dangerous direction:
	 * one column too many makes Ink wrap the row, which pushes the whole map down.
	 */
	it("stays one row wide at any width, dropping what will not fit", () => {
		for (const width of [40, 60, 80, 100, 120, 163]) {
			const rows = lines(width, {
				placeName: "Ash Crest",
				summary: SUMMARY,
				weather: WEATHER,
				light: "dawn",
			});
			expect(rows, `${width} columns`).toHaveLength(TOP_BAR_ROWS);
			for (const row of rows) {
				expect(stringWidth(row), `${width} columns`).toBeLessThanOrEqual(width);
			}
		}
	});

	// The place and the clock always survive; the ground summary is the first
	// thing to go, because it is the one piece the map itself already tells you.
	it("keeps the place and the clock when it has to drop the rest", () => {
		const [row] = lines(44, {
			placeName: "Ash Crest",
			summary: SUMMARY,
			weather: WEATHER,
			light: "dawn",
		});
		expect(row).toContain("Ash Crest");
		expect(row).toContain("08:07");
		expect(row).not.toContain("grassland");
	});
});
