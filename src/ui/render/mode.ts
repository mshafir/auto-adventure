/**
 * Which renderer draws the map.
 *
 * Glyphs are not a legacy path being kept alive out of politeness — they are
 * the only mode that works everywhere, so they are the floor. Pixel mode is an
 * upgrade that a terminal either supports or does not, and every way of finding
 * out has to end in glyphs when the answer is no.
 */
import { detectKittyGraphics, graphicsBlockedByMultiplexer } from "./kitty.js";

export type TileMode = "glyph" | "kitty";

export interface ModeReason {
	readonly mode: TileMode;
	/** Why, in a few words. Shown by the tools and worth having in a bug report. */
	readonly because: string;
}

/**
 * Resolve the tile mode.
 *
 * `TILE_MODE` is honoured in both directions and without a capability check,
 * because sniffing cannot know about a terminal that has not shipped yet and
 * the player is better placed to say than we are. `TILE_MODE=kitty` in a
 * terminal that cannot do it produces a mess rather than a crash, which is a
 * fair trade for being able to try.
 *
 * Everything else defaults to glyphs. Detection is deliberately conservative:
 * guessing "yes" wrongly fills the map with base64, and guessing "no" wrongly
 * costs a player some detail they can turn on by hand.
 */
export function resolveTileMode(env: NodeJS.ProcessEnv = process.env): ModeReason {
	const requested = env.TILE_MODE?.trim().toLowerCase();

	if (requested === "glyph" || requested === "glyphs") {
		return { mode: "glyph", because: "TILE_MODE=glyph" };
	}
	if (requested === "kitty" || requested === "pixel") {
		return { mode: "kitty", because: "TILE_MODE=kitty (forced, capability not checked)" };
	}
	if (requested !== undefined && requested !== "" && requested !== "auto") {
		return { mode: "glyph", because: `TILE_MODE=${requested} is not a mode; using glyphs` };
	}

	if (graphicsBlockedByMultiplexer(env)) {
		return { mode: "glyph", because: "a multiplexer is in the way of graphics escapes" };
	}
	// Not a TTY means a pipe, a golden test or a screenshot, none of which can
	// show an image and all of which want stable text.
	if (process.stdout.isTTY !== true) {
		return { mode: "glyph", because: "output is not a terminal" };
	}
	if (!detectKittyGraphics(env)) {
		return { mode: "glyph", because: "terminal not known to support kitty graphics" };
	}
	return { mode: "kitty", because: "terminal supports kitty graphics" };
}

export interface CellSize {
	readonly width: number;
	readonly height: number;
}

/**
 * A guess, for when the terminal will not say.
 *
 * Being wrong here is not cosmetic. The cell size decides how many tiles fit,
 * which decides the camera's size — so a bad guess draws a viewport of one
 * shape while centring the player for a viewport of another, and the player
 * ends up off toward an edge.
 */
const ASSUMED_CELL: CellSize = { width: 8, height: 16 };

const ESC = "\u001B";
const CSI = `${ESC}[`;

let measured: CellSize | undefined;
let lastReply = "";

/**
 * Whatever the terminal sent back, printable-escaped.
 *
 * Kept only so a terminal that answers in an unexpected shape can be diagnosed
 * from a bug report rather than by guessing at it.
 */
export function lastCellReply(): string {
	// A plain string replace rather than a regex: biome rejects a control character
	// in a pattern however it is spelled, and a regex was buying nothing here.
	return lastReply.replaceAll(ESC, "<ESC>");
}

/**
 * Ask the terminal how big a cell is, once, before Ink starts.
 *
 * This has to happen before `render()`. The query works by writing an escape
 * and reading the answer off stdin, and once Ink is running stdin is its —
 * a reply arriving late is indistinguishable from the player typing, and would
 * walk their character somewhere they did not ask to go. Called at startup
 * there is no such race, and the answer is good for the life of the process
 * unless the font changes.
 *
 * `CSI 16 t` asks for the cell size directly. Terminals that do not implement
 * it simply never answer, which is why this gives up after a moment rather
 * than waiting: a missing reply is the common case, not an error.
 */
export async function measureCellPixels(
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: NodeJS.WriteStream = process.stdout,
	timeoutMs = 100,
): Promise<CellSize> {
	if (!stdin.isTTY || !stdout.isTTY) return ASSUMED_CELL;

	lastReply = "";
	return new Promise<CellSize>((resolve) => {
		let settled = false;
		const wasRaw = stdin.isRaw;
		const finish = (size: CellSize, real: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			// Leave stdin exactly as it was found; Ink sets its own mode after this.
			if (!wasRaw) stdin.setRawMode(false);
			stdin.pause();
			// Only a real answer is recorded, so callers can tell a measurement
			// from a guess and say which they are using.
			if (real) measured = size;
			resolve(size);
		};

		const onData = (chunk: Buffer) => {
			const text = chunk.toString("latin1");
			lastReply += text;

			// CSI 6 ; <height> ; <width> t — the cell size, asked for directly.
			const cell = /\[6;(\d+);(\d+)t/.exec(text);
			if (cell) {
				const height = Number(cell[1]);
				const width = Number(cell[2]);
				const ok = height > 0 && width > 0;
				finish(ok ? { width, height } : ASSUMED_CELL, ok);
				return;
			}

			// CSI 4 ; <height> ; <width> t — the text area in pixels. Divided by the
			// grid it gives the same answer, and terminals that ignore `16t` often
			// still answer this one.
			const area = /\[4;(\d+);(\d+)t/.exec(text);
			if (area) {
				const areaH = Number(area[1]);
				const areaW = Number(area[2]);
				const cols = stdout.columns ?? 0;
				const rowCount = stdout.rows ?? 0;
				if (areaH > 0 && areaW > 0 && cols > 0 && rowCount > 0) {
					finish({ width: Math.round(areaW / cols), height: Math.round(areaH / rowCount) }, true);
				}
			}
		};

		const timer = setTimeout(() => finish(ASSUMED_CELL, false), timeoutMs);
		// Unref'd so a terminal that never answers cannot hold the process open.
		timer.unref?.();

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		// Both at once. They are independent queries and a terminal answers the
		// ones it knows, so asking for the fallback up front costs one round trip
		// instead of two.
		stdout.write(`${CSI}16t${CSI}14t`);
	});
}

/**
 * A terminal cell's size in pixels.
 *
 * `CELL_PX=WxH` wins, then whatever {@link measureCellPixels} found, then the
 * assumption. Synchronous because the renderer needs it during layout.
 */
export function cellPixels(env: NodeJS.ProcessEnv = process.env): CellSize {
	const match = /^(\d+)x(\d+)$/.exec(env.CELL_PX?.trim() ?? "");
	if (match) {
		return { width: Number(match[1]), height: Number(match[2]) };
	}
	return measured ?? ASSUMED_CELL;
}

/** Did the terminal actually answer, or are we guessing? */
export function cellPixelsWereMeasured(): boolean {
	return measured !== undefined;
}

/** Test seam, and how the startup path installs what it measured. */
export function setCellPixels(size: CellSize | undefined): void {
	measured = size;
}
