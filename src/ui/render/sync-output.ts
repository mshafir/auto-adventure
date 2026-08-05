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
 */
const BEGIN_SYNC = "\u001B[?2026h";
const END_SYNC = "\u001B[?2026l";

export function syncOutputEnabled(): boolean {
	if (process.env.NO_SYNC_OUTPUT === "1" || process.env.NO_SYNC_OUTPUT === "true") return false;
	// Nothing to synchronise when the output is not a terminal, and the markers
	// would otherwise end up in redirected output.
	return process.stdout.isTTY === true;
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
export function withSynchronizedOutput(stream: NodeJS.WriteStream): NodeJS.WriteStream {
	const bracket = syncOutputEnabled();

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

/**
 * Leave synchronized mode on the way out.
 *
 * A frame interrupted by Ctrl-C could otherwise leave the terminal holding an
 * unpresented buffer, which looks like a hang.
 */
export function endSynchronizedOutput(): void {
	if (syncOutputEnabled()) process.stdout.write(END_SYNC);
}
