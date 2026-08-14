import { writeSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRestoreForTest, restoreTerminal } from "./restore.js";

/*
 * The difference between the game crashing and the player's terminal crashing.
 *
 * The game died mid-play with an uncaught `write EIO`, and the handler that was
 * meant to hand the terminal back wrote through `process.stdout` — which Node had
 * already destroyed as part of reporting that very error. So the escapes never
 * left the process, and the player was returned to a shell still in the alternate
 * screen with the keyboard still in raw mode.
 */

vi.mock("node:fs", () => ({ writeSync: vi.fn() }));

const sent = vi.mocked(writeSync);

const ESC = "";

const was = {
	stdinIsTTY: process.stdin.isTTY,
	stdoutIsTTY: process.stdout.isTTY,
	setRawMode: process.stdin.setRawMode,
};

/** Raw mode, and whether it was reached before the screen was given back. */
const order: string[] = [];
let rawModeThrows = false;

function pretendTTY(stdin: boolean, stdout: boolean) {
	Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
	Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
}

beforeEach(() => {
	resetRestoreForTest();
	sent.mockReset();
	sent.mockImplementation(() => {
		order.push("screen");
		return 0;
	});
	order.length = 0;
	rawModeThrows = false;
	pretendTTY(true, true);
	// The suite does not run on a terminal, so there is no `setRawMode` to spy on.
	Object.defineProperty(process.stdin, "setRawMode", {
		value: (() => {
			order.push("keyboard");
			if (rawModeThrows) throw new Error("EIO");
			return process.stdin;
		}) as typeof process.stdin.setRawMode,
		configurable: true,
	});
});

afterEach(() => {
	pretendTTY(was.stdinIsTTY as boolean, was.stdoutIsTTY as boolean);
	Object.defineProperty(process.stdin, "setRawMode", {
		value: was.setRawMode,
		configurable: true,
	});
});

describe("handing the terminal back", () => {
	it("writes to the file descriptor, not through a stream that may be destroyed", () => {
		restoreTerminal();
		expect(sent).toHaveBeenCalledTimes(1);
		expect(sent.mock.calls[0]?.[0]).toBe(1);
	});

	it("leaves the alternate screen, shows the cursor and ends the synchronized update", () => {
		restoreTerminal();
		const escapes = String(sent.mock.calls[0]?.[1]);
		expect(escapes).toContain(`${ESC}[?1049l`);
		expect(escapes).toContain(`${ESC}[?25h`);
		// A frame interrupted halfway leaves the terminal holding an unpresented
		// buffer, which looks like a hang rather than an exit.
		expect(escapes).toContain(`${ESC}[?2026l`);
	});

	it("takes the keyboard out of raw mode first", () => {
		// The part a player cannot work around: without it they cannot see what they
		// are typing, so they cannot even close the window from the shell.
		restoreTerminal();
		expect(order).toEqual(["keyboard", "screen"]);
	});

	it("still gives the screen back when raw mode cannot be left", () => {
		// A terminal that has just refused one thing will refuse others, and losing
		// the alternate screen because the keyboard failed first is the worst outcome.
		rawModeThrows = true;
		expect(() => restoreTerminal()).not.toThrow();
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("survives a terminal that refuses the escapes too", () => {
		sent.mockImplementation(() => {
			throw new Error("EIO");
		});
		expect(() => restoreTerminal()).not.toThrow();
	});

	it("runs once, so a signal and a crash can both ask for it", () => {
		restoreTerminal();
		restoreTerminal();
		restoreTerminal();
		expect(sent).toHaveBeenCalledTimes(1);
	});

	it("writes nothing when the output is a file, so escapes stay out of it", () => {
		pretendTTY(true, false);
		restoreTerminal();
		expect(sent).not.toHaveBeenCalled();
	});

	it("does not touch raw mode when stdin is not a terminal", () => {
		pretendTTY(false, true);
		restoreTerminal();
		expect(order).toEqual(["screen"]);
	});
});
