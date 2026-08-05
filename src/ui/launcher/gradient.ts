import {
	type ColorDepth,
	fgSequence,
	mix,
	type RGB,
	SGR_RESET,
	sameColor,
} from "../render/color.js";

/**
 * Pour a colour ramp across a block of text.
 *
 * The title is one image made of characters, so it should be coloured like an
 * image rather than a line at a time: the ramp runs diagonally across the whole
 * block, which is what makes the letters read as one object catching the light
 * instead of five independently tinted rows.
 *
 * Encoded as ANSI into one string per row rather than as a `<Text>` per
 * character. Seventy-seven elements a row would be seventy-seven Yoga nodes, and
 * this is the same trick `ansi.ts` uses for the map: Ink measures with
 * `string-width`, which counts escape sequences as nothing, so a pre-coloured row
 * lays out exactly like a plain one.
 *
 * `depth` is honoured rather than assumed. This is the first screen the game
 * draws — before anything has been asked of the terminal — so it has to look
 * deliberate on sixteen colours as well as on sixteen million.
 */

export interface Ramp {
	readonly from: RGB;
	readonly to: RGB;
}

/**
 * How many distinct colours the ramp is allowed.
 *
 * Quantising is what keeps the output small: neighbouring characters that land on
 * the same step share one escape sequence instead of each carrying their own, so a
 * 77-column row costs a dozen sequences rather than seventy-seven. Twelve steps is
 * past the point where the banding is visible at this size.
 */
const STEPS = 12;

/**
 * Colour a block of lines, returning one ANSI string per line.
 *
 * Blank rows come back blank: a gap between two words of the title is not part of
 * the art, and colouring it would leave a trailing escape on an empty line.
 */
export function rampRows(
	lines: readonly string[],
	ramp: Ramp,
	depth: ColorDepth,
): readonly string[] {
	if (depth === "none") return [...lines];

	const width = Math.max(1, ...lines.map((line) => line.length));
	const height = Math.max(1, lines.length);

	return lines.map((line, row) => {
		if (line.trim() === "") return line;

		let out = "";
		let current: RGB | null = null;
		for (let column = 0; column < line.length; column++) {
			// Diagonal rather than down or across: a ramp that only runs one way looks
			// like a gradient applied to text, and one that runs both looks like light
			// falling on it.
			const t = (column / width + row / height) / 2;
			const stepped = Math.round(t * STEPS) / STEPS;
			const colour = mix(ramp.from, ramp.to, stepped);
			if (!sameColor(current, colour)) {
				out += fgSequence(colour, depth);
				current = colour;
			}
			out += line[column];
		}
		return `${out}${SGR_RESET}`;
	});
}
