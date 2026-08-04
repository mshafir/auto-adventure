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

/**
 * Wrap a stream so every write is one synchronized update.
 *
 * A `Proxy` rather than a hand-written shim because Ink reads `columns`, `rows`,
 * `isTTY` and the `resize` event off this object, and a component may reach for
 * anything else through `useStdout()`. Methods are bound to the real stream so
 * that `this` is never the proxy.
 */
export function withSynchronizedOutput(stream: NodeJS.WriteStream): NodeJS.WriteStream {
	if (!syncOutputEnabled()) return stream;

	return new Proxy(stream, {
		get(target, property) {
			if (property === "write") {
				return (chunk: unknown, ...rest: unknown[]) => {
					// Only text frames are bracketed; a Buffer write is left alone
					// rather than being concatenated into a string.
					if (typeof chunk !== "string") {
						return (target.write as (...args: unknown[]) => boolean)(chunk, ...rest);
					}
					return (target.write as (...args: unknown[]) => boolean)(
						BEGIN_SYNC + chunk + END_SYNC,
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
