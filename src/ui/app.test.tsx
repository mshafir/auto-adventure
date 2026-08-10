import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../test/harness/ink.js";
import { createDialogueService } from "../ai/dialogue/dialogue.js";
import { fallbackLore, fallbackSite } from "../ai/director/fallback.js";
import { clearTranscript, recordExchange, setDebugAi } from "../ai/transcript.js";
import { hashString } from "../core/rand/hash.js";
import type { ScenarioArc } from "../core/rules/arc.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { type MacroSite, macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";
import { GameEngine } from "../engine/engine.js";
import App from "./app.js";
import { mapLegend } from "./panels/legend.js";
import { MAX_PLACEHOLDER_INDEX, PLACEHOLDER } from "./render/kitty.js";
import { bindEngine } from "./store.js";
import { setTileMode } from "./viewport.js";

const SEED = hashString("app-test");

function findTown(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(worldSeed(seed), mx, my);
				if (site.kind === "town" || site.kind === "village") return site;
			}
		}
	}
	throw new Error("no town found");
}

/** An engine standing next to the first person in the nearest town. */
function engineBesideSomeone(arc?: ScenarioArc) {
	const site = findTown(SEED);
	const spec = fallbackSite(worldSeed(SEED), site, siteContext(worldSeed(SEED), site));
	const base = createInitialState(
		{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
		site.site,
	);
	const engine = new GameEngine(arc ? { ...base, arc } : base, {
		runEffect: () => undefined,
		specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
		siteSpec: (id) => (id === site.id ? spec : undefined),
	});
	engine.getChunks().prefetch({ cx: site.mx, cy: site.my }, 2);
	engine.populateNpcs({ cx: site.mx, cy: site.my });

	const target = engine.getNpcs().all()[0];
	if (!target) throw new Error("no one was placed in this town");
	engine.dispatch({
		t: "ApplyEffects",
		effects: [{ t: "Teleport", x: target.x, y: target.y - 1 }],
	});
	return { engine, target, site, spec };
}

describe("the game screen", () => {
	it("stays shorter than the terminal, so Ink never clears the screen", () => {
		// Ink's renderer takes two paths: while the output is shorter than the
		// window it rewrites only the lines that changed, but the moment it is as
		// tall as the window it emits `clearTerminal` on *every* frame. The player
		// sees the second path as flicker on every keypress. The frame therefore
		// has to stay strictly under `stdout.rows`, whatever the panels contain.
		const rows = process.stdout.rows || 24;
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App />);
		const height = (lastFrame() ?? "").split("\n").length;
		unmount();
		expect(height, `frame is ${height} lines in a ${rows}-row terminal`).toBeLessThan(rows);
	});

	it("keeps that height once a conversation with four replies is open", async () => {
		// The dialogue panel is the part that wants to grow: a long line plus a
		// full set of choices is several rows more than a greeting.
		const rows = process.stdout.rows || 24;
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		engine.dispatch({
			t: "DialogueTurn",
			npcId: target.id,
			speaker: target.name,
			text: "A very long reply ".repeat(30),
			choices: ["one ".repeat(30), "two", "three", "four"],
		});

		const { lastFrame, unmount } = renderInk(<App />);
		const height = (lastFrame() ?? "").split("\n").length;
		unmount();
		expect(height, `frame is ${height} lines in a ${rows}-row terminal`).toBeLessThan(rows);
	});

	it("draws every row at the same visible width", () => {
		// Escape sequences make this the only assertion that catches a glyph the
		// terminal renders double-width: the string looks fine and the row is one
		// column too long.
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App />);
		const rows = (lastFrame() ?? "").split("\n").filter((row) => row.length > 0);
		unmount();

		expect(rows.length).toBeGreaterThan(5);
		const widths = new Set(rows.map((row) => stringWidth(stripAnsi(row))));
		expect(widths.size, `rows had differing widths: ${[...widths].join(", ")}`).toBe(1);
	});

	it("names the place the player is standing in", () => {
		const { engine, spec } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain(spec.name);
	});

	it("says who is in front of you before you speak to them", () => {
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		// Face them without walking into them: the first press of a new direction
		// only turns.
		engine.dispatch({ t: "Move", facing: "down" });

		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain(target.name);
	});

	it("shows the conversation once it opens", async () => {
		const { engine, target, site, spec } = engineBesideSomeone();
		bindEngine(engine);
		const dialogue = createDialogueService({
			world: worldSeed(SEED),
			lore: () => fallbackLore(),
			regionSpec: () => undefined,
			siteSpec: (id) => (id === site.id ? spec : undefined),
			disabled: true,
		});

		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		await dialogue.runDialogueTurn(target.id, undefined, engine);

		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();

		const line = engine.getState().dialogue?.lines.at(-1)?.text;
		expect(line).toBeTruthy();
		expect(text).toContain(target.name);
		// The panel is choice-driven, so the offered replies must be on screen.
		expect(text).toContain("SPACE");
	});

	/**
	 * The panel has to say it is working on every turn, not only the opening one.
	 *
	 * The old condition was `pending && !line`, which is true exactly once: before the
	 * first reply arrives there is nothing else to draw. From the second turn on, `line`
	 * is the answer the player just picked, so the indicator was suppressed and the panel
	 * showed the player's own words with an empty space under them and a motionless "..."
	 * in the footer — indistinguishable from a conversation that had finished.
	 */
	function frameWhileThinking(turns: number): string {
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		for (let i = 0; i < turns; i++) {
			engine.dispatch({
				t: "DialogueTurn",
				npcId: target.id,
				speaker: target.name,
				text: `Reply ${i}.`,
				choices: ["Ask again", "Say nothing"],
			});
			// Answering is what puts the panel back into `pending` with a line on screen.
			engine.dispatch({ t: "Confirm" });
		}
		expect(engine.getState().dialogue?.pending).toBe(true);
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		return text;
	}

	it("says who it is waiting for on the first turn and on every turn after", () => {
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		// The opening turn: pending with nothing on screen yet, which always worked.
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		const { lastFrame, unmount } = renderInk(<App />);
		const opening = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(opening).toContain("is thinking");

		// The turn that was broken, and the one after it.
		expect(frameWhileThinking(1), "no indicator on the second turn").toContain("is thinking");
		expect(frameWhileThinking(3), "no indicator on the fourth turn").toContain("is thinking");
	});

	it("keeps what the player just said on screen while it waits", () => {
		// Drawn under the answer rather than instead of it: replacing the line would
		// mean the player's own words vanish the instant they commit to them.
		const text = frameWhileThinking(1);
		expect(text).toContain("Ask again");
		expect(text).toContain("is thinking");
	});

	it("shows the reply as it streams, in place of what the player said", () => {
		// The preview takes the line's rows rather than adding its own, so that when the
		// turn commits the text simply stops growing instead of jumping to a new position.
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		engine.dispatch({
			t: "DialogueTurn",
			npcId: target.id,
			speaker: target.name,
			text: "Well?",
			choices: ["I need the ledger", "Nothing"],
		});
		engine.dispatch({ t: "Confirm" });
		engine.dispatch({ t: "DialogueStreaming", npcId: target.id, text: "The ledger is" });

		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("The ledger is");
		expect(text).not.toContain("I need the ledger");
		// Still working, and still says so: the first token is not the last.
		expect(text).toContain("is thinking");
	});

	it("stops saying it is thinking once the reply lands", () => {
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		engine.dispatch({ t: "DialogueStreaming", npcId: target.id, text: "Half a sen" });
		engine.dispatch({
			t: "DialogueTurn",
			npcId: target.id,
			speaker: target.name,
			text: "Half a sentence, finished.",
		});

		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("Half a sentence, finished.");
		expect(text).not.toContain("is thinking");
		// The preview is dropped on commit, not left beside the line it became.
		expect(engine.getState().dialogue?.preview).toBeUndefined();
	});

	it("does not grow the frame while it is waiting", () => {
		// The indicator lives in the choices' rows, which are empty precisely while it
		// shows. If that stops being true the panel gets taller than `panelHeightFor`
		// claims and Ink starts clearing the screen on every keypress.
		const rows = process.stdout.rows || 24;
		const height = frameWhileThinking(1).split("\n").length;
		expect(height, `frame is ${height} lines in a ${rows}-row terminal`).toBeLessThan(rows);
	});
});

describe("the key bar", () => {
	/**
	 * Every binding the game has was previously undocumented anywhere on screen
	 * except the one line inside the conversation panel, so the only way to find
	 * out that `j` opened the journal was to read the source.
	 */
	it("names the keys, including the one that saves and leaves", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("M menu");
		expect(text).toContain("S save+quit");
		expect(text).toContain("Arrows move");
	});

	it("says what the arrow keys do once a conversation has them", () => {
		const { engine, target } = engineBesideSomeone();
		bindEngine(engine);
		engine.dispatch({ t: "DialogueOpened", npcId: target.id, npcName: target.name });
		engine.dispatch({
			t: "DialogueTurn",
			npcId: target.id,
			speaker: target.name,
			text: "Aye?",
			choices: ["Hello.", "Nothing."],
		});
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("Up/Dn choose");
		expect(text).toContain("Esc leave");
		// The page keys do not work mid-sentence, so they are not advertised.
		expect(text).not.toContain("M menu");
	});
});

describe("a very tall window", () => {
	/*
	 * Every placeholder row is anchored by a combining mark from a fixed table, and
	 * only 64 of the protocol's 297 entries are written down here — a deliberate
	 * limit, since the values cannot be computed and a wrong one silently draws the
	 * wrong slice of the image. Past the end `diacritic` throws, and on a window
	 * taller than about seventy-five rows that took the whole game down rather than
	 * drawing a shorter map.
	 */
	it("stops the map at the diacritic table instead of taking the game down", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		setTileMode("kitty");
		try {
			for (const rows of [40, 76, 120]) {
				const { lastFrame, unmount } = renderInk(<App />, { columns: 100, rows });
				const frame = lastFrame() ?? "";
				unmount();

				expect(stripAnsi(frame), `${rows} rows`).not.toContain("ERROR");
				const map = frame.split("\n").filter((line) => line.includes(PLACEHOLDER));
				expect(map.length, `${rows} rows`).toBeGreaterThan(0);
				expect(map.length, `${rows} rows`).toBeLessThanOrEqual(MAX_PLACEHOLDER_INDEX);
			}
		} finally {
			setTileMode(undefined);
		}
	});

	/*
	 * And every row of it whole. Ink measures with `wrap-ansi`, which counts the
	 * anchor marks from row 30 on as a column each, so a full-width row added up one
	 * too wide and had its last cell folded onto the next line — which on screen was
	 * the map tearing into stripes with the scrollback showing between them.
	 */
	it("keeps every map row the full width of the terminal", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		setTileMode("kitty");
		try {
			const { lastFrame, unmount } = renderInk(<App />, { columns: 100, rows: 76 });
			const frame = lastFrame() ?? "";
			unmount();
			const map = frame.split("\n").filter((line) => line.includes(PLACEHOLDER));
			expect(map.length).toBeGreaterThan(30);
			for (const [index, line] of map.entries()) {
				expect(line.split(PLACEHOLDER).length - 1, `map row ${index}`).toBe(100);
			}
		} finally {
			setTileMode(undefined);
		}
	});
});

describe("the pages", () => {
	it("explains the map's glyphs rather than leaving them to be guessed", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="key" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		for (const label of ["you", "folk", "door", "chest", "water"]) {
			expect(text, `the key does not mention ${label}`).toContain(label);
		}
	});

	/*
	 * The same page, drawn for the other renderer. It used to list glyph characters
	 * whichever one was running, so a player looking at sprites was handed a key to
	 * a map nobody was showing them.
	 */
	it("keys the colours instead, once the map is drawn as pixels", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		setTileMode("kitty");
		try {
			const { lastFrame, unmount } = renderInk(<App initialTab="key" />);
			const text = stripAnsi(lastFrame() ?? "");
			unmount();

			// The rule uppercases its label.
			expect(text).toContain("COLOURS ON THE MAP");
			// The things are still named; only the way they are shown has changed.
			for (const label of ["you", "door", "chest", "water"]) {
				expect(text, `the key does not mention ${label}`).toContain(label);
			}
			// And what pixel mode alone has to say: everyone is the same figure, so
			// disposition is carried entirely by colour.
			expect(text).toContain("wary");
			// No map glyph anywhere on the page.
			for (const glyph of mapLegend("glyph").map((entry) => entry.ch)) {
				if (glyph === "A") continue; // a capital A is also just a letter in prose
				expect(text, `the pixel key still shows ${glyph}`).not.toContain(glyph);
			}
		} finally {
			setTileMode(undefined);
		}
	});

	it("shows what is carried, with a cursor on it and its description below", () => {
		const { engine } = engineBesideSomeone();
		engine.dispatch({
			t: "ApplyEffects",
			effects: [{ t: "GrantItem", name: "Timber", description: "Rough-sawn planks.", quantity: 3 }],
		});
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="inventory" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("Timber");
		expect(text).toContain("x3");
		// The page has the arrow keys the moment it opens, so the cursor is drawn and
		// the detail follows it — whatever it happens to start on, which is the first
		// thing the player was given rather than the first thing this test added.
		expect(text).toContain("▸ ");
		const first = engine.getState().inventory[0];
		expect(first).toBeDefined();
		if (first) expect(text).toContain(first.description);
	});

	it("writes an objective as an instruction, not as its own tag", () => {
		// "have Timber x3" is the reducer's vocabulary; a quest log should not be
		// where the player reads the implementation.
		const { engine, site } = engineBesideSomeone();
		engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{
					t: "CreateQuest",
					id: "timber",
					name: "Timber for the mill",
					description: "Three lengths of sawn timber.",
					objectives: [
						{ kind: "have", target: "Timber", quantity: 3, done: false },
						{ kind: "talk", target: "Sedge", done: false },
					],
					siteId: site.id,
				},
			],
		});
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="quests" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("carry 3 Timber");
		expect(text).toContain("speak to Sedge");
		expect(text).not.toContain("have Timber");
	});

	it("keeps the main quest on screen without touching the cursor", () => {
		// The arc is not an errand — it has no bearing and cannot be walked to — and it
		// is the thing a player most often wants reminding of, so it is pinned rather
		// than being one selectable row among many.
		const site = findTown(SEED);
		const rope = {
			id: "rope",
			name: "Find the season's rope",
			description: "It went down in the narrows.",
			objectives: [{ kind: "have" as const, target: "Coil of rope", done: false }],
		};
		const { engine } = engineBesideSomeone({
			title: "The Tithe",
			premise: "Somebody has to pay for the rope.",
			beats: [
				{
					id: "met",
					order: 0,
					siteId: site.id,
					npcSlot: 0,
					requires: [],
					setsFlag: "arc:met",
					quest: rope,
				},
			],
		});
		engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{ t: "SetFlag", key: "arc:met", value: true },
				{
					t: "RecordJournal",
					entry: {
						kind: "event",
						text: "Ilse says the barge went down with every coil aboard.",
						source: "arc:met",
					},
				},
				{ t: "CreateQuest", ...rope, siteId: site.id },
			],
		});
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="quests" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();

		expect(text).toContain("THE TITHE — THE STORY SO FAR");
		expect(text).toContain("Somebody has to pay for the rope.");
		// The step it has reached, marked as still in hand rather than done.
		expect(text).toContain("[~] Find the season");
		// And the clue it has gathered.
		expect(text).toContain("CLUES");
		expect(text).toContain("Ilse says the barge");
	});
});

describe("reading a list in full", () => {
	/**
	 * The screen with its frame and its line breaks taken out.
	 *
	 * Wrapping is the point of the reader, so asserting on a whole sentence has to
	 * ignore where it wrapped — and collapsing whitespace is a stronger check than
	 * picking a fragment that happens to fit one line: it proves the sentence is
	 * present *entire*, which is exactly what was failing before.
	 *
	 * The border has to come out first or every wrap point carries a `┃` through
	 * the middle of the sentence being matched.
	 */
	const flat = (screen: string) => screen.replace(/[┃┏┓┗┛━]/g, " ").replace(/\s+/g, " ");

	/** The prose that was being cut in a 32-column pane. */
	const DESCRIPTION =
		"The miller wants three lengths of sawn timber, and will not take the ones that came off the barge because they have been in the water.";
	const CLUE =
		"Ilse Marrow says a warden came through in autumn with a new badge and would not give a name, and the tally has been short ever since.";

	function readingQuests() {
		const site = findTown(SEED);
		const timber = {
			id: "timber",
			name: "Timber for the mill",
			description: DESCRIPTION,
			objectives: [{ kind: "have" as const, target: "Timber", quantity: 3, done: false }],
		};
		const { engine } = engineBesideSomeone({
			title: "The Hollow Tithe",
			premise: "Your sister took the warden's badge and stopped writing.",
			beats: [
				{
					id: "the-short-tally",
					order: 0,
					siteId: site.id,
					npcSlot: 0,
					requires: [],
					setsFlag: "arc:the-short-tally",
					quest: timber,
				},
				{
					id: "the-second-weight",
					order: 1,
					siteId: site.id,
					npcSlot: 0,
					requires: ["arc:the-short-tally"],
					setsFlag: "arc:the-second-weight",
				},
			],
		});
		engine.dispatch({
			t: "ApplyEffects",
			effects: [
				{ t: "SetFlag", key: "arc:the-short-tally", value: true },
				{
					t: "RecordJournal",
					entry: { kind: "event", text: CLUE, source: "arc:the-short-tally" },
				},
				{ t: "CreateQuest", ...timber, siteId: site.id },
			],
		});
		bindEngine(engine);
		return engine;
	}

	it("shows a quest description in full", async () => {
		// The complaint this answers: at 32 columns the old side panel showed "The
		// miller wants three…" and the rest was simply gone.
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		const read = harness.screen();
		harness.unmount();

		expect(flat(read)).toContain(flat(DESCRIPTION));
	});

	it("shows a story clue in full, with its continuation lined up under it", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		const read = harness.screen();
		harness.unmount();

		expect(flat(read)).toContain(flat(CLUE));
		// The bullet's continuation is indented under the text, not under the marker.
		expect(read).toContain("• Ilse Marrow says");
	});

	// One key rather than four, and the tab strip then says what is in here — so
	// nothing has to be remembered before it can be found.
	it("is what the menu key opens, straight from the map", async () => {
		readingQuests();
		const harness = renderInk(<App />, { columns: 120, rows: 34 });
		await harness.settle();
		expect(harness.screen()).not.toContain("Carrying");

		await harness.type("m");
		const menu = harness.screen();
		harness.unmount();
		for (const label of ["Carrying", "Errands", "Journal", "Key"]) {
			expect(menu, `the strip does not offer ${label}`).toContain(label);
		}
	});

	it("walks the tabs on left and right, and steps in on down", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="inventory" />, { columns: 120, rows: 34 });
		await harness.settle();
		expect(harness.screen()).not.toContain("THE HOLLOW TITHE");

		await harness.type(KEY.right);
		expect(harness.screen()).toContain("THE HOLLOW TITHE");

		// The cursor is drawn either way; stepping in is what makes it live.
		await harness.type(KEY.down);
		const inList = harness.screen();
		harness.unmount();
		expect(inList).toContain("Up/Dn read");
	});

	it("comes back to the map on Esc, with the world still there", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		expect(harness.screen()).toContain("THE HOLLOW TITHE");

		await harness.type(KEY.escape);
		const back = harness.screen();
		harness.unmount();
		// The top bar is only drawn over the map, so its presence means the map is
		// back rather than the page still holding the frame.
		expect(back).toContain("Arrows move");
		expect(back).not.toContain("THE HOLLOW TITHE");
	});

	// The same press that opened it, which is what every other toggle does — and it
	// means Esc is not the only way back to the map.
	it("closes on the key that opened it", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		await harness.type("m");
		const back = harness.screen();
		harness.unmount();
		expect(back).not.toContain("THE HOLLOW TITHE");
	});

	it("switches what is being read without dropping back to the map", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		await harness.type(KEY.right);
		const read = harness.screen();
		harness.unmount();

		expect(read).toContain("JOURNAL");
		expect(read).not.toContain("Arrows move");
	});

	// Down means two different things and which one is not guessable from the
	// screen, so the bar says which.
	it("says which keys it has taken, and what down will do", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		expect(harness.screen()).toContain("Dn go in");

		await harness.type(KEY.down);
		const read = harness.screen();
		harness.unmount();
		expect(read).toContain("Up/Dn read");
		expect(read).toContain("Esc back to map");
	});
});

/**
 * The two things the story's own people get that nobody else does.
 *
 * Both follow from one fact — walking into them *is* the story moving — and both exist
 * because of the same report: errands turning up in the journal with no conversation
 * that could have handed them over, and no way to tell which of a town's six figures
 * the bearing on the map was pointing at.
 */
describe("the people the story turns on", () => {
	function arcAnchoring(site: { id: number }, slot: number): ScenarioArc {
		return {
			title: "The Tally",
			premise: "Somebody has to count the sacks.",
			beats: [
				{
					id: "first",
					order: 0,
					siteId: site.id,
					npcSlot: slot,
					requires: [],
					setsFlag: "arc:first",
				},
			],
		};
	}

	it("says so when you look at one", () => {
		const plain = engineBesideSomeone();
		const staged = engineBesideSomeone(arcAnchoring(plain.site, plain.target.spec.slot));
		bindEngine(staged.engine);
		// Already facing them: the helper stands the player one tile above. Walking on
		// would open the conversation, and looking is what is being tested.
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("the story turns on them");
	});

	it("says nothing of the kind about an ordinary resident", () => {
		const plain = engineBesideSomeone();
		bindEngine(plain.engine);
		const { lastFrame, unmount } = renderInk(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).not.toContain("the story turns on them");
	});
});

/**
 * The working, readable from inside the game.
 *
 * A page rather than a log line, and only a page when somebody asked for one: a tab
 * that is always there and always empty is a tab everybody steps past forever.
 */
describe("the working page", () => {
	afterEach(() => {
		setDebugAi(false);
		clearTranscript();
	});

	it("is not on the strip unless the prompts are being kept", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="key" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("Key");
		expect(text).not.toContain("Working");
	});

	it("shows what was asked and what came back, once they are", () => {
		setDebugAi(true);
		clearTranscript();
		recordExchange({
			kind: "site",
			model: "google/gemini-2.5-flash",
			system: "You name places.",
			prompt: "A village on a river called SLUICEFORD.",
			millis: 800,
			attempt: 1,
			usage: { inputTokens: 2000, outputTokens: 400 },
			object: { name: "Millford" },
		});

		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="debug" />, {
			columns: 100,
			rows: 40,
		});
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("Working");
		expect(text).toContain("SLUICEFORD");
		expect(text).toContain("Millford");
	});
});
