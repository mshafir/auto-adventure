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

/**
 * A terminal cell's size in pixels.
 *
 * Queried from the terminal in principle; in practice not, because the query
 * writes to the terminal and reads the reply off stdin, and stdin belongs to
 * Ink — a reply arriving a moment late is indistinguishable from the player
 * typing, and the cost of being wrong is only that the terminal scales the
 * image slightly. `CELL_PX=WxH` sets it for anyone who wants it exact.
 *
 * The default is the common case for a terminal at a normal font size.
 */
export function cellPixels(env: NodeJS.ProcessEnv = process.env): {
	width: number;
	height: number;
} {
	const match = /^(\d+)x(\d+)$/.exec(env.CELL_PX?.trim() ?? "");
	if (match) {
		return { width: Number(match[1]), height: Number(match[2]) };
	}
	return { width: 8, height: 16 };
}
