import { listWindow } from "../hud-state.js";

/**
 * Laying cards out in a grid, and moving a cursor around one.
 *
 * Apart from the rendering because it is arithmetic with edges: how many cards fit,
 * which are on screen, and what the arrow keys do at the ends and on a ragged last
 * row. All of those are wrong in ways that are invisible in a screenshot of the
 * common case — a cursor that stops moving on the second-to-last card, a window
 * that scrolls one card early — and obvious in a test.
 */

/**
 * A card's preferred width and its fixed height, borders included.
 *
 * Thirty columns leaves twenty-six inside, which is what the longest line a card
 * carries needs: "played 9 minutes ago" is twenty. Six rows is two of border and
 * four of content, and every card is exactly that whatever it has to say — a grid
 * of unequal boxes reads as broken rather than as varied.
 */
export const CARD_WIDTH = 30;
export const CARD_HEIGHT = 6;

/**
 * How narrow a card may be squeezed before it stops being one.
 *
 * Twenty-six columns still holds "played 9 minutes ago" inside the border and the
 * padding. Squeezing beats not squeezing because the alternative is stark: at
 * sixty-four columns a rigid card gives one column, so the page shows a single
 * world at a time — which is worse than the list it replaced.
 */
const MIN_CARD_WIDTH = 26;

/** One column between cards, so adjacent borders do not read as one doubled line. */
export const GAP = 1;

export interface GridLayout {
	readonly columns: number;
	/** Rows of cards that fit on screen at once, not rows of cards there are. */
	readonly rows: number;
	readonly capacity: number;
	readonly cardWidth: number;
}

export function gridLayout(width: number, height: number): GridLayout {
	// Fit by the narrowest a card may be, then give each of them an equal share of
	// what is actually there — up to the preferred width, since a card stretched
	// across half a wide terminal is mostly empty box.
	const columns = Math.max(1, Math.floor((width + GAP) / (MIN_CARD_WIDTH + GAP)));
	const cardWidth = Math.max(
		MIN_CARD_WIDTH,
		Math.min(CARD_WIDTH, Math.floor((width - (columns - 1) * GAP) / columns)),
	);

	// Rows stack with no gap between them: two borders meeting is a line, and the
	// row of blank cells a gap would add costs a whole card's worth of height every
	// few rows. At least one either way — a terminal too small for a single card
	// gets one anyway and lets it truncate, which is still readable.
	const rows = Math.max(1, Math.floor(height / CARD_HEIGHT));

	return { columns, rows, capacity: columns * rows, cardWidth };
}

export type Direction = "left" | "right" | "up" | "down";

/**
 * Move the cursor, in reading order across and by a row up and down.
 *
 * Left and right flow between rows rather than stopping at the edges, because with
 * a ragged last row the alternative is a cursor that cannot reach the final card
 * from the one above it. Up and down clamp: stepping off the top is how you would
 * expect to stay put, not to wrap round to the bottom.
 *
 * Down from the last row lands on the last card rather than nowhere, so a grid with
 * three cards on its final row still lets you reach all three.
 */
export function moveInGrid(
	count: number,
	columns: number,
	from: number,
	direction: Direction,
): number {
	if (count <= 0) return 0;
	const at = Math.max(0, Math.min(from, count - 1));

	switch (direction) {
		case "left":
			return Math.max(0, at - 1);
		case "right":
			return Math.min(count - 1, at + 1);
		case "up": {
			const up = at - columns;
			return up >= 0 ? up : at;
		}
		case "down": {
			const down = at + columns;
			if (down < count) return down;
			// Already on the last row: go to its end rather than refusing to move, so a
			// short final row is still reachable from the one above.
			const lastRow = Math.floor((count - 1) / columns);
			return Math.floor(at / columns) === lastRow ? at : count - 1;
		}
	}
}

export interface GridWindow {
	/** Index of the first card on screen. */
	readonly start: number;
	/** One past the last. */
	readonly end: number;
	/** Whether anything is off screen in either direction. */
	readonly scrolled: boolean;
}

/**
 * Which cards are on screen, given where the cursor is.
 *
 * Scrolls by whole rows, never by single cards: a grid that slid one card at a time
 * would shuffle every card sideways on each keypress, which is unreadable.
 * `listWindow` already keeps a cursor roughly centred and pins the last page full,
 * so it does the work here with rows standing in for items.
 */
export function gridWindow(count: number, layout: GridLayout, cursor: number): GridWindow {
	const rowCount = Math.ceil(count / layout.columns);
	const cursorRow = Math.floor(Math.max(0, Math.min(cursor, count - 1)) / layout.columns);
	const view = listWindow(rowCount, cursorRow, layout.rows);
	return {
		start: view.start * layout.columns,
		end: Math.min(count, view.end * layout.columns),
		scrolled: rowCount > layout.rows,
	};
}
