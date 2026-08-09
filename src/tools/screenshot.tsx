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
import type { ScenarioArc } from "../core/rules/arc.js";
import { openingCard } from "../core/rules/opening.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { CHUNK, chunkKey } from "../core/world/coords.js";
import { type MacroSite, macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { GameEngine } from "../engine/engine.js";
import App from "../ui/app.js";
import type { PanelTab } from "../ui/hud-state.js";
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
	const world = worldSeed(seed);
	for (let radius = 0; radius < 20; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(world, mx, my);
				if (site.kind === "town") return site;
			}
		}
	}
	throw new Error("no town found");
}

/**
 * A story for the shots that show one.
 *
 * The quest pane pins the arc above the errands, so a screenshot built from a world
 * with no arc would show the pane with its most important half missing.
 */
function shotArc(siteId: number): ScenarioArc {
	return {
		title: "The Hollow Tithe",
		premise: "Your sister took the warden's badge, walked the road east, and stopped writing.",
		beats: [
			{
				id: "the-short-tally",
				order: 0,
				siteId,
				npcSlot: 0,
				requires: [],
				setsFlag: "arc:the-short-tally",
				quest: {
					id: "tally",
					name: "Take the tally to Stonewait",
					description: "…",
					objectives: [{ kind: "reach", target: "Stonewait", done: true }],
				},
			},
			{
				id: "the-second-weight",
				order: 1,
				siteId,
				npcSlot: 0,
				requires: ["arc:the-short-tally"],
				setsFlag: "arc:the-second-weight",
				quest: {
					id: "timber",
					name: "Timber for the mill",
					description: "…",
					objectives: [],
				},
			},
			{
				id: "the-crown-yard",
				order: 2,
				siteId,
				npcSlot: 0,
				requires: ["arc:the-second-weight"],
				setsFlag: "arc:the-crown-yard",
			},
		],
	};
}

function buildEngine(withArc = false) {
	const site = findTown(SEED);
	const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
	const base = createInitialState(
		{ id: "shot", name: "shot", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
		site.site,
	);
	const engine = new GameEngine(withArc ? { ...base, arc: shotArc(site.id) } : base, {
		runEffect: () => undefined,
		specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
		siteSpec: (id) => (id === site.id ? spec : undefined),
	});
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
	tab?: PanelTab,
	cursor?: number,
	withArc = false,
) {
	if (WANTED.size > 0 && !WANTED.has(name)) return;
	const { engine, site } = buildEngine(withArc);
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

	// `--text` prints the frame instead of writing it. The SVGs are for the README
	// and have to be looked at in a browser; this is for checking a layout change
	// from the terminal that made it, without a round trip through a human.
	if (TEXT_ONLY) {
		process.stdout.write(`\n── ${name}: ${title} ${"─".repeat(Math.max(0, 60 - name.length))}\n`);
		process.stdout.write(`${stripAnsi(frame)}\n`);
		return;
	}

	const path = `docs/screens/${name}.svg`;
	writeFileSync(path, toSvg(frame, title));
	process.stdout.write(`${path}  ${frame.split("\n").length} lines\n`);
}

const TEXT_ONLY = process.argv.includes("--text");
/** Only these shots, when named; all of them otherwise. */
const WANTED = new Set(process.argv.slice(2).filter((arg) => !arg.startsWith("--")));

async function main() {
	setColorDepth("truecolor");

	await capture("town", "A town, seen from the road", (engine, site) => {
		// Walked here rather than dropped here. Without some ground behind them the
		// minimap in the corner is an empty box, which reads as a panel that failed
		// to load rather than as a map still to be filled in.
		const walked: string[] = [];
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -6; dx <= 6; dx++) {
				walked.push(chunkKey(site.mx + dx, site.my + dy));
			}
		}
		engine.dispatch({ t: "ChunkReady", keys: walked });
	});

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
		"The story so far, and the errand in hand",
		(engine, site) => {
			engine.dispatch({ t: "ChunkReady", keys: [chunkKey(site.mx, site.my)] });
			engine.dispatch({
				t: "ApplyEffects",
				effects: [
					{ t: "SetFlag", key: "arc:the-short-tally", value: true },
					{ t: "SetFlag", key: "arc:the-second-weight", value: true },
					{
						t: "RecordJournal",
						entry: {
							kind: "event",
							text: "Ilse Marrow says a warden came through in autumn with a new badge and would not give a name, and that the Cord House tally has been short by about a cord every month since the levy doubled.",
							source: "arc:the-short-tally",
						},
					},
					{
						t: "RecordJournal",
						entry: {
							kind: "event",
							text: "Warden Cull confirms it: the badge was signed out in autumn and never signed back in. Two tallies leave the weighing station and only one of them is true.",
							source: "arc:the-second-weight",
						},
					},
					{
						t: "CreateQuest",
						id: "tally",
						name: "Take the tally to Stonewait",
						description: "Carry Ilse's own count up the high road.",
						objectives: [{ kind: "reach", target: "Stonewait", done: true }],
						siteId: site.id,
					},
					{ t: "CompleteQuest", id: "tally" },
					{
						t: "CreateQuest",
						id: "timber",
						name: "Timber for the mill",
						description:
							"The miller wants three lengths of sawn timber, and will not take the ones that came off the barge because they have been in the water since the narrows.",
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
		undefined,
		true,
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

	await capture("key", "What the glyphs on the map mean", () => undefined, "key");

	await capture("opening", "How a game introduces itself", (engine) => {
		// The card every flavour opens on, assembled from what the world knows about
		// itself. Raised directly here because the screenshot tool builds its own engine
		// rather than going through `buildSession`, which is what raises it in play.
		engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "ShowCard",
					card: openingCard({
						lore: fallbackLore(),
						placeName: "Harrowmere",
						landscape: "old forest",
						brief: {
							protagonist: "a timber-tallier walking the road out of season",
							storyline: "the player is looking for a sibling who stopped writing",
						},
						start: {
							place: "Bracken Cross",
							person: "Ilse Marrow",
							bearing: "to the west",
							distance: 150,
						},
					}),
				},
			],
		});
	});

	await capture("inside", "Inside a building, where somebody is home", (engine, site) => {
		// A building with somebody in it, so the shot shows a room that is lived in
		// rather than a room with furniture in it.
		const building =
			engine
				.getChunks()
				.buildingsIn(site.mx, site.my)
				.find(
					(b) => b.kind !== "ruin" && engine.getResidents().in(b.interiorId, b.kind).length > 0,
				) ??
			engine
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

		// Then stand beside whoever is home and look at them, so the shot shows the
		// examine line for a resident rather than for a crate.
		const inside = engine.getState().player.inside;
		if (!inside) return;
		const resident = engine.getResidents().in(inside.interiorId, inside.structure)[0];
		if (!resident) return;
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "Teleport", x: resident.x, y: resident.y + 1 }],
		});
		engine.dispatch({ t: "Move", facing: "up" });
	});
}

main();
