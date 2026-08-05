/**
 * Read a captured terminal session and report what the game actually emitted.
 *
 * This exists because every bug in the pixel renderer so far has been settled
 * by someone looking at a screenshot and describing it, which is slow and twice
 * gave the wrong answer. A capture is the real thing: run the game under a pty,
 * keep the bytes, and check them.
 *
 *   script -qec "stty cols 163 rows 37; TILE_MODE=kitty node dist/main.js" cap.raw
 *   vite-node src/tools/analyze-capture.ts -- cap.raw --columns 163
 *
 * What it cannot tell you is how the terminal *drew* it — that still needs eyes.
 * It can tell you whether the escapes were well formed, whether the image was
 * uploaded once or many times, and whether every line fits the terminal, which
 * is where the faults have actually been.
 */
import { readFileSync } from "node:fs";
import stringWidth from "string-width";
import { PLACEHOLDER } from "../ui/render/kitty.js";

const ESC = "";

interface Graphic {
	readonly control: Record<string, string>;
	readonly payloadBytes: number;
}

/** Pull out every APC graphics command, and return the stream without them. */
function extractGraphics(raw: string): { graphics: Graphic[]; text: string } {
	const graphics: Graphic[] = [];
	let text = "";
	let at = 0;

	while (at < raw.length) {
		const start = raw.indexOf(`${ESC}_G`, at);
		if (start === -1) {
			text += raw.slice(at);
			break;
		}
		text += raw.slice(at, start);
		const end = raw.indexOf(`${ESC}\\`, start);
		if (end === -1) {
			// An unterminated command is itself a finding: the stream was cut.
			graphics.push({ control: { UNTERMINATED: "1" }, payloadBytes: 0 });
			break;
		}
		const body = raw.slice(start + 3, end);
		const semi = body.indexOf(";");
		const head = semi === -1 ? body : body.slice(0, semi);
		const control: Record<string, string> = {};
		for (const pair of head.split(",")) {
			const [k, v] = pair.split("=");
			if (k) control[k] = v ?? "";
		}
		graphics.push({ control, payloadBytes: semi === -1 ? 0 : body.length - semi - 1 });
		at = end + 2;
	}

	return { graphics, text };
}

/** Strip SGR and cursor escapes so a line can be measured as it will be seen. */
function visible(line: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escapes is the job
	return line.replace(/\[[0-9;?]*[a-zA-Z]/g, "");
}

function parseArgs(argv: readonly string[]) {
	const args = new Map<string, string>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		const match = /^--([^=]+)(?:=(.*))?$/.exec(token);
		if (!match?.[1]) {
			positional.push(token);
			continue;
		}
		const next = argv[i + 1];
		if (match[2] !== undefined) args.set(match[1], match[2]);
		else if (next !== undefined && !next.startsWith("--")) {
			args.set(match[1], next);
			i++;
		} else args.set(match[1], "true");
	}
	return { args, positional };
}

/**
 * How many times the terminal was asked to put something on screen, and whether
 * the image ever went up on its own.
 *
 * This is what flicker looks like in the bytes. An image written straight to the
 * stream is its own synchronized update, so the terminal presents it once with
 * the previous frame's text over it and again when the real frame arrives —
 * a frame per move that nobody asked to see:
 *
 * ```
 * BSU  delete  upload  chunks  ESU      <- image, alone
 * BSU  ESU                              <- the text that displays it
 * ```
 *
 * Queued into the frame's own update, that collapses to one. Counted rather than
 * looked at, because the difference is a few milliseconds on screen and entirely
 * plain in the capture.
 */
function reportPresentation(out: string[], raw: string, uploads: number): void {
	const BSU = "[?2026h";
	const ESU = "[?2026l";
	const APC = "_G";

	const presented = raw.split(BSU).length - 1;
	// A graphics escape with no open bracket before it is one the terminal will
	// present by itself.
	let loose = 0;
	let at = raw.indexOf(APC);
	while (at >= 0) {
		const opened = raw.lastIndexOf(BSU, at);
		const closed = raw.lastIndexOf(ESU, at);
		if (opened < 0 || closed > opened) loose++;
		at = raw.indexOf(APC, at + 1);
	}

	out.push(`presented           ${presented} synchronized updates`);
	if (uploads > 0) {
		out.push(`  per upload        ${(presented / uploads).toFixed(1)}`);
	}
	out.push(
		loose === 0
			? "  all graphics inside an update"
			: `  LOOSE: ${loose} graphics escapes outside any update — each is its own flash`,
	);
}

function main() {
	const { args, positional } = parseArgs(process.argv.slice(2));
	const file = positional[0];
	if (!file) throw new Error("usage: analyze-capture <capture.raw> [--columns N]");
	const columns = Number(args.get("columns") ?? 80);

	// utf8, not latin1: a placeholder is four bytes, and decoding it as latin1
	// turns every one into four characters — which inflates every line width by
	// 4x and invents overlong lines that are not there.
	const raw = readFileSync(file, "utf8");
	const { graphics, text } = extractGraphics(raw);

	const out: string[] = [];
	out.push(`capture        ${file}, ${(raw.length / 1024).toFixed(1)}KB`);
	out.push(`terminal       ${columns} columns (as told)`);
	out.push("");

	// --- what was sent to the graphics protocol ---------------------------
	const byAction = new Map<string, number>();
	for (const g of graphics) {
		const key = g.control.a ?? (g.control.m !== undefined ? "(continuation)" : "(none)");
		byAction.set(key, (byAction.get(key) ?? 0) + 1);
	}
	out.push(`graphics commands   ${graphics.length}`);
	for (const [action, n] of [...byAction].sort()) out.push(`  a=${action.padEnd(14)} ${n}`);

	const uploads = graphics.filter((g) => g.control.a === "T" || g.control.a === "t");
	const deletes = graphics.filter((g) => g.control.a === "d");
	out.push(`  uploads ${uploads.length}, deletes ${deletes.length}`);
	// One delete per upload is the invariant that stops placements stacking.
	if (uploads.length !== deletes.length) {
		out.push(`  MISMATCH: every upload must be preceded by a delete`);
	}
	for (const g of uploads) {
		out.push(
			`  upload  i=${g.control.i} c=${g.control.c} r=${g.control.r}` +
				` s=${g.control.s} v=${g.control.v}`,
		);
	}

	reportPresentation(out, raw, uploads.length);

	// --- what the terminal was asked to lay out ---------------------------
	// Only the last frame. A capture holds every frame Ink wrote, including the
	// partial ones from before the layout settled, and mixing them together
	// reports a spread of tile counts that no single frame ever had.
	const allLines = text.split("\n");
	const rowsArg = Number(args.get("rows") ?? 0);
	const lines = rowsArg > 0 ? allLines.slice(-rowsArg) : allLines;
	const withPlaceholders = lines.filter((l) => l.includes(PLACEHOLDER));
	out.push("");
	out.push(`lines total         ${lines.length} (of ${allLines.length} captured)`);
	out.push(`lines with tiles    ${withPlaceholders.length}`);

	const counts = new Set(withPlaceholders.map((l) => l.split(PLACEHOLDER).length - 1));
	out.push(`tiles per line      ${[...counts].sort((a, b) => a - b).join(", ") || "none"}`);

	// --- the fault that painted over the side panel -----------------------
	const overlong = lines
		.map((l, i) => ({ i, w: stringWidth(visible(l)) }))
		.filter((x) => x.w > columns);
	out.push("");
	if (overlong.length === 0) {
		out.push(`line widths         all within ${columns} columns`);
	} else {
		out.push(`OVERLONG LINES      ${overlong.length} exceed ${columns} columns`);
		for (const x of overlong.slice(0, 5)) out.push(`  line ${x.i}: ${x.w} columns`);
	}

	// Where the text after the tile grid begins. If the map is 129 cells the
	// panel must start at 129 or later; earlier means the map is short and the
	// panel has slid left, later means it has been pushed out.
	const starts = new Set<number>();
	for (const line of withPlaceholders) {
		const v = visible(line);
		const last = v.lastIndexOf(PLACEHOLDER);
		if (last === -1) continue;
		const after = v.slice(last + PLACEHOLDER.length);
		if (after.trim().length > 0) starts.add(stringWidth(v.slice(0, last + PLACEHOLDER.length)));
	}
	out.push(
		`panel starts at     ${[...starts].sort((a, b) => a - b).join(", ") || "(no text after tiles)"}`,
	);

	if (args.has("lines")) {
		out.push("");
		out.push("per line: tiles, then what follows the last one");
		lines.forEach((line, i) => {
			const v = visible(line);
			const tiles = v.split(PLACEHOLDER).length - 1;
			if (tiles === 0) return;
			const tail = v.slice(v.lastIndexOf(PLACEHOLDER) + PLACEHOLDER.length);
			out.push(
				`  ${String(i).padStart(3)}  ${String(tiles).padStart(4)}  ${JSON.stringify(tail.slice(0, 46))}`,
			);
		});
	}

	process.stdout.write(`${out.join("\n")}\n`);
}

main();
