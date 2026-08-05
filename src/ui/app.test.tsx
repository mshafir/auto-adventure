import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../test/harness/ink.js";
import { createDialogueService } from "../ai/dialogue/dialogue.js";
import { fallbackLore, fallbackSite } from "../ai/director/fallback.js";
import { hashString } from "../core/rand/hash.js";
import type { ScenarioArc } from "../core/rules/arc.js";
import { createInitialState } from "../core/rules/state.js";
import { siteContext } from "../core/world/context.js";
import { type MacroSite, macroSite } from "../core/world/macro.js";
import { GameEngine } from "../engine/engine.js";
import App from "./app.js";
import { bindEngine } from "./store.js";

const SEED = hashString("app-test");

function findTown(seed: number): MacroSite {
	for (let radius = 0; radius < 16; radius++) {
		for (let my = -radius; my <= radius; my++) {
			for (let mx = -radius; mx <= radius; mx++) {
				const site = macroSite(seed, mx, my);
				if (site.kind === "town" || site.kind === "village") return site;
			}
		}
	}
	throw new Error("no town found");
}

/** An engine standing next to the first person in the nearest town. */
function engineBesideSomeone(arc?: ScenarioArc) {
	const site = findTown(SEED);
	const spec = fallbackSite(SEED, site, siteContext(SEED, site));
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
			seed: SEED,
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
		expect(text).toContain("IQJK pages");
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
		expect(text).not.toContain("IQJK pages");
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
	 * The screen with its line breaks collapsed.
	 *
	 * Wrapping is the point of the reader, so asserting on a whole sentence has to
	 * ignore where it wrapped — and collapsing whitespace is a stronger check than
	 * picking a fragment that happens to fit one line: it proves the sentence is
	 * present *entire*, which is exactly what was failing before.
	 */
	const flat = (screen: string) => screen.replace(/\s+/g, " ");

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

	it("is what the page key opens, straight from the map", async () => {
		readingQuests();
		const harness = renderInk(<App />, { columns: 120, rows: 34 });
		await harness.settle();
		expect(harness.screen()).not.toContain("THE HOLLOW TITHE");

		await harness.type("q");
		const read = harness.screen();
		harness.unmount();
		expect(read).toContain("THE HOLLOW TITHE");
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
	it("closes on the key of the page already open", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		await harness.type("q");
		const back = harness.screen();
		harness.unmount();
		expect(back).not.toContain("THE HOLLOW TITHE");
	});

	it("switches what is being read without dropping back to the map", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		await harness.type("j");
		const read = harness.screen();
		harness.unmount();

		expect(read).toContain("JOURNAL");
		expect(read).not.toContain("Arrows move");
	});

	it("says which keys it has taken", async () => {
		readingQuests();
		const harness = renderInk(<App initialTab="quests" />, { columns: 120, rows: 34 });
		await harness.settle();
		const read = harness.screen();
		harness.unmount();
		expect(read).toContain("Up/Dn read");
		expect(read).toContain("Esc back to map");
	});
});
