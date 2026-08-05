import { describe, expect, it } from "vitest";
import { type InkHarness, KEY, renderInk } from "../../../test/harness/ink.js";
import { hashString } from "../../core/rand/hash.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { Launcher } from "./launcher.js";

const NOW = Date.parse("2026-08-05T12:00:00.000Z");

const SAVE: SaveSummary = {
	worldId: "hollowmoor",
	name: "hollowmoor",
	seed: hashString("hollowmoor"),
	at: { x: 4, y: 9 },
	day: 3,
	playedAt: NOW - 26 * 60 * 60 * 1000,
	createdAt: "2026-07-12T09:00:00.000Z",
};

const SCENARIO: ScenarioSummary = {
	id: "drowned-archipelago",
	title: "The Drowned Archipelago",
	blurb: "Debt-collectors and rope.",
	path: "/tmp/x.json",
	siteCount: 13,
};

/** Enough worlds to need more than one row, and more than one screen. */
function manySaves(count: number): SaveSummary[] {
	return Array.from({ length: count }, (_, i) => ({
		worldId: `world-${i}`,
		name: `World ${i}`,
		seed: i,
		at: { x: i, y: i },
		day: i + 1,
		playedAt: NOW - (i + 1) * 60 * 60 * 1000,
		createdAt: "2026-06-01T09:00:00.000Z",
	}));
}

interface Mounted {
	readonly ink: InkHarness;
	readonly chosen: LaunchChoice[];
	readonly quits: number[];
	readonly deleted: string[];
}

function mount(
	options: {
		saves?: SaveSummary[];
		scenarios?: ScenarioSummary[];
		canUseModel?: boolean;
		unavailableNote?: string;
		columns?: number;
		rows?: number;
	} = {},
): Mounted {
	const chosen: LaunchChoice[] = [];
	const quits: number[] = [];
	const deleted: string[] = [];
	const saves = options.saves ?? [SAVE];
	const ink = renderInk(
		<Launcher
			saves={saves}
			scenarios={options.scenarios ?? [SCENARIO]}
			canUseModel={options.canUseModel ?? true}
			{...(options.unavailableNote ? { unavailableNote: options.unavailableNote } : {})}
			context={{ saves, baseWorldId: "default", noAi: false }}
			now={NOW}
			onChoose={(choice) => chosen.push(choice)}
			onDelete={(worldId) => deleted.push(worldId)}
			onQuit={() => quits.push(1)}
		/>,
		{
			...(options.columns !== undefined ? { columns: options.columns } : {}),
			...(options.rows !== undefined ? { rows: options.rows } : {}),
		},
	);
	return { ink, chosen, quits, deleted };
}

/**
 * A screen with its line wrapping undone, for matching a sentence that spans rows.
 *
 * Box-drawing goes first. Every page is inside a frame now, so a wrapped sentence
 * has a border character at each break, and collapsing the whitespace without
 * dropping those leaves `and a model │ │ writes the places` in the middle of it.
 */
const flowed = (screen: string) =>
	screen
		.replace(/[\u2500-\u257f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** From the title screen to the New page. Continue is above it when saves exist. */
async function toNew(m: Mounted, hasSaves = true) {
	await m.ink.settle();
	if (hasSaves) await m.ink.type(KEY.down);
	await m.ink.type(KEY.enter);
}

describe("the title screen", () => {
	it("names the game, its author, and how it was made", async () => {
		const { ink } = mount();
		await ink.settle();
		const text = ink.screen();
		expect(text).toContain("by Michael Shafir");
		expect(text).toContain("produced with the help of large language models");
		ink.unmount();
	});

	it("draws the banner as art, not as a wrapped mess", async () => {
		// A banner wider than the terminal does not read as a small title; it reads as
		// a rendering fault, which is the first thing anybody sees of the game.
		const { ink } = mount();
		await ink.settle();
		for (const line of ink.screen().split("\n")) {
			expect(line.length, line).toBeLessThanOrEqual(100);
		}
		expect(ink.screen()).toContain("█");
		ink.unmount();
	});

	it("falls back to plain words in a terminal too narrow for any banner", async () => {
		const chosen: LaunchChoice[] = [];
		const ink = renderInk(
			<Launcher
				saves={[]}
				scenarios={[]}
				canUseModel={false}
				context={{ saves: [], baseWorldId: "default", noAi: false }}
				now={NOW}
				onChoose={(choice) => chosen.push(choice)}
				onQuit={() => undefined}
			/>,
			{ columns: 40 },
		);
		await ink.settle();
		expect(ink.screen()).toContain("AUTO ADVENTURE");
		expect(ink.screen()).not.toContain("█");
		ink.unmount();
	});

	it("offers two ways on, and says how many worlds are waiting", async () => {
		const { ink } = mount();
		await ink.settle();
		const text = ink.screen();
		expect(text).toContain("Continue");
		expect(text).toContain("1 world");
		expect(text).toContain("New world");
		ink.unmount();
	});

	it("does not offer Continue when there is nothing to continue", async () => {
		const { ink } = mount({ saves: [] });
		await ink.settle();
		expect(ink.screen()).not.toContain("Continue");
		ink.unmount();
	});

	it("quits on Q, and on Esc, without choosing anything", async () => {
		for (const key of ["q", KEY.escape]) {
			const { ink, chosen, quits } = mount();
			await ink.settle();
			await ink.type(key);
			expect(quits, key).toHaveLength(1);
			expect(chosen, key).toHaveLength(0);
			ink.unmount();
		}
	});

	it("does not crash once its effects have run", async () => {
		// The harness exists for this: under `ink-testing-library` the first frame is
		// fine and the error only appears after the effects, so a synchronous
		// assertion would pass against a component that cannot take a keypress.
		const { ink } = mount();
		await ink.settle();
		expect(ink.screen()).not.toContain("ERROR");
		ink.unmount();
	});
});

describe("starting a new world", () => {
	it("explains each way of starting one, rather than naming it", async () => {
		const m = mount();
		await toNew(m);
		const text = m.ink.screen();
		for (const label of ["Briefed", "Unguided", "Without a model", "A written scenario"]) {
			expect(text, `no option called ${label}`).toContain(label);
		}
		// The paragraph is the whole reason this is its own page: five words cannot
		// say that one of these needs a network and the others do not. Matched against
		// the text with its wrapping collapsed, since a sentence spans several rows.
		const prose = flowed(text);
		expect(prose).toContain("No network and no key");
		expect(prose).toContain("a model writes the places and the people to match");
		m.ink.unmount();
	});

	it("asks for a brief before starting a briefed world", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("What should this world be about?");
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});

	it("carries the typed premise into the choice", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.enter);
		await m.ink.type("a drowned archipelago");
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.brief?.premise).toBe("a drowned archipelago");
		m.ink.unmount();
	});

	it("treats an empty brief as no brief", async () => {
		// Whitespace is not an instruction. The world should be unguided rather than
		// prompted with a blank.
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.enter);
		await m.ink.type("   ");
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.brief).toBeUndefined();
		m.ink.unmount();
	});

	it("goes back to the modes when the brief is abandoned", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.enter);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("Unguided");
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});

	it("starts an unguided world straight away", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.down);
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.flavour).toBe("live");
		expect(m.chosen[0]?.brief).toBeUndefined();
		m.ink.unmount();
	});

	it("says why the live options are missing, in the caller's words", async () => {
		// The reason differs — a missing key or a deliberate NO_AI — and giving the
		// wrong one is worse than giving none, so the launcher does not guess.
		const m = mount({ canUseModel: false, unavailableNote: "NO_AI is set." });
		await toNew(m);
		const text = m.ink.screen();
		expect(text).toContain("NO_AI is set.");
		// Shown but greyed: hiding it would read as the wrong build rather than a
		// missing key. Choosing lands on the one that works.
		expect(text).toContain("Briefed");
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.flavour).toBe("procedural");
		m.ink.unmount();
	});

	it("goes back to the title on Esc", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("by Michael Shafir");
		m.ink.unmount();
	});
});

describe("the scenarios page", () => {
	async function toScenarios(m: Mounted) {
		await toNew(m);
		for (let i = 0; i < 3; i++) await m.ink.type(KEY.down);
		await m.ink.type(KEY.enter);
	}

	it("gives a scenario its title and the blurb somebody wrote for it", async () => {
		const m = mount();
		await toScenarios(m);
		const text = m.ink.screen();
		expect(text).toContain("The Drowned Archipelago");
		expect(text).toContain("Debt-collectors and rope.");
		expect(text).toContain("13 places");
		m.ink.unmount();
	});

	it("begins the chosen scenario as a prebuilt world", async () => {
		const m = mount();
		await toScenarios(m);
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.flavour).toBe("prebuilt");
		expect(m.chosen[0]?.worldId).toBe("drowned-archipelago");
		m.ink.unmount();
	});

	it("cannot be opened when there are none installed", async () => {
		const m = mount({ scenarios: [] });
		await toNew(m);
		expect(m.ink.screen()).toContain("none installed");
		for (let i = 0; i < 3; i++) await m.ink.type(KEY.down);
		await m.ink.type(KEY.enter);
		// The cursor never lands on it, so ENTER starts the mode above instead.
		expect(m.chosen[0]?.flavour).toBe("procedural");
		m.ink.unmount();
	});

	it("goes back to the modes on Esc", async () => {
		const m = mount();
		await toScenarios(m);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("Unguided");
		m.ink.unmount();
	});
});

describe("continuing a world", () => {
	async function toContinue(m: Mounted) {
		await m.ink.settle();
		await m.ink.type(KEY.enter);
	}

	it("says how far in the world is, and when it was last touched", async () => {
		const m = mount();
		await toContinue(m);
		const text = m.ink.screen();
		expect(text).toContain("hollowmoor");
		expect(text).toContain("day 3");
		expect(text).toContain("at 4,9");
		// In words, because a timestamp makes the reader do the subtraction.
		expect(text).toContain("played yesterday");
		expect(text).toContain("made ");
		m.ink.unmount();
	});

	it("resumes the highlighted world on ENTER", async () => {
		const m = mount();
		await toContinue(m);
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.worldId).toBe("hollowmoor");
		expect(m.chosen[0]?.mustExist).toBe(true);
		m.ink.unmount();
	});

	it("asks before deleting, and does nothing if the answer is no", async () => {
		// A world is hours of play and there is no undo, so D can only ever raise the
		// question.
		const m = mount();
		await toContinue(m);
		await m.ink.type("d");
		expect(m.ink.screen()).toContain("gone for good");
		expect(m.deleted).toHaveLength(0);

		await m.ink.type("n");
		expect(m.deleted).toHaveLength(0);
		expect(m.ink.screen()).toContain("hollowmoor");
		m.ink.unmount();
	});

	it("deletes on Y, and the world leaves the page with it", async () => {
		const m = mount();
		await toContinue(m);
		await m.ink.type("d");
		await m.ink.type("y");
		expect(m.deleted).toEqual(["hollowmoor"]);
		expect(m.ink.screen()).not.toContain("hollowmoor");
		expect(m.ink.screen()).toContain("no worlds to go back to");
		m.ink.unmount();
	});

	it("does not resume anything while the question is up", async () => {
		// The confirm owns the keyboard, or ENTER would answer it and start the world
		// in the same keypress.
		const m = mount();
		await toContinue(m);
		await m.ink.type("d");
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(0);
		expect(m.deleted).toHaveLength(0);
		m.ink.unmount();
	});

	it("names the scenario a world came from", async () => {
		const m = mount({ saves: [{ ...SAVE, scenarioId: "drowned-archipelago" }] });
		await toContinue(m);
		expect(m.ink.screen()).toContain("drowned-archipelago");
		m.ink.unmount();
	});

	it("goes back to the title on Esc", async () => {
		const m = mount();
		await toContinue(m);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("by Michael Shafir");
		m.ink.unmount();
	});

	/*
	 * The list this replaces showed one world per row and did not scroll, so past a
	 * dozen the older half could not be reached at all. Cards in a grid show three or
	 * four times as many in the same space, and what still does not fit scrolls.
	 */
	it("lays the worlds out across the width, not one per row", async () => {
		const m = mount({ saves: manySaves(6), columns: 100, rows: 40 });
		await toContinue(m);
		const text = m.ink.screen();
		// Two names on one screen row is the whole claim.
		expect(text.split("\n").some((line) => /World 0.*World 1/.test(line))).toBe(true);
		m.ink.unmount();
	});

	it("moves across a row and down between rows", async () => {
		const m = mount({ saves: manySaves(6), columns: 100, rows: 40 });
		await toContinue(m);
		await m.ink.type(KEY.right);
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.worldId).toBe("world-1");
		m.ink.unmount();

		const down = mount({ saves: manySaves(6), columns: 100, rows: 40 });
		await toContinue(down);
		await down.ink.type(KEY.down);
		await down.ink.type(KEY.enter);
		// Three columns fit in a hundred, so down is three along.
		expect(down.chosen[0]?.worldId).toBe("world-3");
		down.ink.unmount();
	});

	it("scrolls to worlds that do not fit, and says it is doing so", async () => {
		// Two rows of three on this size, so world 8 starts off screen.
		const m = mount({ saves: manySaves(9), columns: 100, rows: 22 });
		await toContinue(m);
		expect(m.ink.screen()).toContain("showing 1-6");
		expect(m.ink.screen()).not.toContain("World 8");

		// Down twice lands on the last row; a third does nothing, since there is
		// nothing below it. Right walks along that row to the world that was hidden.
		for (let i = 0; i < 3; i++) await m.ink.type(KEY.down);
		expect(m.ink.screen()).toContain("World 8");
		expect(m.ink.screen()).toContain("showing 4-9");
		await m.ink.type(KEY.right);
		await m.ink.type(KEY.right);
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.worldId).toBe("world-8");
		m.ink.unmount();
	});

	it("says nothing about scrolling when everything is on screen", async () => {
		const m = mount({ saves: manySaves(3), columns: 100, rows: 40 });
		await toContinue(m);
		expect(m.ink.screen()).not.toContain("showing");
		m.ink.unmount();
	});

	/*
	 * Every page here lives in a fixed-height frame, and a frame that overflows does
	 * not scroll — Ink clips it, and the footer with the keys in it is the first thing
	 * to go.
	 */
	it("stays inside its frame however many worlds there are", async () => {
		for (const rows of [16, 24, 40]) {
			const m = mount({ saves: manySaves(30), columns: 100, rows });
			await toContinue(m);
			const lines = m.ink.screen().split("\n");
			expect(lines.length, `${rows} rows`).toBeLessThanOrEqual(rows);
			expect(m.ink.screen(), `${rows} rows`).toContain("ESC back");
			m.ink.unmount();
		}
	});
});
