import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { renderInk } from "../../test/harness/ink.js";
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
		expect(text).toContain("MWIQJ panels");
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
		// The panel keys do not work mid-sentence, so they are not advertised.
		expect(text).not.toContain("MWIQJ panels");
	});
});

describe("the side panels", () => {
	it("explains the map's glyphs rather than leaving them to be guessed", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="map" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		expect(text).toContain("KEY");
		for (const label of ["you", "folk", "door", "chest", "water"]) {
			expect(text, `the key does not mention ${label}`).toContain(label);
		}
	});

	it("explains the minimap's glyphs too, which are a different alphabet", () => {
		const { engine } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = renderInk(<App initialTab="world" />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();
		for (const label of ["here", "town", "village", "errand"]) {
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
		expect(text).toContain("3x Timber");
		// The pane arrives focused, so the cursor is drawn and the detail follows it
		// — whatever the cursor happens to start on, which is the first thing the
		// player was given rather than the first thing this test added.
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

		// Fragments rather than whole sentences: the pane is 32 columns and wraps, so
		// asserting a phrase that spans a line break would fail on formatting alone.
		expect(text).toContain("THE TITHE 0/1");
		expect(text).toContain("Somebody has to pay for the");
		// The step it has reached, marked as still in hand rather than done.
		expect(text).toContain("[~] Find the season");
		// And the clue it has gathered.
		expect(text).toContain("CLUES");
		// Elided at 32 columns, which is the pane doing its job — the journal tab is
		// where a clue is read in full.
		expect(text).toContain("Ilse says the barge");
	});
});
