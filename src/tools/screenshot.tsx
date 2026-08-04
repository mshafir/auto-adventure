/**
 * Render real frames of the game and write them out as SVG.
 *
 * A screenshot of a terminal is normally a photograph of somebody's font. These
 * are generated from the actual frame the game produces — the same compositor,
 * the same palette, the same panels — so they cannot drift from what the game
 * looks like, they diff as text in review, and they need no binary in the repo.
 */

import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { fallbackLore, fallbackSite } from "../ai/director/fallback.js";
import { hashString } from "../core/rand/hash.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { CHUNK, chunkKey } from "../core/world/coords.js";
import { type MacroSite, macroSite } from "../core/world/macro.js";
import { GameEngine } from "../engine/engine.js";
import App from "../ui/app.js";
import { bindEngine } from "../ui/store.js";
import { setColorDepth } from "../ui/viewport.js";

const COLUMNS = 120;
const ROWS = 34;

/**
 * Just enough of a TTY for Ink, at a size we choose.
 *
 * `ink-testing-library` would be the obvious harness but it hardcodes 100 columns
 * and reports no row count at all, which makes the map far narrower than anyone
 * actually plays at.
 */
function fakeStdout() {
	const writes: string[] = [];
	const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { writes: string[] };
	Object.assign(stream, {
		writes,
		columns: COLUMNS,
		rows: ROWS,
		isTTY: true,
		write(chunk: unknown) {
			if (typeof chunk === "string") writes.push(chunk);
			return true;
		},
	});
	return stream;
}

/**
 * A stdin that claims to be a terminal and delivers keys on demand.
 *
 * `useInput` refuses to mount without raw-mode support, so without this the whole
 * app throws inside Ink's error boundary and the captured frame is empty. Ink v4
 * pulls input with `read()` on the `readable` event rather than listening for
 * `data`, so a queue is what it actually wants.
 */
function fakeStdin() {
	const queue: string[] = [];
	const stream = new EventEmitter() as unknown as NodeJS.ReadStream & {
		press(key: string): void;
	};
	Object.assign(stream, {
		isTTY: true,
		setRawMode: () => stream,
		setEncoding: () => stream,
		resume: () => stream,
		pause: () => stream,
		read: () => queue.shift() ?? null,
		ref: () => stream,
		unref: () => stream,
		press(key: string) {
			queue.push(key);
			stream.emit("readable");
		},
	});
	return stream;
}

/**
 * The last full frame Ink emitted, with its cursor and erase control codes gone.
 *
 * Searched backwards for the last write that actually carries content: unmounting
 * writes a bare cursor-show, so simply taking the final write yields nothing.
 *
 * The patterns are built with `new RegExp` rather than written as literals. A
 * regex literal holding an escape character is both a lint error and, worse,
 * something the formatter rewrites into a raw control byte in the source.
 */
const ESC = "\u001B";

/** Cursor moves, erases, show/hide — everything except the SGR colour runs. */
const CONTROL = new RegExp(
	[
		`${ESC}\\[[0-9]*[ABCDEFGJKST]`,
		`${ESC}\\[\\?25[lh]`,
		`${ESC}\\[[0-9]*(;[0-9]*)?[Hf]`,
		`${ESC}\\[2J`,
	].join("|"),
	"g",
);

const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

function lastFrame(writes: readonly string[]): string {
	for (let i = writes.length - 1; i >= 0; i--) {
		const cleaned = (writes[i] ?? "").replace(CONTROL, "").replace(/^\n+/, "").replace(/\n+$/, "");
		if (stripAnsi(cleaned).trim().length > 0) return cleaned;
	}
	return "";
}

// --- ANSI to SVG ------------------------------------------------------------

const CELL_W = 8.4;
const CELL_H = 17;
const PAD = 12;

interface Span {
	readonly text: string;
	readonly fg?: string;
	readonly bg?: string;
	readonly bold: boolean;
	readonly col: number;
}

/** Split one styled line into runs, tracking the SGR state across it. */
function spansOf(line: string): Span[] {
	const spans: Span[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	let bold = false;
	let col = 0;
	let text = "";
	let startCol = 0;

	const flush = () => {
		if (text.length > 0) {
			spans.push({
				text,
				...(fg ? { fg } : {}),
				...(bg ? { bg } : {}),
				bold,
				col: startCol,
			});
		}
		text = "";
	};

	// Truecolor only: the tool pins the depth, so 38;2;r;g;b is all that appears.
	// Shared and global, so its cursor has to be reset for each line.
	const pattern = SGR;
	pattern.lastIndex = 0;
	let cursor = 0;
	let match = pattern.exec(line);
	while (true) {
		const upto = match ? match.index : line.length;
		const chunk = line.slice(cursor, upto);
		if (chunk.length > 0) {
			if (text.length === 0) startCol = col;
			text += chunk;
			col += [...chunk].length;
		}
		if (!match) break;

		flush();
		const codes = match[1] ?? "";
		const parts = codes.split(";").map((n) => Number(n) || 0);
		for (let i = 0; i < parts.length; i++) {
			const code = parts[i];
			if (code === 0) {
				fg = undefined;
				bg = undefined;
				bold = false;
			} else if (code === 1) {
				bold = true;
			} else if (code === 22) {
				bold = false;
			} else if (code === 39) {
				fg = undefined;
			} else if (code === 49) {
				bg = undefined;
			} else if ((code === 38 || code === 48) && parts[i + 1] === 2) {
				const colour = `rgb(${parts[i + 2] ?? 0},${parts[i + 3] ?? 0},${parts[i + 4] ?? 0})`;
				if (code === 38) fg = colour;
				else bg = colour;
				i += 4;
			}
		}
		cursor = match.index + match[0].length;
		match = pattern.exec(line);
	}
	flush();
	return spans;
}

const ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

function xml(text: string): string {
	return text.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);
}

function toSvg(frame: string, title: string): string {
	const lines = frame.split("\n");
	const columns = Math.max(...lines.map((line) => [...stripAnsi(line)].length));
	const width = Math.ceil(columns * CELL_W + PAD * 2);
	const height = Math.ceil(lines.length * CELL_H + PAD * 2);

	// The commonest background becomes the page fill, and those rectangles are then
	// not drawn at all. On a frame that is mostly one colour of ground this is most
	// of the file: it takes each image from about 90KB to a third of that.
	const tally = new Map<string, number>();
	for (const line of lines) {
		for (const span of spansOf(line)) {
			if (!span.bg) continue;
			tally.set(span.bg, (tally.get(span.bg) ?? 0) + [...span.text].length);
		}
	}
	let ground = "#14110d";
	let best = 0;
	for (const [colour, count] of tally) {
		if (count > best) {
			best = count;
			ground = colour;
		}
	}

	const rects: string[] = [];
	const texts: string[] = [];

	for (const [row, line] of lines.entries()) {
		const y = PAD + row * CELL_H;
		for (const span of spansOf(line)) {
			const x = PAD + span.col * CELL_W;
			const runWidth = [...span.text].length * CELL_W;
			if (span.bg && span.bg !== ground) {
				// Half a pixel of overlap, or seams show between adjacent cells at
				// fractional widths.
				rects.push(
					`<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(runWidth + 0.5).toFixed(2)}" height="${CELL_H}" fill="${span.bg}"/>`,
				);
			}
			if (span.text.trim().length === 0) continue;
			// `textLength` pins the run to exactly the width of the cells it covers.
			// Rendered inside an <img>, the SVG gets whatever monospace font the
			// viewer's OS resolves, whose advance width is not ours — without this the
			// text drifts out of its background rectangles a little more on every
			// column, and a long row ends up visibly out of register.
			texts.push(
				`<text x="${x.toFixed(2)}" y="${(y + CELL_H * 0.76).toFixed(2)}" textLength="${runWidth.toFixed(2)}" lengthAdjust="spacingAndGlyphs"${
					span.fg ? ` fill="${span.fg}"` : ""
				}${span.bold ? ' font-weight="bold"' : ""}>${xml(span.text)}</text>`,
			);
		}
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14">`,
		`<title>${xml(title)}</title>`,
		`<rect width="${width}" height="${height}" fill="${ground}"/>`,
		`<g shape-rendering="crispEdges">${rects.join("")}</g>`,
		`<g xml:space="preserve">${texts.join("")}</g>`,
		"</svg>",
	].join("\n");
}

// --- scenes -----------------------------------------------------------------

const SEED = hashString("hollowmoor");

function findTown(seed: number): MacroSite {
	for (let radius = 0; radius < 20; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(seed, mx, my);
				if (site.kind === "town") return site;
			}
		}
	}
	throw new Error("no town found");
}

function buildEngine() {
	const site = findTown(SEED);
	const spec = fallbackSite(SEED, site, siteContext(SEED, site));
	const engine = new GameEngine(
		createInitialState(
			{ id: "shot", name: "shot", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			site.site,
		),
		{
			runEffect: () => undefined,
			specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
			siteSpec: (id) => (id === site.id ? spec : undefined),
		},
	);
	engine.dispatch({ t: "LoreLearned", lore: fallbackLore() });
	engine.dispatch({ t: "SiteLearned", spec, source: "fallback" });
	engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
	engine.populateNpcs({ cx: site.mx, cy: site.my });
	return { engine, site, spec };
}

async function capture(
	name: string,
	title: string,
	prepare: (engine: GameEngine, site: MacroSite) => void,
	tab?: "map" | "world" | "inventory" | "quests" | "journal",
	cursor?: number,
) {
	const { engine, site } = buildEngine();
	prepare(engine, site);
	bindEngine(engine);

	const stdout = fakeStdout();
	const stdin = fakeStdin();
	const instance = render(
		<App {...(tab ? { initialTab: tab } : {})} {...(cursor ? { initialCursor: cursor } : {})} />,
		{
			stdout,
			stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	// One tick, so the effects the first frame queued have landed.
	await new Promise((resolve) => setImmediate(resolve));

	const frame = lastFrame(stdout.writes);
	instance.unmount();
	instance.cleanup();

	const path = `docs/screens/${name}.svg`;
	writeFileSync(path, toSvg(frame, title));
	process.stdout.write(`${path}  ${frame.split("\n").length} lines\n`);
}

async function main() {
	setColorDepth("truecolor");

	await capture("town", "A town, seen from the road", () => undefined);

	await capture("conversation", "Talking to somebody", (engine) => {
		const npc = engine.getNpcs().all()[0];
		if (!npc) return;
		engine.dispatch({ t: "ApplyEffects", effects: [{ t: "Teleport", x: npc.x, y: npc.y - 1 }] });
		engine.dispatch({ t: "DialogueOpened", npcId: npc.id, npcName: npc.spec.name });
		engine.dispatch({
			t: "DialogueTurn",
			npcId: npc.id,
			speaker: npc.spec.name,
			text: "You have the look of somebody who walked here. Nobody walks here on purpose.",
			choices: ["What is this place?", "I am looking for work.", "Nothing. Good day."],
		});
	});

	await capture(
		"quest",
		"An open errand, with a bearing back to the town that gave it",
		(engine, site) => {
			// Discovered, then walked away from, so the quest carries a real bearing
			// rather than reading "here".
			engine.dispatch({ t: "ChunkReady", key: chunkKey(site.mx, site.my) });
			engine.dispatch({
				t: "ApplyEffects",
				effects: [
					{
						t: "CreateQuest",
						id: "timber",
						name: "Timber for the mill",
						description: "The miller wants three lengths of sawn timber.",
						objectives: [
							{ kind: "have", target: "Timber", quantity: 3, done: false },
							{ kind: "talk", target: "Sedge", done: false },
						],
						siteId: site.id,
					},
					{ t: "GrantItem", name: "Timber", description: "Rough-sawn planks.", quantity: 1 },
					{ t: "Teleport", x: site.site.x + CHUNK * 2, y: site.site.y - CHUNK },
				],
			});
		},
		"quests",
	);

	await capture(
		"inventory",
		"What you are carrying, and what an errand still wants",
		(engine, site) => {
			engine.dispatch({
				t: "ApplyEffects",
				effects: [
					{
						t: "GrantItem",
						name: "Timber",
						description: "Rough-sawn planks, still smelling of the mill.",
						quantity: 3,
					},
					{
						t: "GrantItem",
						name: "Cushion Moss",
						description: "A damp green cushion prised off a north-facing stone.",
						quantity: 2,
					},
					{
						t: "CreateQuest",
						id: "timber",
						name: "Timber for the mill",
						// More than is carried, so the objective has not latched and the pane
						// still shows the warning that guards it against being dropped.
						description: "The miller wants five lengths of sawn timber.",
						objectives: [{ kind: "have", target: "Timber", quantity: 5, done: false }],
						siteId: site.id,
					},
				],
			});
		},
		"inventory",
		// The cursor lands on the timber rather than the starting coin, so the shot
		// shows the warning that stops an errand item being thrown away.
		1,
	);

	await capture("inside", "Inside a building, where the crates are", (engine, site) => {
		// Stand in the doorway of the first building with an interior and step in.
		const building = engine
			.getChunks()
			.buildingsIn(site.mx, site.my)
			.find((b) => b.kind !== "ruin");
		if (!building) return;
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: building.door.x, y: building.door.y - 1 }],
		});
		// Facing the door, then walking into it, is how you enter.
		engine.dispatch({ t: "Move", facing: "down" });
		engine.dispatch({ t: "Move", facing: "down" });
	});
}

main();
