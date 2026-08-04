import { render } from "ink-testing-library";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { createDialogueService } from "../ai/dialogue/dialogue.js";
import { fallbackLore, fallbackSite } from "../ai/director/fallback.js";
import { hashString } from "../core/rand/hash.js";
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
function engineBesideSomeone() {
	const site = findTown(SEED);
	const spec = fallbackSite(SEED, site, siteContext(SEED, site));
	const engine = new GameEngine(
		createInitialState(
			{ id: "t", name: "t", seed: SEED, createdAt: "2026-01-01T00:00:00.000Z" },
			site.site,
		),
		{
			runEffect: () => undefined,
			specFor: (s) => (s.id === site.id ? spec.settlement : undefined),
			siteSpec: (id) => (id === site.id ? spec : undefined),
		},
	);
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
		const { lastFrame, unmount } = render(<App />);
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

		const { lastFrame, unmount } = render(<App />);
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
		const { lastFrame, unmount } = render(<App />);
		const rows = (lastFrame() ?? "").split("\n").filter((row) => row.length > 0);
		unmount();

		expect(rows.length).toBeGreaterThan(5);
		const widths = new Set(rows.map((row) => stringWidth(stripAnsi(row))));
		expect(widths.size, `rows had differing widths: ${[...widths].join(", ")}`).toBe(1);
	});

	it("names the place the player is standing in", () => {
		const { engine, spec } = engineBesideSomeone();
		bindEngine(engine);
		const { lastFrame, unmount } = render(<App />);
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

		const { lastFrame, unmount } = render(<App />);
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

		const { lastFrame, unmount } = render(<App />);
		const text = stripAnsi(lastFrame() ?? "");
		unmount();

		const line = engine.getState().dialogue?.lines.at(-1)?.text;
		expect(line).toBeTruthy();
		expect(text).toContain(target.name);
		// The panel is choice-driven, so the offered replies must be on screen.
		expect(text).toContain("SPACE");
	});
});
