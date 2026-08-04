import type { Cell } from "./compose.js";

/**
 * Widen a composed scene horizontally.
 *
 * A terminal cell is about twice as tall as it is wide, so one tile per cell
 * renders the world stretched 2:1 vertically — a round town comes out as a tall
 * ellipse. Drawing each tile two columns wide makes the pixels square again, at
 * the cost of showing half as much world for the same terminal width.
 *
 * What goes in the extra column is the whole question, so it is a choice rather
 * than a default.
 */
export type FillMode =
	/** Repeat the glyph. Right for area fills, wrong for anything with a shape. */
	| "dup"
	/** Leave it blank, keeping the background. Never wrong, often sparse. */
	| "pad"
	/** Per-glyph: continue lines, repeat fills, pad the rest. */
	| "smart";

/**
 * What to draw to the right of a glyph in `smart` mode.
 *
 * Box-drawing needs this most. A wall corner is a *shape*, so `┏` repeated is
 * two corners and `┏` padded is a broken wall; the only reading that survives
 * doubling is `┏━` — the corner, then the line it was already carrying east.
 * Glyphs absent from this table pad, which is the safe default.
 */
const CONTINUATION: Readonly<Record<string, string>> = {
	// Heavy box: stone and timber walls. Continue only where an east arm exists.
	"╺": "━",
	"┗": "━",
	"┏": "━",
	"┣": "━",
	"━": "━",
	"┻": "━",
	"┳": "━",
	"╋": "━",
	// Light box: fences and rails.
	"╶": "─",
	"└": "─",
	"┌": "─",
	"├": "─",
	"─": "─",
	"┴": "─",
	"┬": "─",
	"┼": "─",
	// Double box: bridges and formal stonework.
	"╞": "═",
	"╚": "═",
	"╔": "═",
	"╠": "═",
	"═": "═",
	"╩": "═",
	"╦": "═",
	"╬": "═",
	// Area fills have no shape to preserve, so they simply repeat.
	"░": "░",
	"▒": "▒",
	"▓": "▓",
	"█": "█",
	"~": "~",
	"≈": "≈",
	" ": " ",
};

/**
 * Sparse texture: single specks of grass, gravel, flowers, crops, reeds.
 *
 * These are the awkward case. Repeating them doubles the apparent density of a
 * meadow; always drawing them in the left column of the pair lines every speck
 * up into vertical stripes, which is an artifact the 1x view does not have. So
 * `smart` keeps one speck per tile but alternates which column it lands in,
 * which reads as scatter again.
 *
 * Deliberately excludes letters, `@` and other entity glyphs: alternating those
 * by position would make a person appear to wobble left and right as they walk.
 */
const TEXTURE: ReadonlySet<string> = new Set([
	",",
	".",
	"'",
	":",
	"·",
	"*",
	'"',
	"!",
	"|",
	"=",
	"-",
	"≡",
]);

/** The glyph to place in the columns after `cell`, given the fill mode. */
function continuationFor(ch: string, mode: FillMode): string {
	switch (mode) {
		case "dup":
			return ch;
		case "pad":
			return " ";
		case "smart":
			return CONTINUATION[ch] ?? " ";
	}
}

/**
 * Repeat every cell `scale` times across, filling the added columns per `mode`.
 *
 * The background always carries across, whatever the mode: a road or a shadow is
 * a property of the ground, so letting it stop halfway through a tile would
 * undo the very thing the extra width is meant to buy.
 */
export function expandRow(cells: readonly Cell[], scale: number, mode: FillMode, row = 0): Cell[] {
	if (scale <= 1) return [...cells];
	const out: Cell[] = new Array(cells.length * scale);
	let i = 0;
	for (let col = 0; col < cells.length; col++) {
		const cell = cells[col] as Cell;

		// One speck per tile, but not always in the same column, so a meadow reads
		// as scatter rather than as pinstripes.
		if (mode === "smart" && TEXTURE.has(cell.ch)) {
			const slot = (col + row) % scale;
			for (let n = 0; n < scale; n++) {
				out[i++] = n === slot ? cell : { ...cell, ch: " " };
			}
			continue;
		}

		out[i++] = cell;
		const ch = continuationFor(cell.ch, mode);
		for (let n = 1; n < scale; n++) {
			// Same style, so the row encoder still collapses the pair into one run.
			out[i++] = { ...cell, ch };
		}
	}
	return out;
}

export function expandScene(
	rows: readonly (readonly Cell[])[],
	scale: number,
	mode: FillMode,
): Cell[][] {
	return rows.map((row, y) => expandRow(row, scale, mode, y));
}
