/**
 * Hand the terminal back.
 *
 * The game borrows three things from the terminal that outlive the process if
 * nobody puts them back: the alternate screen buffer, a hidden cursor, and raw
 * mode on stdin. Exiting without undoing them is what a player experiences as
 * "it crashed my terminal" — the shell is still running, but it echoes nothing
 * and every keystroke goes somewhere invisible.
 *
 * Written to the file descriptor rather than through `process.stdout`, and that
 * is the whole reason this file exists. When a write to the terminal fails,
 * Node's `onWriteComplete` calls `stream.destroy(error)`; from that moment
 * `process.stdout.write` is a silent no-op, so the restore sequence a crash
 * handler sends never leaves the process. `writeSync` on fd 1 does not care that
 * the stream object above it has been torn down.
 *
 * Every step is wrapped, because this only ever runs on the way out and often on
 * the failure path: a terminal that has just refused one write may refuse the
 * next, and a throw here would lose the steps after it. Raw mode goes first,
 * being the part a player cannot work around — without the keyboard they cannot
 * even see what they are typing to close the window.
 */
import { writeSync } from "node:fs";

const ESC = "";
const END_SYNC = `${ESC}[?2026l`;
const ALT_SCREEN_OFF = `${ESC}[?1049l`;
const CURSOR_SHOW = `${ESC}[?25h`;

let restored = false;

/**
 * Undo everything the game did to the terminal, once.
 *
 * Idempotent, so the ordinary exit path, a signal handler and a crash handler can
 * all call it without any of them needing to know whether one of the others
 * already has.
 */
export function restoreTerminal(): void {
	if (restored) return;
	restored = true;

	try {
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	} catch {
		// Nothing to be done about it, and the screen still has to be given back.
	}
	// Nothing to restore when the output is a file or a pipe, and the escapes would
	// otherwise end up in it. `isTTY` is set when the stream is constructed, so it
	// still answers truthfully after a failed write has destroyed the stream.
	if (!process.stdout.isTTY) return;
	try {
		writeSync(1, END_SYNC + ALT_SCREEN_OFF + CURSOR_SHOW);
	} catch {
		// A terminal that will not take three escapes is not one we can repair from here.
	}
}

/** For tests, which each need to start from a terminal nobody has restored yet. */
export function resetRestoreForTest(): void {
	restored = false;
}
