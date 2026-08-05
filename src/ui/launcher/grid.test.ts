import { describe, expect, it } from "vitest";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	GAP,
	type GridLayout,
	gridLayout,
	gridWindow,
	moveInGrid,
} from "./grid.js";

const layout = (columns: number, rows = 3): GridLayout => ({
	columns,
	rows,
	capacity: columns * rows,
	cardWidth: CARD_WIDTH,
});

describe("gridLayout", () => {
	it("fits as many cards across as the width allows, counting the gaps", () => {
		// Three cards need three widths and two gaps, not three of each.
		expect(gridLayout(3 * CARD_WIDTH + 2 * GAP, 100).columns).toBe(3);
		expect(gridLayout(3 * CARD_WIDTH + 2 * GAP, 100).cardWidth).toBe(CARD_WIDTH);
	});

	it("fits as many down as the height allows", () => {
		// Rows stack with no gap: two borders meeting is a line, and a blank row every
		// few cards costs a whole card's worth of height.
		expect(gridLayout(200, 2 * CARD_HEIGHT).rows).toBe(2);
		expect(gridLayout(200, 3 * CARD_HEIGHT - 1).rows).toBe(2);
		expect(gridLayout(200, 3 * CARD_HEIGHT).rows).toBe(3);
	});

	/*
	 * The alternative was stark: at sixty-four columns a rigid card gave one column
	 * and one row, so the page showed a single world at a time — worse than the list
	 * it replaced.
	 */
	it("squeezes the cards rather than dropping to one column", () => {
		// Fifty-eight columns is an inch short of two full-width cards.
		const tight = gridLayout(58, 100);
		expect(tight.columns).toBe(2);
		expect(tight.cardWidth).toBeLessThan(CARD_WIDTH);
		expect(tight.columns * tight.cardWidth + GAP).toBeLessThanOrEqual(58);
	});

	it("never asks for more room than it was given", () => {
		for (let width = 10; width < 200; width += 3) {
			for (let height = 6; height < 60; height += 3) {
				const grid = gridLayout(width, height);
				const used = grid.columns * grid.cardWidth + (grid.columns - 1) * GAP;
				// One card always gets laid out, even where one does not fit; past that
				// the grid must stay inside its box.
				if (grid.columns > 1) expect(used, `${width}x${height}`).toBeLessThanOrEqual(width);
				if (grid.rows > 1) {
					expect(grid.rows * CARD_HEIGHT, `${width}x${height}`).toBeLessThanOrEqual(height);
				}
			}
		}
	});

	/*
	 * A terminal too small for one card gets one anyway, truncated. Showing nothing
	 * would leave a page that says "Continue" over an empty box, which reads as the
	 * saves having been lost.
	 */
	it("never lays out nothing", () => {
		const tiny = gridLayout(1, 1);
		expect(tiny.columns).toBe(1);
		expect(tiny.rows).toBe(1);
		expect(tiny.capacity).toBe(1);
	});
});

describe("moveInGrid", () => {
	// Eleven cards over three columns: three full rows and a short last one.
	const COUNT = 11;
	const COLUMNS = 3;
	const move = (from: number, direction: Parameters<typeof moveInGrid>[3]) =>
		moveInGrid(COUNT, COLUMNS, from, direction);

	it("steps across in reading order, and down by a row", () => {
		expect(move(0, "right")).toBe(1);
		expect(move(1, "left")).toBe(0);
		expect(move(0, "down")).toBe(3);
		expect(move(3, "up")).toBe(0);
	});

	/*
	 * Left and right flow between rows rather than stopping at the edges. With a
	 * ragged last row the alternative is a card that cannot be reached: card 10 is
	 * alone under card 7, so right-from-9 is the only way onto it from its left.
	 */
	it("wraps between rows going across, so a ragged row stays reachable", () => {
		expect(move(2, "right")).toBe(3);
		expect(move(3, "left")).toBe(2);
		expect(move(9, "right")).toBe(10);
	});

	it("stays put at the ends rather than wrapping round", () => {
		expect(move(0, "left")).toBe(0);
		expect(move(COUNT - 1, "right")).toBe(COUNT - 1);
		expect(move(1, "up")).toBe(1);
	});

	/*
	 * Down from the last row lands on the last card. Card 8 has nothing directly
	 * under it — the last row is 9 and 10 — and refusing to move would make the
	 * bottom-right of the grid feel stuck.
	 */
	it("reaches the short last row from the row above it", () => {
		expect(move(8, "down")).toBe(10);
		expect(move(6, "down")).toBe(9);
		// Already on the last row: nothing below, so stay.
		expect(move(10, "down")).toBe(10);
	});

	it("survives an out-of-range cursor and an empty list", () => {
		expect(move(99, "left")).toBe(COUNT - 2);
		expect(moveInGrid(0, 3, 0, "down")).toBe(0);
	});
});

describe("gridWindow", () => {
	it("shows everything when everything fits", () => {
		const view = gridWindow(6, layout(3, 3), 0);
		expect(view).toEqual({ start: 0, end: 6, scrolled: false });
	});

	/*
	 * Scrolls by whole rows, never by single cards. A grid that slid one card at a
	 * time would shuffle every card sideways on each keypress, which is unreadable.
	 */
	it("scrolls by whole rows", () => {
		const grid = layout(3, 2);
		for (let cursor = 0; cursor < 12; cursor++) {
			const view = gridWindow(12, grid, cursor);
			expect(view.start % grid.columns, `cursor ${cursor}`).toBe(0);
			expect(view.end - view.start).toBeLessThanOrEqual(grid.capacity);
		}
	});

	it("keeps the cursor on screen wherever it is", () => {
		const grid = layout(3, 2);
		for (let cursor = 0; cursor < 12; cursor++) {
			const view = gridWindow(12, grid, cursor);
			expect(cursor, `cursor ${cursor}`).toBeGreaterThanOrEqual(view.start);
			expect(cursor, `cursor ${cursor}`).toBeLessThan(view.end);
		}
	});

	it("fills the last page rather than trailing off into blank rows", () => {
		const view = gridWindow(12, layout(3, 2), 11);
		expect(view.end).toBe(12);
		expect(view.end - view.start).toBe(6);
	});

	it("never runs past the end on a ragged last row", () => {
		const view = gridWindow(11, layout(3, 2), 10);
		expect(view.end).toBe(11);
	});

	it("says whether anything is off screen, so the page can mention it", () => {
		expect(gridWindow(6, layout(3, 2), 0).scrolled).toBe(false);
		expect(gridWindow(7, layout(3, 2), 0).scrolled).toBe(true);
	});
});
