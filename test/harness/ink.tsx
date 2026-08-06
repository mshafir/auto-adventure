import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type { ReactElement } from "react";
import stripAnsi from "strip-ansi";

/**
 * Render an Ink tree and be able to type at it.
 *
 * `ink-testing-library` cannot do this against the installed Ink. Two mismatches,
 * both fatal and neither loud:
 *
 * - Ink enables raw mode by calling `stdin.ref()`, which the library's fake stdin
 *   does not have. The `TypeError` lands inside a `useEffect`, so the *first*
 *   frame is already committed and correct; only afterwards does the error
 *   boundary repaint the tree as an error message. A test that reads `lastFrame()`
 *   synchronously therefore passes while the component under test is broken, and
 *   one that awaits anything at all sees `ERROR stdin.ref is not a function`.
 * - In raw mode Ink reads with the `readable` event and `stdin.read()`, whereas
 *   the library's fake stdin emits `data` and has no `read`. So even with `ref`
 *   patched in, nothing typed would ever arrive.
 *
 * This harness implements both contracts, which is what makes it possible to
 * assert on what a keypress *does* rather than only on what a screen looks like.
 */

class TestStdin extends EventEmitter {
	readonly isTTY = true;
	private readonly pending: string[] = [];

	setEncoding(): void {}
	setRawMode(): void {}
	resume(): void {}
	pause(): void {}
	ref(): void {}
	unref(): void {}

	read(): string | null {
		return this.pending.shift() ?? null;
	}

	/** Queue input and wake Ink, the way a terminal would. */
	write(data: string): void {
		this.pending.push(data);
		this.emit("readable");
	}
}

class TestStdout extends EventEmitter {
	readonly frames: string[] = [];

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {
		super();
	}

	write = (frame: string): void => {
		this.frames.push(frame);
	};

	lastFrame = (): string | undefined => this.frames.at(-1);
}

export interface InkHarness {
	readonly stdin: TestStdin;
	readonly stdout: TestStdout;
	/** The most recent frame, ANSI and all. */
	readonly lastFrame: () => string | undefined;
	/** The most recent frame with its ANSI stripped. */
	readonly screen: () => string;
	readonly unmount: () => void;
	/** Type at the app, then let React and Ink settle. */
	readonly type: (data: string) => Promise<void>;
	/** Let React and Ink settle without typing. */
	readonly settle: () => Promise<void>;
}

/** Keys, spelled out rather than left as bare escape bytes in test source. */
export const KEY = {
	up: "\u001B[A",
	down: "\u001B[B",
	left: "\u001B[D",
	right: "\u001B[C",
	enter: "\r",
	escape: "\u001B",
	space: " ",
	backspace: "\u007F",
} as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Consecutive quiet turns that count as settled. */
const QUIET_TURNS = 3;
/** And a ceiling, so a tree that repaints forever fails rather than hangs. */
const MAX_TURNS = 60;

/**
 * Wait for Ink to stop emitting, rather than for a fixed slice of wall clock.
 *
 * This was `setTimeout(10)`, which is a bet on how busy the machine is. React 18
 * batches a state change made from a stdin handler and flushes it on its own
 * scheduler, so under a full parallel test run that flush can land *after* the ten
 * milliseconds — and the test then reads the frame from before the keypress and
 * reports that the key did nothing. Seen once as "the strip does not offer
 * Carrying" from a suite that passes on its own.
 *
 * Quiet is at least {@link QUIET_TURNS} turns with no new frame, so this never
 * returns sooner than the fixed wait it replaces.
 */
async function settleFrames(frames: readonly string[]): Promise<void> {
	let quiet = 0;
	let seen = frames.length;
	for (let turn = 0; turn < MAX_TURNS && quiet < QUIET_TURNS; turn++) {
		await tick();
		if (frames.length === seen) {
			quiet += 1;
		} else {
			quiet = 0;
			seen = frames.length;
		}
	}
}

export interface RenderInkOptions {
	readonly columns?: number;
	/**
	 * Defaults to 24, which is what `useTerminalSize` falls back to when a stdout
	 * reports no row count — so the default here matches what the tests written
	 * against `ink-testing-library` were already laying out for.
	 */
	readonly rows?: number;
}

export function renderInk(tree: ReactElement, options: RenderInkOptions = {}): InkHarness {
	const stdin = new TestStdin();
	const stdout = new TestStdout(options.columns ?? 100, options.rows ?? 24);
	const instance = inkRender(tree, {
		// biome-ignore lint/suspicious/noExplicitAny: test doubles for node streams
		stdin: stdin as any,
		// biome-ignore lint/suspicious/noExplicitAny: test doubles for node streams
		stdout: stdout as any,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	const settle = async () => {
		await settleFrames(stdout.frames);
	};

	return {
		stdin,
		stdout,
		lastFrame: stdout.lastFrame,
		screen: () => stripAnsi(stdout.lastFrame() ?? ""),
		unmount: () => instance.unmount(),
		settle,
		type: async (data: string) => {
			stdin.write(data);
			await settle();
		},
	};
}
