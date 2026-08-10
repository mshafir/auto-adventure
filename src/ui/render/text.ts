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

	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	let index = 0;

	while (index < words.length && lines.length < maxLines) {
		const word = words[index];
		if (word === undefined) break;

		if (current.length === 0) {
			// A single word longer than the panel is rare but must not loop or
			// overflow; break it at the column and carry the remainder.
			if (stringWidth(word) > width) {
				lines.push(word.slice(0, width));
				words[index] = word.slice(width);
				continue;
			}
			current = word;
		} else if (stringWidth(`${current} ${word}`) <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = "";
			// Retry the same word against the fresh line.
			continue;
		}
		index++;
	}
	if (lines.length < maxLines && current.length > 0) {
		lines.push(current);
		current = "";
	}

	// Whether anything was dropped is decided by what is left over, not by
	// comparing character counts against `lines.length * width`: that arithmetic
	// ignores the spaces wrapping removes, so a passage that fitted exactly came
	// back with a trailing ellipsis and looked cut when it was whole.
	if (index >= words.length && current.length === 0) return lines;

	const last = lines[lines.length - 1];
	if (last !== undefined) {
		lines[lines.length - 1] = `${last.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
	}
	return lines;
}

/** One line, cut at the column, with an ellipsis when it did not fit. */
export function clampLine(text: string, width: number): string {
	return wrapToLines(text, width, 1)[0] ?? "";
}

/**
 * Wrap a whole document, keeping the line breaks it came with.
 *
 * The difference from {@link wrapToLines} is the only thing that matters about it:
 * that one splits on `\s+`, which folds every newline into a space. That is right for
 * a quest description and catastrophic for a prompt, which is a structured document —
 * headed sections, one fact per line, a numbered list of the buildings a town has.
 * Read back as a single flowed paragraph it is unreadable, which defeats the point of
 * being able to read it.
 *
 * Unbounded, because the caller is scrolling: it needs to know how many lines there
 * are in order to say `40/380` and to stop at the bottom.
 */
export function wrapBlock(text: string, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	// Tabs, because a prompt assembled from JSON is full of them and a tab in a
	// fixed-width cell grid is a hole of unpredictable size.
	for (const source of text.replace(/\t/g, "  ").split("\n")) {
		if (source.trim().length === 0) {
			lines.push("");
			continue;
		}
		let current = "";
		for (let word of source.split(" ")) {
			// A single word wider than the column — a URL, a long id — is broken at the
			// column rather than allowed to overflow the frame.
			while (stringWidth(word) > width) {
				if (current.length > 0) {
					lines.push(current);
					current = "";
				}
				lines.push(word.slice(0, width));
				word = word.slice(width);
			}
			if (current.length === 0) current = word;
			else if (stringWidth(`${current} ${word}`) <= width) current = `${current} ${word}`;
			else {
				lines.push(current);
				current = word;
			}
		}
		lines.push(current);
	}
	return lines;
}
