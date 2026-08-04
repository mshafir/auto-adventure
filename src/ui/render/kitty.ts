/**
 * The kitty graphics protocol, as much of it as a tile renderer needs.
 *
 * Two facts about Ink decide the whole shape of this file, both measured rather
 * than assumed:
 *
 *  - `string-width` reports **1** for U+10EEEE, the Unicode placeholder, and 0
 *    for its combining diacritics. So a grid of placeholders is ordinary text
 *    as far as Ink's layout is concerned, and log-update erases and repaints it
 *    like any other row.
 *  - `string-width` reports **24** for an APC graphics escape. So image data can
 *    never go inline in a `<Text>`: Ink would lay the row out 24 columns too
 *    wide and the map would shear. It has to ride out of band.
 *
 * Hence the split here between {@link transmitFrame}, which is bytes the
 * terminal eats silently, and {@link placeholderRows}, which is text Ink owns.
 * The viewport attaches the former to the latter with Ink's `Transform`, which
 * rewrites a line's final output without touching the layout computed from it.
 *
 * One image is retransmitted per frame rather than a tileset being placed per
 * cell. That is not laziness: every tile's colour already carries lighting,
 * tint, relief, shadow and field of view by the time the compositor is done, so
 * a static tileset would need re-uploading for every combination of terrain and
 * light level. Compositing to one image keeps all of that per-frame work exactly
 * where it already is.
 */
import { deflateSync } from "node:zlib";

/**
 * A fixed image id. The frame is replaced in place every render, so exactly one
 * image ever exists and nothing needs to be freed.
 *
 * Deliberately not 1: ids are global to the terminal and a low number is what
 * every other program picks, so a stale placement from a crashed neighbour can
 * otherwise show through.
 */
export const FRAME_IMAGE_ID = 0x61_64_76;

/** U+10EEEE. Every cell showing part of the image is one of these. */
export const PLACEHOLDER = String.fromCodePoint(0x10_ee_ee);

/**
 * Row and column diacritics, in the order the protocol assigns them.
 *
 * The full table is 297 entries; this is the prefix, which covers viewports up
 * to 64 cells on a side. `encodeCell` throws rather than silently wrapping past
 * the end, because a wrapped index draws the wrong slice of the image and is
 * very hard to recognise as an off-by-one on screen.
 */
const DIACRITICS: readonly number[] = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c,
	0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
	0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592,
	0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
	0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
	0x0616, 0x0617, 0x0657, 0x0658,
];

export const MAX_PLACEHOLDER_INDEX = DIACRITICS.length;

const ESC = "";
const APC = `${ESC}_G`;
const ST = `${ESC}\\`;

/** Payload bytes per chunk. The protocol caps an escape's payload at 4096. */
const CHUNK = 4096;

export interface FrameSpec {
	/** Raw RGB, three bytes per pixel, row-major. */
	readonly rgb: Buffer;
	readonly width: number;
	readonly height: number;
	/** Cell rectangle the image should fill. The terminal scales to fit. */
	readonly columns: number;
	readonly rows: number;
	readonly imageId?: number;
}

/**
 * Escape sequences that upload one frame and create a virtual placement for it.
 *
 * `q=2` suppresses the terminal's acknowledgements. That is not tidiness: Ink
 * puts stdin in raw mode and reads it for keys, so an unsolicited reply would
 * arrive as garbage keystrokes and the player would see the map twitch as their
 * character walked somewhere they did not ask for.
 *
 * `o=z` sends the pixels zlib-compressed. Tile art is flat colour in large runs,
 * which deflates to a small fraction of its raw size — the difference between a
 * frame that fits down a slow link and one that does not.
 *
 * `U=1` makes the placement *virtual*: it draws nothing by itself and appears
 * only where a placeholder cell references it. That is what lets Ink decide
 * where the map goes, rather than the escape landing wherever the cursor was.
 */
export function transmitFrame(spec: FrameSpec): string {
	const id = spec.imageId ?? FRAME_IMAGE_ID;
	const payload = deflateSync(spec.rgb).toString("base64");

	const control = [
		"a=T", // transmit and display
		"f=24", // 24-bit RGB
		"o=z", // zlib-compressed payload
		"q=2", // stay silent
		"U=1", // virtual placement, shown via placeholders
		`i=${id}`,
		`s=${spec.width}`,
		`v=${spec.height}`,
		`c=${spec.columns}`,
		`r=${spec.rows}`,
	].join(",");

	if (payload.length <= CHUNK) {
		return `${APC}${control},m=0;${payload}${ST}`;
	}

	// Only the first chunk carries the control data; the rest carry just `m`.
	let out = `${APC}${control},m=1;${payload.slice(0, CHUNK)}${ST}`;
	for (let at = CHUNK; at < payload.length; at += CHUNK) {
		const slice = payload.slice(at, at + CHUNK);
		const more = at + CHUNK < payload.length ? 1 : 0;
		out += `${APC}m=${more};${slice}${ST}`;
	}
	return out;
}

/** Free the frame image. Call on the way out so nothing is left in the terminal. */
export function deleteFrame(imageId = FRAME_IMAGE_ID): string {
	return `${APC}a=d,d=I,q=2,i=${imageId}${ST}`;
}

/**
 * One placeholder cell: the code point, plus diacritics naming which row and
 * column of the image it shows.
 */
export function encodeCell(row: number, column: number): string {
	const r = DIACRITICS[row];
	const c = DIACRITICS[column];
	if (r === undefined || c === undefined) {
		throw new Error(
			`kitty placeholder index out of range (row ${row}, column ${column}); ` +
				`the diacritic table covers 0..${DIACRITICS.length - 1}`,
		);
	}
	return PLACEHOLDER + String.fromCodePoint(r) + String.fromCodePoint(c);
}

/**
 * The image id, carried as a foreground colour.
 *
 * The protocol has no other channel for it on a placeholder cell, so the cell's
 * fg is read as a 24-bit number rather than as a colour. Nothing is actually
 * drawn in it — the image covers the cell.
 */
export function imageIdSequence(imageId = FRAME_IMAGE_ID): string {
	const r = (imageId >> 16) & 0xff;
	const g = (imageId >> 8) & 0xff;
	const b = imageId & 0xff;
	return `${ESC}[38;2;${r};${g};${b}m`;
}

export interface PlaceholderOptions {
	/**
	 * Name every cell's row and column explicitly rather than letting the
	 * terminal continue a run. Explicit is the safe default: continuation is the
	 * part of the spec terminals differ most on, and a wrong guess draws a
	 * plausible-looking but scrambled map.
	 */
	readonly explicit?: boolean;
	readonly imageId?: number;
}

/**
 * The rows of placeholder text that display a transmitted frame.
 *
 * Returned as one string per terminal row, to be handed to Ink as `<Text>`
 * exactly like the glyph renderer's encoded rows.
 */
export function placeholderRows(
	columns: number,
	rows: number,
	options: PlaceholderOptions = {},
): string[] {
	const explicit = options.explicit ?? true;
	const prefix = imageIdSequence(options.imageId);
	const out: string[] = [];

	for (let row = 0; row < rows; row++) {
		let line = prefix;
		for (let column = 0; column < columns; column++) {
			// Without diacritics the terminal continues from the previous cell, so
			// only the first of a run has to say where it is.
			line += explicit || column === 0 ? encodeCell(row, column) : PLACEHOLDER;
		}
		out.push(`${line}${ESC}[0m`);
	}
	return out;
}

/**
 * Does this terminal implement the graphics protocol?
 *
 * Environment sniffing rather than a device query. A query means writing to the
 * terminal and reading the reply off stdin, and stdin belongs to Ink — a reply
 * that arrives a moment late is indistinguishable from the player typing. The
 * cost of guessing wrong is only that a capable terminal renders glyphs, which
 * is a working game either way.
 *
 * `TILE_MODE` overrides in both directions, so a terminal this does not know
 * about can still be asked to try.
 */
export function detectKittyGraphics(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.TERM_PROGRAM === "ghostty" || env.GHOSTTY_RESOURCES_DIR) return true;
	if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return true;
	if (env.TERM_PROGRAM === "WezTerm" || env.WEZTERM_EXECUTABLE) return true;
	return false;
}

/**
 * Multiplexers pass most escapes through but not this one, or not reliably.
 * Under tmux an unhandled APC sequence is printed rather than eaten, which
 * fills the map with base64.
 */
export function graphicsBlockedByMultiplexer(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.TMUX) || (env.TERM ?? "").startsWith("screen");
}
