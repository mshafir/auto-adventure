import stringWidth from "string-width";

/**
 * Fit prose into a fixed number of lines.
 *
 * Panels in this game have fixed heights, because a panel that grows with its
 * content can push the whole frame to the height of the terminal — at which
 * point Ink stops updating incrementally and clears the entire screen on every
 * keypress, which the player sees as flicker. Clamping here is what lets the
 * layout be fixed without Ink clipping the text into nonsense.
 *
 * Greedy wrapping on spaces, measured with `string-width` so an escape sequence
 * or a wide glyph cannot make a line overflow by a column.
 */
export function wrapToLines(text: string, width: number, maxLines: number): string[] {
	if (width <= 0 || maxLines <= 0) return [];

	const lines: string[] = [];
	let current = "";

	const push = () => {
		lines.push(current);
		current = "";
	};

	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (current.length === 0) {
			current = word;
		} else if (stringWidth(`${current} ${word}`) <= width) {
			current = `${current} ${word}`;
		} else {
			push();
			if (lines.length >= maxLines) break;
			current = word;
		}

		// A single word longer than the panel is rare but must not loop or
		// overflow; break it at the column and carry the remainder.
		while (stringWidth(current) > width) {
			lines.push(current.slice(0, width));
			current = current.slice(width);
			if (lines.length >= maxLines) break;
		}
		if (lines.length >= maxLines) break;
	}

	if (current.length > 0 && lines.length < maxLines) push();
	if (lines.length <= maxLines && lines.length * width >= visibleLength(text)) return lines;

	// Something was dropped, so say so rather than ending mid-sentence.
	const clipped = lines.slice(0, maxLines);
	const last = clipped[clipped.length - 1];
	if (last !== undefined) {
		clipped[clipped.length - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
	}
	return clipped;
}

function visibleLength(text: string): number {
	return stringWidth(text.trim());
}

/** One line, cut at the column, with an ellipsis when it did not fit. */
export function clampLine(text: string, width: number): string {
	return wrapToLines(text, width, 1)[0] ?? "";
}
