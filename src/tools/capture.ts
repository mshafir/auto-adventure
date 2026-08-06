/**
 * Run the built game under a real PTY and keep every byte it wrote.
 *
 * The point is to be able to check what the pixel renderer actually sent
 * without asking a human to look at a terminal. `analyze-capture.ts` reads the
 * result. Between them they found the placeholder-halving bug in one pass after
 * four rounds of misreading screenshots.
 *
 * A real PTY and not a fake stdout, because the things worth checking here —
 * the terminal's own cell-size reply, the graphics escapes, what the alternate
 * screen buffer does — only happen when the program believes it has a terminal.
 *
 * Keys are fed in on a timer rather than up front: the game opens on a card
 * that takes the whole frame, so without a keypress to put it down the capture
 * contains no map at all, which is exactly the mistake this replaces.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const COLUMNS = 163;
const ROWS = 37;
const OUT = "capture.raw";
const SECONDS = 8;

/** What to press, and how long after start. Space puts the opening card down. */
const KEYS: readonly { readonly at: number; readonly key: string }[] = [
	{ at: 1500, key: " " },
	{ at: 2500, key: "[C" },
	{ at: 3200, key: "[B" },
	{ at: 3900, key: "[C" },
];

/**
 * `--launcher` goes in the front door instead.
 *
 * Naming a world skips the menu, which is what a capture normally wants — but it
 * also skips the only path where the cell-size query runs *after* another Ink app
 * has held stdin, and that is where the reply-leaking bug lived.
 */
const THROUGH_LAUNCHER = process.argv.includes("--launcher");

if (!existsSync("dist/main.js")) {
	process.stderr.write("dist/main.js is missing — run `npm run build` first.\n");
	process.exit(1);
}

/**
 * Answering the front door: ENTER onto the New page, down to Wander, ENTER to start.
 *
 * Deterministic only because `AUTO_ADVENTURE_HOME` below points somewhere empty.
 * Against the real home directory the title screen would offer Continue as well,
 * the cursor would start there instead, and the same keypresses would resume
 * somebody's world rather than beginning one — so the capture would depend on who
 * was running it.
 *
 * The New page opens on the written scenarios, and `NO_AI=1` greys out the two
 * live modes between them and Wander — so one press down skips all three and lands
 * on the generated world this wants. Scenarios are read from the repository rather
 * than from `AUTO_ADVENTURE_HOME`, which is why the empty home does not remove them.
 */
const LAUNCHER_KEYS: readonly { readonly at: number; readonly key: string }[] = [
	{ at: 700, key: "\r" },
	{ at: 1100, key: "[B" },
	{ at: 1500, key: "\r" },
];

const HOME = "/tmp/auto-adventure-capture";

const inner = [
	`stty cols ${COLUMNS} rows ${ROWS}`,
	THROUGH_LAUNCHER ? `rm -rf ${HOME}` : "",
	[
		"TILE_MODE=kitty NO_AI=1",
		THROUGH_LAUNCHER ? `AUTO_ADVENTURE_HOME=${HOME}` : "WORLD_NAME=capture",
		`timeout ${SECONDS} node dist/main.js`,
	]
		.filter(Boolean)
		.join(" "),
]
	.filter(Boolean)
	.join("; ");

const child = spawn("script", ["-qec", inner, OUT], {
	stdio: ["pipe", "inherit", "inherit"],
});

// The menu needs answering before any of the in-game keys mean anything.
const offset = THROUGH_LAUNCHER ? (LAUNCHER_KEYS.at(-1)?.at ?? 0) + 600 : 0;
if (THROUGH_LAUNCHER) {
	for (const { at, key } of LAUNCHER_KEYS) setTimeout(() => child.stdin?.write(key), at);
}
for (const { at, key } of KEYS) {
	setTimeout(() => child.stdin?.write(key), at + offset);
}

child.on("exit", (code) => {
	process.stdout.write(`${OUT}  ${COLUMNS}x${ROWS}, ${SECONDS}s\n`);
	process.exit(code ?? 0);
});
