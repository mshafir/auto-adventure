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
	path: "/tmp/drowned-archipelago",
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
	/** Keys the options page asked to be saved. An empty string is a forgetting. */
	readonly keys: string[];
	/** Model ids the launcher asked to be remembered, from either page that sets one. */
	readonly models: string[];
}

function mount(
	options: {
		saves?: SaveSummary[];
		scenarios?: ScenarioSummary[];
		canUseModel?: boolean;
		unavailableNote?: string;
		columns?: number;
		rows?: number;
		/** Absent means no Options page at all, which is the headless case. */
		gatewayKey?: string;
		keyFromEnv?: boolean;
		modelSet?: string;
		withOptions?: boolean;
	} = {},
): Mounted {
	const chosen: LaunchChoice[] = [];
	const quits: number[] = [];
	const deleted: string[] = [];
	const keys: string[] = [];
	const models: string[] = [];
	const saves = options.saves ?? [SAVE];
	const wantsOptions = options.withOptions ?? true;
	const canUseModel = options.canUseModel ?? true;
	// The launcher takes a live world to be on offer when it holds a key, so a
	// fixture that says a model is usable has to hold one. That is the real
	// configuration: `pickLaunch` never passes one without the other.
	const key = options.gatewayKey ?? (canUseModel ? "vck_launcher_test_key" : undefined);
	const ink = renderInk(
		<Launcher
			saves={saves}
			scenarios={options.scenarios ?? [SCENARIO]}
			canUseModel={canUseModel}
			{...(options.unavailableNote ? { unavailableNote: options.unavailableNote } : {})}
			{...(wantsOptions
				? {
						options: {
							...(key ? { gatewayKey: key } : {}),
							...(options.keyFromEnv ? { keyFromEnv: true } : {}),
							...(options.modelSet ? { modelSet: options.modelSet } : {}),
							settingsPath: "/home/somebody/.auto-adventure/settings.json",
							onSaveKey: (key) => keys.push(key),
							onChooseModel: (id) => models.push(id),
						},
					}
				: {})}
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
	return { ink, chosen, quits, deleted, keys, models };
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

/**
 * Down until the cursor is on the row with this label.
 *
 * By what is on screen rather than by a count of presses, because the cursor skips
 * rows it cannot land on — a page with no packs installed has two fewer stops than one
 * with them, and a fixed count silently ends up pressing ENTER on the wrong setting.
 */
async function toRow(m: Mounted, label: string) {
	for (let i = 0; i < 12; i++) {
		if (m.ink.screen().includes(`❯ ${label}`)) return;
		await m.ink.type(KEY.down);
	}
	throw new Error(`never reached a row called "${label}"`);
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

describe("choosing where a world comes from", () => {
	it("offers the finished scenarios first, and the cursor starts on one", async () => {
		const m = mount();
		await toNew(m);
		const text = m.ink.screen();
		expect(text).toContain("The Drowned Archipelago");
		expect(text).toContain("An unwritten world");
		// Finished first, because a written world is the one with a story in it.
		expect(text.indexOf("The Drowned Archipelago")).toBeLessThan(
			text.indexOf("An unwritten world"),
		);
		expect(text).toContain("❯ The Drowned Archipelago");
		m.ink.unmount();
	});

	it("gives a scenario its blurb and its size, on the page it is chosen from", async () => {
		// These used to be on a page of their own, which meant "New" showed four ways of
		// generating and hid the things that were already written behind one of them.
		const m = mount();
		await toNew(m);
		const text = m.ink.screen();
		expect(text).toContain("Debt-collectors and rope.");
		expect(text).toContain("13 places");
		m.ink.unmount();
	});

	it("begins the chosen scenario as a prebuilt world", async () => {
		const m = mount();
		await toNew(m);
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.flavour).toBe("prebuilt");
		expect(m.chosen[0]?.worldId).toBe("drowned-archipelago");
		m.ink.unmount();
	});

	it("separates the unwritten world from the shelf it sits under", async () => {
		// A rule, so two unlike kinds of choice look unlike. With nothing above it there is
		// nothing to separate, and drawing one anyway reads as a heading for a list of one.
		const withShelf = mount();
		await toNew(withShelf);
		expect(flowed(withShelf.ink.screen())).toContain("OR SOMEWHERE NOBODY HAS WRITTEN ABOUT");
		withShelf.ink.unmount();

		const empty = mount({ scenarios: [] });
		await toNew(empty);
		expect(flowed(empty.ink.screen())).not.toContain("OR SOMEWHERE NOBODY HAS WRITTEN ABOUT");
		empty.ink.unmount();
	});

	it("starts a live world when a model can be reached", async () => {
		const m = mount({ canUseModel: true });
		await toNew(m);
		await toRow(m, "An unwritten world");
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.flavour).toBe("live");
		m.ink.unmount();
	});

	/*
	 * An unwritten world is still playable with no key: `procedural` names its places out of
	 * the flavour tables rather than asking anybody. So the row is never disabled — what
	 * changes is which flavour it starts and what it promises, and the launcher's note about
	 * a missing key belongs on the row rather than in place of it.
	 */
	it("starts a procedural world instead when there is no model, and says why", async () => {
		const m = mount({ canUseModel: false, unavailableNote: "NO_AI is set." });
		await toNew(m);
		expect(m.ink.screen()).toContain("NO_AI is set.");
		await toRow(m, "An unwritten world");
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.flavour).toBe("procedural");
		m.ink.unmount();
	});

	it("has nothing to offer but the unwritten world when nothing is installed", async () => {
		const m = mount({ scenarios: [] });
		await toNew(m);
		const text = m.ink.screen();
		expect(text).toContain("❯ An unwritten world");
		expect(text).not.toContain("The Drowned Archipelago");
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

/** From the title screen onto the Options page. */
async function toOptions(m: Mounted) {
	await m.ink.settle();
	await toRow(m, "Options");
	await m.ink.type(KEY.enter);
}

describe("the options page", () => {
	it("is on the front door, because a key is the first thing a player needs", async () => {
		const m = mount({ canUseModel: false });
		await m.ink.settle();
		expect(m.ink.screen()).toContain("Options");
		// And it says why it matters while it still does. Once a key is set this is
		// just another row.
		expect(flowed(m.ink.screen())).toContain("no AI key yet");
		m.ink.unmount();
	});

	it("stops saying a key is missing once one is there", async () => {
		const m = mount({ canUseModel: true });
		await m.ink.settle();
		expect(flowed(m.ink.screen())).not.toContain("no AI key yet");
		m.ink.unmount();
	});

	it("never shows the key it is holding", async () => {
		// The one screen in the game where what is on it might be in a recording.
		const m = mount({ gatewayKey: "vck_secretsecretsecret" });
		await toOptions(m);
		expect(m.ink.screen()).not.toContain("secretsecret");
		expect(m.ink.screen()).toContain("vck_");
		m.ink.unmount();
	});

	it("saves a key that was typed", async () => {
		const m = mount({ canUseModel: false });
		await toOptions(m);
		await toRow(m, "AI gateway key");
		await m.ink.type(KEY.enter);
		await m.ink.type("vck_typed");
		await m.ink.type(KEY.enter);
		expect(m.keys).toEqual(["vck_typed"]);
		m.ink.unmount();
	});

	it("does not show the key back as it is typed", async () => {
		const m = mount({ canUseModel: false });
		await toOptions(m);
		await toRow(m, "AI gateway key");
		await m.ink.type(KEY.enter);
		await m.ink.type("vck_typed");
		expect(m.ink.screen()).not.toContain("vck_typed");
		m.ink.unmount();
	});

	it("leaves the key alone when nothing was typed", async () => {
		// ENTER on an empty field must not read as "forget my key", which is what a
		// field pre-filled with nothing and saved literally would mean.
		const m = mount({ gatewayKey: "vck_existing" });
		await toOptions(m);
		await toRow(m, "AI gateway key");
		await m.ink.type(KEY.enter);
		await m.ink.type(KEY.enter);
		expect(m.keys).toEqual([]);
		m.ink.unmount();
	});

	it("offers a live world the moment a key is saved, without restarting", async () => {
		const m = mount({ canUseModel: false });
		await toOptions(m);
		await toRow(m, "AI gateway key");
		await m.ink.type(KEY.enter);
		await m.ink.type("vck_typed");
		await m.ink.type(KEY.enter);
		await m.ink.type(KEY.escape);
		await m.ink.settle();
		expect(flowed(m.ink.screen())).not.toContain("no AI key yet");
		m.ink.unmount();
	});

	it("can forget a key, and stops offering to once it has", async () => {
		const m = mount({ gatewayKey: "vck_existing" });
		await toOptions(m);
		await toRow(m, "Forget the key");
		await m.ink.type(KEY.enter);
		expect(m.keys).toEqual([""]);
		await m.ink.settle();
		expect(m.ink.screen()).not.toContain("Forget the key");
		m.ink.unmount();
	});

	it("refuses to pretend it can edit a key the environment owns", async () => {
		// A real environment variable wins everywhere. A page that let somebody type
		// over it and then changed nothing would be lying to them.
		const m = mount({ gatewayKey: "vck_fromenv", keyFromEnv: true });
		await toOptions(m);
		expect(flowed(m.ink.screen())).toContain("from the environment");
		expect(m.ink.screen()).not.toContain("Forget the key");
		m.ink.unmount();
	});

	it("changes the model with the horizontal arrows and remembers it", async () => {
		const m = mount({ modelSet: "gemini-2.5" });
		await toOptions(m);
		await toRow(m, "Model");
		await m.ink.type(KEY.right);
		expect(m.models).toHaveLength(1);
		expect(m.models[0]).not.toBe("gemini-2.5");
		m.ink.unmount();
	});

	it("says what a model costs against the one it replaces", async () => {
		const m = mount({ modelSet: "claude-sonnet" });
		await toOptions(m);
		const text = flowed(m.ink.screen());
		expect(text).toContain("Claude Sonnet 5");
		expect(text).toMatch(/[\d.]+× the default/);
		m.ink.unmount();
	});

	it("is not reachable at all when nothing is bound to it", async () => {
		// A headless or scripted run has no settings file to write to, and a page
		// that opened onto nothing would be worse than no page.
		const m = mount({ withOptions: false });
		await m.ink.settle();
		expect(m.ink.screen()).not.toContain("Options");
		m.ink.unmount();
	});
});
