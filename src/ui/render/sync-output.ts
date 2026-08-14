/**
 * Present each frame atomically.
 *
 * Ink does no diffing: every render erases all of the previous output and writes
 * the whole frame back (`ink/build/log-update.js`). At 120x40 in truecolor that
 * is about 48KB, which cannot reach the terminal in one piece — so the terminal
 * paints the erase, then the new frame progressively, and the player sees it
 * flicker even for a change as small as turning on the spot.
 *
 * DEC private mode 2026 — "synchronized output" — tells the terminal to buffer
 * everything between the markers and swap it in once. Because Ink emits the
 * erase and the repaint in a *single* `write` call, bracketing writes is enough
 * to make a whole frame atomic.
 *
 * Terminals that do not implement it ignore an unknown private mode, which is
 * the specified behaviour; `NO_SYNC_OUTPUT=1` opts out for anything that does
 * not. Supported by kitty, WezTerm, Alacritty, iTerm2, foot, contour, Ghostty,
 * Windows Terminal, xterm.js (so VS Code) and tmux 3.4+.
 *
 * "Ignore what you do not implement" holds for terminals and turns out not to
 * hold for everything in between them — see {@link syncOutputEnabled}.
 */
import { multiplexer } from "./multiplexer.js";

const BEGIN_SYNC = "\u001B[?2026h";
const END_SYNC = "\u001B[?2026l";

/**
 * Whether frames go out bracketed.
 *
 * Off inside a multiplexer that is not known to follow it, and that is a real
 * behaviour change rather than caution for its own sake. Inside herdr the map did
 * not draw at all, and turning off *either* the alternate screen buffer or this
 * fixed it — so neither escape is unsupported on its own; it is the pair this
 * parser cannot follow. Between the two, bracketing is the one to give up: it only
 * hides the gap between Ink erasing a frame and writing the next, whereas dropping
 * the alternate screen means painting over the player's scrollback and not giving
 * their shell back afterwards.
 *
 * `SYNC_OUTPUT=1` forces it back on, for a multiplexer that gains support after
 * this list was written. `NO_SYNC_OUTPUT=1` wins over both.
 */
export function syncOutputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_SYNC_OUTPUT === "1" || env.NO_SYNC_OUTPUT === "true") return false;
	// Nothing to synchronise when the output is not a terminal, and the markers
	// would otherwise end up in redirected output.
	if (process.stdout.isTTY !== true) return false;
	if (env.SYNC_OUTPUT === "1" || env.SYNC_OUTPUT === "true") return true;
	return multiplexer(env)?.synchronizedOutput !== false;
}

let pendingGraphics = "";

/**
 * Hold image bytes back so they go out inside the frame that displays them.
 *
 * The pixel renderer cannot write its image through Ink — an APC graphics escape
 * measures hundreds of columns and would shear the row — so it writes straight
 * to the stream during render, and Ink writes the text a moment later. Two
 * writes, and every write is its own synchronized update, so the terminal
 * presented twice per frame. Captured, not guessed:
 *
 * ```
 * BSU  delete  upload  chunks x19  ESU     <- the image, on its own
 * BSU  ESU                                 <- the text that references it
 * ```
 *
 * The first of those presentations is a frame in which the old image has been
 * deleted and a new one installed under placeholder text still describing the
 * previous one. That is the flicker: one presented frame per move that nobody
 * asked to be shown.
 *
 * Queueing means the escape still bypasses Ink's layout — which is the part that
 * matters — while landing in the same atomic update as the row of placeholders
 * that references it.
 *
 * Replaces rather than appends. Each transmission is a whole frame, so if two
 * renders happen before Ink writes, the second is the one that should go: sending
 * both would upload an image nothing will ever display.
 */
export function queueGraphics(bytes: string): void {
	pendingGraphics = bytes;
}

/** For a caller that has to reach the terminal outside a frame, such as teardown. */
export function flushGraphics(): string {
	const out = pendingGraphics;
	pendingGraphics = "";
	return out;
}

/**
 * Wrap a stream so every write is one synchronized update.
 *
 * A `Proxy` rather than a hand-written shim because Ink reads `columns`, `rows`,
 * `isTTY` and the `resize` event off this object, and a component may reach for
 * anything else through `useStdout()`. Methods are bound to the real stream so
 * that `this` is never the proxy.
 */
export function withSynchronizedOutput(
	stream: NodeJS.WriteStream,
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.WriteStream {
	const bracket = syncOutputEnabled(env);

	// Wrapped even when the brackets are off, because the graphics queue still has
	// to be flushed into the frame. Turning synchronisation off should cost the
	// atomic present, not the ordering.
	return new Proxy(stream, {
		get(target, property) {
			if (property === "write") {
				return (chunk: unknown, ...rest: unknown[]) => {
					// Only text frames are bracketed; a Buffer write is left alone
					// rather than being concatenated into a string.
					if (typeof chunk !== "string") {
						return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
					}
					// Image first, then the placeholders that display it. Ink emits its
					// frame from `resetAfterCommit`, after the render that queued the
					// image, so this order is the order they were produced in.
					const body = flushGraphics() + chunk;
					return (target.write as (...args: unknown[]) => boolean)(
						bracket ? BEGIN_SYNC + body + END_SYNC : body,
						...rest,
					);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as NodeJS.WriteStream;
}
