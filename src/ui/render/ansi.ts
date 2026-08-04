import {
	bgSequence,
	type ColorDepth,
	fgSequence,
	type RGB,
	SGR_RESET,
	sameColor,
} from "./color.js";
import type { Cell } from "./compose.js";

const BOLD_ON = "\u001B[1m";
const DIM_ON = "\u001B[2m";

/**
 * Encode one row of cells into a single styled string.
 *
 * Style changes are run-length encoded: an SGR sequence is emitted only when
 * the style actually differs from the previous cell, which for typical terrain
 * collapses a 120-cell row into a handful of escapes. The alternative — styling
 * every cell independently, as one React element per cell did — costs both
 * bytes on the wire and a Yoga layout node per character.
 */
export function encodeRow(cells: readonly Cell[], depth: ColorDepth): string {
	if (depth === "none") {
		return cells.map((c) => c.ch).join("");
	}

	let out = "";
	let curFg: RGB | null = null;
	let curBg: RGB | null = null;
	let curBold = false;
	let curDim = false;

	for (const cell of cells) {
		// Bold and dim can only be cleared by a full reset, so any downgrade
		// forces one and invalidates the cached colours.
		if ((curBold && !cell.bold) || (curDim && !cell.dim)) {
			out += SGR_RESET;
			curFg = null;
			curBg = null;
			curBold = false;
			curDim = false;
		}
		if (cell.bold && !curBold) {
			out += BOLD_ON;
			curBold = true;
		}
		if (cell.dim && !curDim) {
			out += DIM_ON;
			curDim = true;
		}
		if (!sameColor(curFg, cell.fg)) {
			out += fgSequence(cell.fg, depth);
			curFg = cell.fg;
		}
		if (!sameColor(curBg, cell.bg)) {
			out += bgSequence(cell.bg, depth);
			curBg = cell.bg;
		}
		out += cell.ch;
	}

	// Always reset: a trailing background would otherwise bleed across the rest
	// of the terminal line and into whatever Ink draws beside the viewport.
	return out.length > 0 ? `${out}${SGR_RESET}` : "";
}

export function encodeScene(rows: readonly (readonly Cell[])[], depth: ColorDepth): string[] {
	return rows.map((row) => encodeRow(row, depth));
}
