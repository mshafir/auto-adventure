/**
 * Which renderer draws the map.
 *
 * Glyphs are not a legacy path being kept alive out of politeness — they are
 * the only mode that works everywhere, so they are the floor. Pixel mode is an
 * upgrade that a terminal either supports or does not, and every way of finding
 * out has to end in glyphs when the answer is no.
 */
import {
	detectKittyGraphics,
	graphicsBlockedByMultiplexer,
	graphicsQuery,
	graphicsSupported,
} from "./kitty.js";
import { TILE_WIDTH } from "./scale.js";

export type TileMode = "glyph" | "kitty";

export interface ModeReason {
	readonly mode: TileMode;
	/** Why, in a few words. Shown by the tools and worth having in a bug report. */
	readonly because: string;
}

/**
 * What the terminal said when it was asked, if it was asked.
 *
 * Three states, and the third is not the same as the second. `false` is a
 * terminal that was given the chance to say yes and did not; `undefined` is a run
 * where nobody asked — a pipe, a golden test, a tool that starts drawing before it
 * gets round to probing. Collapsing the two would mean a screenshot run silently
 * deciding the terminal is incapable.
 */
let probedGraphics: boolean | undefined;

/** Test seam, and how a tool records a probe it ran itself. */
export function setGraphicsProbe(answer: boolean | undefined): void {
	probedGraphics = answer;
}

/** What the probe found, or undefined if none has run. */
export function graphicsProbe(): boolean | undefined {
	return probedGraphics;
}

/**
 * Resolve the tile mode.
 *
 * `TILE_MODE` is honoured in both directions and without a capability check,
 * because no amount of asking can know about a terminal that has not shipped yet
 * and the player is better placed to say than we are. `TILE_MODE=kitty` in a
 * terminal that cannot do it produces a mess rather than a crash, which is a fair
 * trade for being able to try — and it is the escape hatch if the probe below is
 * ever wrong.
 *
 * Otherwise the terminal's own answer decides. That is stricter than the
 * environment sniffing it replaces, and the trade is worth stating: a terminal
 * that implements the protocol but drops the reply now gets glyphs where the list
 * would have given it pixels. In exchange, a terminal nobody thought to add to the
 * list gets pixels, which is the case that was silently wrong before.
 *
 * {@link detectKittyGraphics} is left as the answer only where no question could
 * be asked at all.
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

	if (probedGraphics !== undefined) {
		return probedGraphics
			? { mode: "kitty", because: "the terminal answered the graphics query" }
			: { mode: "glyph", because: "the terminal did not answer the graphics query" };
	}

	if (!detectKittyGraphics(env)) {
		return { mode: "glyph", because: "terminal not known to support kitty graphics (not probed)" };
	}
	return { mode: "kitty", because: "terminal is known to support kitty graphics (not probed)" };
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

export interface TerminalProbe {
	readonly cell: CellSize;
	/** Whether the graphics query came back `OK`. */
	readonly graphics: boolean;
}

export interface ProbeOptions {
	readonly timeoutMs?: number;
	/**
	 * Ask whether the terminal does graphics. Off for a multiplexer, which prints
	 * an APC sequence it does not understand rather than eating it.
	 */
	readonly graphics?: boolean;
}

/**
 * Ask the terminal about itself, once, before Ink starts.
 *
 * This has to happen before `render()`. Every question here works by writing an
 * escape and reading the answer off stdin, and once Ink is running stdin is its —
 * a reply arriving late is indistinguishable from the player typing, and would
 * walk their character somewhere they did not ask to go. Called at startup there
 * is no such race, and the answers are good for the life of the process unless the
 * font changes.
 *
 * Three questions go out in one write, because they are independent and a terminal
 * answers whichever it knows: `CSI 16 t` for the cell size, `CSI 14 t` for the text
 * area as a fallback, and a one-pixel graphics query for whether the pixel renderer
 * can work at all. Asking them together costs one round trip rather than three.
 *
 * **Every answer must be consumed before Ink reads stdin.** This has gone wrong
 * once and the symptom was baffling: stopping at the first of two replies left
 * `ESC[4;1554;3097t` in the terminal's input buffer, and the shell echoed it as
 * `42;19t;1554;3097t` after the game exited. Hence the early finish waits for all
 * three, and the timeout — not a reply — is what really ends this: a terminal
 * answering only some of the three is the normal case, not an error.
 */
export async function probeTerminal(
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: NodeJS.WriteStream = process.stdout,
	options: ProbeOptions = {},
): Promise<TerminalProbe> {
	const { timeoutMs = 100, graphics: askGraphics = true } = options;
	if (!stdin.isTTY || !stdout.isTTY) return { cell: ASSUMED_CELL, graphics: false };

	lastReply = "";
	return new Promise<TerminalProbe>((resolve) => {
		let settled = false;
		const wasRaw = stdin.isRaw;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stdin.off("data", onData);
			// Leave stdin exactly as it was found; Ink sets its own mode after this.
			if (!wasRaw) stdin.setRawMode(false);
			stdin.pause();

			const size = fromCellReply(lastReply) ?? fromAreaReply(lastReply, stdout);
			// Only a real answer is recorded, so callers can tell a measurement from a
			// guess and say which they are using.
			if (size) measured = size;
			const graphics = askGraphics && graphicsSupported(lastReply);
			// Recorded only when the question was actually asked. A run that skipped it
			// must leave the answer unknown rather than saying "no" on its behalf.
			if (askGraphics) probedGraphics = graphics;
			resolve({ cell: size ?? ASSUMED_CELL, graphics });
		};

		/*
		 * Parsed from everything received so far rather than from the chunk in hand.
		 * A reply can arrive split — it is three escape sequences and there is nothing
		 * saying they come in one read — and matching per chunk would then miss an
		 * answer that did in fact arrive.
		 */
		const onData = (chunk: Buffer) => {
			lastReply += chunk.toString("latin1");
			// All three, or the window closes. See the note above on what a reply left
			// behind in the input buffer does.
			if (
				fromCellReply(lastReply) &&
				fromAreaReply(lastReply, stdout) &&
				(!askGraphics || graphicsSupported(lastReply))
			) {
				finish();
			}
		};

		// Deliberately *not* unref'd. It is the only thing holding the event loop
		// open for these hundred milliseconds: stdin arrives unref'd from the
		// launcher's own Ink instance, so an unref'd timer here let node run out of
		// work and exit — the game closing without a word after the menu, before it
		// ever drew a frame.
		const timer = setTimeout(finish, timeoutMs);

		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		stdout.write(`${CSI}16t${CSI}14t${askGraphics ? graphicsQuery() : ""}`);
	});
}

/** The cell size alone, for a caller that does not care about graphics. */
export async function measureCellPixels(
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: NodeJS.WriteStream = process.stdout,
	timeoutMs = 100,
): Promise<CellSize> {
	return (await probeTerminal(stdin, stdout, { timeoutMs, graphics: false })).cell;
}

/**
 * Whether it is worth asking the terminal anything, and what.
 *
 * `false` means do not write to the terminal at all: with glyphs forced there is
 * nothing a measurement would change, and on a stream that is not a terminal there
 * is nobody to answer.
 *
 * `{ graphics: false }` is the multiplexer case, and the distinction matters. tmux
 * passes the size queries through happily but *prints* an unhandled APC sequence
 * instead of swallowing it, so a graphics query there would spray its own escape
 * across the screen to learn something the mode resolution ignores anyway. The cell
 * size is still worth having, because `TILE_MODE=kitty` under tmux is a thing
 * people try.
 */
export function probePlan(
	env: NodeJS.ProcessEnv = process.env,
	stdin: NodeJS.ReadStream = process.stdin,
	stdout: NodeJS.WriteStream = process.stdout,
): ProbeOptions | undefined {
	const requested = env.TILE_MODE?.trim().toLowerCase();
	if (requested === "glyph" || requested === "glyphs") return undefined;
	if (!stdin.isTTY || !stdout.isTTY) return undefined;
	return graphicsBlockedByMultiplexer(env) ? { graphics: false } : {};
}

/** `CSI 6 ; <height> ; <width> t` — the cell size, asked for directly. */
function fromCellReply(reply: string): CellSize | undefined {
	const match = /\[6;(\d+);(\d+)t/.exec(reply);
	if (!match) return undefined;
	const height = Number(match[1]);
	const width = Number(match[2]);
	return height > 0 && width > 0 ? { width, height } : undefined;
}

/**
 * `CSI 4 ; <height> ; <width> t` — the text area in pixels.
 *
 * Divided by the grid it gives the same answer, and terminals that ignore `16t`
 * often still answer this one.
 */
function fromAreaReply(reply: string, stdout: NodeJS.WriteStream): CellSize | undefined {
	const match = /\[4;(\d+);(\d+)t/.exec(reply);
	if (!match) return undefined;
	const areaH = Number(match[1]);
	const areaW = Number(match[2]);
	const columns = stdout.columns ?? 0;
	const rows = stdout.rows ?? 0;
	if (areaH <= 0 || areaW <= 0 || columns <= 0 || rows <= 0) return undefined;
	return { width: Math.round(areaW / columns), height: Math.round(areaH / rows) };
}

/**
 * How many pixels a tile gets, derived from the cell size.
 *
 * Not a constant, and that was the bug: sixteen pixels is smaller than a cell on
 * any modern terminal — 19x42 on the one this was found on — so a tile took less
 * than a cell and the pixel renderer showed 193x76 tiles where the glyph
 * renderer showed 81x29. Two and a half times the world at a third of the size,
 * which is the "everything is tiny" complaint exactly, and four times the pixels
 * to push for the privilege.
 *
 * A tile therefore gets the room the glyph renderer gives it: `TILE_WIDTH`
 * columns. That is the same field of view, at forty-odd pixels a tile instead of
 * one character.
 *
 * `ZOOM` scales it — above 1 for bigger tiles and less world, below for more.
 * `TILE_PX` still pins an exact size for experiments.
 */
export function tilePixels(env: NodeJS.ProcessEnv = process.env, cell = cellPixels(env)): number {
	const pinned = Number(env.TILE_PX);
	if (Number.isFinite(pinned) && pinned >= 4) return Math.trunc(pinned);

	const zoom = Number(env.ZOOM);
	const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
	return Math.max(4, Math.round(cell.width * TILE_WIDTH * scale));
}

/**
 * The most pixels one frame may be.
 *
 * A frame is drawn at the map's own screen resolution, so its size is decided by
 * the window rather than by anything we choose — and on a large one that gets out
 * of hand fast. Measured at 163x70 cells with Ghostty's 19x42 cell: **3078x2584,
 * which is 8 megapixels and 24MB of raw RGB, sent again on every keypress.** The
 * terminal has to inflate that and reallocate a texture each time; hold a
 * direction key and it is hundreds of megabytes a second. Ghostty died doing it.
 *
 * Four megapixels is where a 37-row window already sat, so the common case is
 * untouched and only the large ones are pulled back. Past the cap the frame is
 * drawn smaller and the terminal scales it up into the same cells — the protocol
 * does that anyway, since `c` and `r` are sent explicitly. Slightly softer, which
 * is a fair trade against taking the terminal down.
 *
 * `FRAME_PIXELS` moves it, for a machine with more or less room than this assumes.
 */
export const DEFAULT_FRAME_PIXELS = 4_000_000;

function frameBudget(env: NodeJS.ProcessEnv): number {
	const raw = Number(env.FRAME_PIXELS);
	return Number.isFinite(raw) && raw >= 100_000 ? Math.trunc(raw) : DEFAULT_FRAME_PIXELS;
}

/** Below this a sprite stops being a picture of anything, cap or no cap. */
const MIN_TILE_PX = 8;

/**
 * How many pixels a tile gets when it is actually drawn.
 *
 * {@link tilePixels} says how big a tile *wants* to be — the room the glyph
 * renderer gives it, so the two show the same field of view. This says how big it
 * may be drawn given how many of them there are, which is the same thing until the
 * frame would be enormous.
 *
 * Only the drawing shrinks. The camera still covers the tiles it did, so the same
 * amount of world is on screen and nothing about the layout moves; the image just
 * arrives at a lower resolution and is scaled back up by the terminal.
 */
export function renderTilePixels(
	tilesWide: number,
	tilesHigh: number,
	env: NodeJS.ProcessEnv = process.env,
	cell = cellPixels(env),
): number {
	const wanted = tilePixels(env, cell);
	const tiles = Math.max(1, tilesWide * tilesHigh);
	// Area scales with the square of the tile size, so the cap does too.
	const affordable = Math.floor(Math.sqrt(frameBudget(env) / tiles));
	return Math.max(MIN_TILE_PX, Math.min(wanted, affordable));
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
