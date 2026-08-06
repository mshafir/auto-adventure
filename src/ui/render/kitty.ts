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
 * Hence the split here between {@link transmitFrame}, which is bytes written
 * straight to the stream, and {@link placeholderRows}, which is text Ink owns
 * and lays out. Smuggling the former into the latter does not work: Ink builds
 * each screen row from the map and the side panel together, so an oversized
 * line pushes the panel out of place and paints over it.
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
 * A fixed image id, deleted and re-uploaded every frame so exactly one image
 * and one placement exist at a time.
 *
 * Deliberately not 1: ids are global to the terminal and a low number is what
 * every other program picks, so a stale placement from a crashed neighbour can
 * otherwise show through.
 */
export const FRAME_IMAGE_ID = 0x61_64_76;

/**
 * A different id for the diagnostic tool.
 *
 * Sharing one with the game cost a whole debugging round. A leftover test
 * pattern stayed resident under the shared id, so when the game's own upload
 * did not land, its placeholders resolved against the *test* image and drew
 * slices of it — which reads as the game rendering badly rather than as the
 * game not uploading at all.
 */
export const CHECK_IMAGE_ID = 0x61_64_77;

/** U+10EEEE. Every cell showing part of the image is one of these. */
export const PLACEHOLDER = String.fromCodePoint(0x10_ee_ee);

/**
 * Row and column diacritics, in the order the protocol assigns them.
 *
 * The full table is 297 entries and this is only the first 64, which is a
 * deliberate limit rather than an unfinished one. The values are a fixed list
 * the protocol defines, not a range that can be computed, and a wrong entry
 * does not fail — it silently draws the wrong slice of the image, which is
 * miserable to recognise as an off-by-one. So the table stops where it is
 * trustworthy, and {@link placeholderRows} is built to need only as many
 * entries as the viewport has *rows*, which is comfortably inside it.
 *
 * A viewport is far wider than 64 columns, which is exactly how this limit was
 * found. Columns are handled by continuation instead.
 *
 * The first thirty entries are Combining Diacritical Marks, which every text
 * measurer agrees are zero-width. The rest — Cyrillic, Hebrew, Arabic — are
 * nonspacing marks that `string-width` reports as **one column wide** when asked
 * about them on their own, which is how Ink asks. See
 * {@link PLACEHOLDER_LAYOUT_SLACK}; the entries are still correct for the
 * protocol, so they are kept.
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

/**
 * How many columns wider than it draws a row of placeholders can *measure*.
 *
 * One, and the layout has to allow for it, or a tall map tears in half.
 *
 * Ink lays a `<Text>` out with `wrap-ansi`, which walks a long unbroken run one
 * character at a time and adds up `string-width` per character. On a whole row
 * `string-width` is right — the mark joins its placeholder into one grapheme of
 * width 1 — but on the bare mark it is not: the first thirty entries above are
 * Combining Diacritical Marks and measure 0, while everything from `U+0483`
 * onward measures **1**. So a row anchored with entry 30 or later adds up to one
 * column more than it occupies, and `wrap-ansi` folds its last cell onto the next
 * line.
 *
 * Which is exactly what a tall terminal looked like: fine to row 29, and from row
 * 30 down every map row split into 162 cells and a stray 1, with the shell's
 * scrollback showing through the gaps. Measured, not guessed — `wrap-ansi` at 163
 * gives `162 + 1` for entry 30 and a whole row for entry 29.
 *
 * The bytes were never wrong; only the measurement was. So the fix is to give the
 * layout the width it thinks it needs rather than to change what is emitted — a
 * row that renders correctly at index 20 renders correctly at index 40, because
 * it is the same sequence with a different mark in it.
 *
 * `wrap="truncate"` is not the way out, and this is the second time that has been
 * checked: `cli-truncate` at 163 columns returns *161* placeholders, because it
 * counts the astral placeholder as two. It loses cells rather than moving them.
 *
 * Only the default encoding is covered. {@link PlaceholderOptions.explicit} puts
 * two marks on every cell and is for debugging one placement by hand, not for
 * laying out a map.
 */
export const PLACEHOLDER_LAYOUT_SLACK = 1;

const ESC = "\u001B";
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
	/**
	 * Let the terminal answer back.
	 *
	 * Off in the game for a hard reason — see below — but a silenced terminal is
	 * also a terminal that cannot tell you why it drew nothing, so the diagnostic
	 * tool turns replies on.
	 */
	readonly loud?: boolean;
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
 *
 * Every frame begins by deleting the previous image and its placements. That is
 * not tidiness either: `a=T` *creates* a placement, and a fixed placement id is
 * not enough to make a second one replace the first. Without the delete, every
 * render leaves its predecessor on screen, and after a few seconds copies of the
 * map are stacked across the terminal — including over the side panel and
 * outside the map area entirely.
 *
 * The delete and the upload go out as one string deliberately. They are written
 * outside Ink's frame, and `sync-output.ts` brackets each write in DEC 2026, so
 * splitting them would present a frame with the image already deleted and the
 * new one not yet arrived — a blink of empty map on every step.
 */
/**
 * How hard to compress. Level 1, deliberately.
 *
 * A frame is three or four megapixels of mostly flat colour, and the levels are
 * not a smooth trade — measured on one, at 3078x1216:
 *
 * ```
 * level 1     7 ms   159 KB      level 4    53 ms   103 KB
 * level 3    10 ms   140 KB      level 6    69 ms    69 KB
 * ```
 *
 * Level 4 is where zlib changes strategy, and it costs seven times the CPU to
 * save a third of the bytes. Those bytes go down a pipe to a local terminal,
 * which is the cheap resource here; the CPU is the one the player feels as lag
 * between a keypress and the map moving. `KITTY_DEFLATE` raises it for anyone
 * whose terminal is at the far end of a slow link, where the trade reverses.
 */
const DEFLATE_LEVEL = (() => {
	const raw = Number(process.env.KITTY_DEFLATE);
	return Number.isInteger(raw) && raw >= 0 && raw <= 9 ? raw : 1;
})();

export function transmitFrame(spec: FrameSpec): string {
	const id = spec.imageId ?? FRAME_IMAGE_ID;
	const payload = deflateSync(spec.rgb, { level: DEFLATE_LEVEL }).toString("base64");
	// `d=I` takes the image and every placement of it, which is exactly the
	// state that must not survive into the next frame.
	const clear = `${APC}a=d,d=I,q=2,i=${id}${ST}`;

	const control = [
		"a=T", // transmit and display
		"f=24", // 24-bit RGB
		"o=z", // zlib-compressed payload
		`q=${spec.loud ? 0 : 2}`, // stay silent unless someone is debugging
		"U=1", // virtual placement, shown via placeholders
		`i=${id}`,
		// A fixed placement id. Not sufficient on its own — a second `a=T` adds a
		// placement rather than replacing the one that shares its id, which is why
		// the delete above exists — but it keeps the id predictable for anyone
		// inspecting the terminal's state.
		"p=1",
		`s=${spec.width}`,
		`v=${spec.height}`,
		`c=${spec.columns}`,
		`r=${spec.rows}`,
	].join(",");

	if (payload.length <= CHUNK) {
		return `${clear}${APC}${control},m=0;${payload}${ST}`;
	}

	// Only the first chunk carries the control data; the rest carry just `m`.
	let out = `${clear}${APC}${control},m=1;${payload.slice(0, CHUNK)}${ST}`;
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

function diacritic(index: number, what: string): string {
	const cp = DIACRITICS[index];
	if (cp === undefined) {
		throw new Error(
			`kitty placeholder ${what} ${index} is past the diacritic table (0..${DIACRITICS.length - 1})`,
		);
	}
	return String.fromCodePoint(cp);
}

/**
 * One placeholder cell naming both its row and its column.
 *
 * Only needed to anchor a run or to debug one. A whole viewport encoded this
 * way needs as many diacritics as it has *columns*, which is more than the
 * table has — see {@link placeholderRows} for what is actually emitted.
 */
export function encodeCell(row: number, column: number): string {
	return PLACEHOLDER + diacritic(row, "row") + diacritic(column, "column");
}

/**
 * The first cell of a row: says which row, and lets the column default to zero.
 *
 * Giving one diacritic rather than two is the whole trick that keeps this
 * inside the trustworthy part of the table. A row index is bounded by the
 * terminal's height, which is tens; a column index is bounded by its width,
 * which is not.
 */
export function encodeRowStart(row: number): string {
	return PLACEHOLDER + diacritic(row, "row");
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
	 * Name every cell's row *and* column rather than letting the terminal
	 * continue a run.
	 *
	 * Off by default, and it cannot be the default: a viewport is far wider than
	 * the 64 diacritics this file is willing to vouch for, so explicit encoding
	 * simply cannot express one. Kept for the smoke test, where the rectangle is
	 * small enough and naming every cell is what distinguishes "continuation is
	 * unsupported" from "the diacritic values are wrong".
	 */
	readonly explicit?: boolean;
	readonly imageId?: number;
}

/**
 * The rows of placeholder text that display a transmitted frame.
 *
 * Returned as one string per terminal row, to be handed to Ink as `<Text>`
 * exactly like the glyph renderer's encoded rows.
 *
 * Each row anchors itself with a single row diacritic and then runs bare, which
 * the terminal continues rightward. That is not only what keeps the diacritic
 * table small enough to trust — it is also most of the byte cost gone, since a
 * bare placeholder is four UTF-8 bytes against ten for a fully-named cell.
 */
export function placeholderRows(
	columns: number,
	rows: number,
	options: PlaceholderOptions = {},
): string[] {
	const explicit = options.explicit ?? false;
	const prefix = imageIdSequence(options.imageId);
	const out: string[] = [];

	for (let row = 0; row < rows; row++) {
		let line = prefix;
		for (let column = 0; column < columns; column++) {
			if (explicit) {
				line += encodeCell(row, column);
			} else {
				line += column === 0 ? encodeRowStart(row) : PLACEHOLDER;
			}
		}
		out.push(`${line}${ESC}[0m`);
	}
	return out;
}

/**
 * A third id, for the one-pixel image that is only ever a question.
 *
 * Its own id for the same reason the diagnostic tool has one: a query that shared
 * the frame's id could delete or be deleted by a real frame, and the answer would
 * then be about the wrong image.
 */
export const QUERY_IMAGE_ID = 0x61_64_78;

/**
 * Ask the terminal whether it speaks this protocol at all.
 *
 * One RGB pixel — three zero bytes, which is `AAAA` in base64 — sent with `a=q`.
 * A query transmits nothing and displays nothing; it asks the terminal to say
 * whether it *could* have. A terminal that implements the protocol answers
 * `ESC _G i=<id>;OK ESC \`, one that implements it but cannot honour this
 * particular request answers with an error code, and one that has never heard of
 * it says nothing at all and swallows the escape.
 *
 * Deliberately *not* `q=2`. Every other command here silences the terminal,
 * because an unsolicited reply reaches Ink as keystrokes and walks the player's
 * character somewhere they did not ask to go. Here the reply is the entire point,
 * so this may only be sent in the window before Ink owns stdin — see
 * `mode.ts`'s `probeTerminal`, which is the only caller.
 */
export function graphicsQuery(imageId = QUERY_IMAGE_ID): string {
	return `${APC}i=${imageId},s=1,v=1,a=q,t=d,f=24;AAAA${ST}`;
}

/**
 * Whether a terminal's reply says yes.
 *
 * Scans for *our* id rather than for `OK` anywhere in the buffer, because the
 * reply arrives mixed in with the answers to two unrelated size queries and, on a
 * bad day, with whatever the player typed while it was waiting.
 */
export function graphicsSupported(reply: string, imageId = QUERY_IMAGE_ID): boolean {
	// Everything before the first APC is not an answer to anything.
	for (const part of reply.split(APC).slice(1)) {
		const semi = part.indexOf(";");
		if (semi === -1) continue;
		if (!part.slice(0, semi).split(",").includes(`i=${imageId}`)) continue;
		// `OK`, or an error code naming what went wrong. Either way the terminal
		// answered, but only one of them means the image would have been drawn.
		return part.slice(semi + 1).startsWith("OK");
	}
	return false;
}

/**
 * Does this terminal implement the graphics protocol, going by its environment?
 *
 * A guess, and the fallback rather than the answer: {@link graphicsQuery} asks the
 * terminal directly, and a terminal that answers is worth more than a list of the
 * ones somebody remembered to add. This is what is left for the cases where no
 * question can be asked — output that is not a terminal, or a run that skipped the
 * probe — and it is the reason a terminal nobody listed used to get glyphs with no
 * explanation.
 *
 * `TILE_MODE` overrides in both directions, so a terminal neither of them knows
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
 *
 * This has to be a list of names and cannot be a capability question, which is
 * the uncomfortable part. A multiplexer runs the game on a pty of its own and
 * hands down the *outer* terminal's environment, so `TERM_PROGRAM` still says
 * whatever the window it eventually draws into says — and a graphics query sent
 * into one is answered by that outer terminal, truthfully, about itself. The game
 * then has an `OK` from a terminal it is not actually talking to.
 *
 * Measured inside herdr, which is where this was found: `TERM_PROGRAM=ghostty`
 * and `TERM=xterm-256color`, so {@link detectKittyGraphics} said yes and nothing
 * contradicted it. Asking harder cannot help; only knowing the name can.
 *
 * `TILE_MODE=kitty` forces past this, for a multiplexer that does implement the
 * protocol — which is the right shape for the escape hatch, because being wrong
 * here is a mess on screen rather than a crash.
 */
export function graphicsBlockedByMultiplexer(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.TMUX) return true;
	if ((env.TERM ?? "").startsWith("screen")) return true;
	// herdr: a tmux-like multiplexer that runs each agent in its own pane.
	if (env.HERDR_ENV || env.HERDR_PANE_ID) return true;
	return false;
}
