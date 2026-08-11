import { describe, expect, it } from "vitest";
import { type InkHarness, KEY, renderInk } from "../../../test/harness/ink.js";
import type { PackEntry } from "../../content/load.js";
import type { TilePackEntry } from "../../content/tiles.js";
import { hashString } from "../../core/rand/hash.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { GenerateRequest, LaunchChoice } from "../../scenario/scenario.js";
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
	/** Worlds asked to be written, which is not the same as worlds chosen. */
	readonly requested: GenerateRequest[];
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
		tilePacks?: TilePackEntry[];
		contentPacks?: PackEntry[];
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
	const requested: GenerateRequest[] = [];
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
			tilePacks={options.tilePacks ?? []}
			contentPacks={options.contentPacks ?? []}
			now={NOW}
			onChoose={(choice) => chosen.push(choice)}
			onDelete={(worldId) => deleted.push(worldId)}
			onGenerate={(request) => requested.push(request)}
			onQuit={() => quits.push(1)}
		/>,
		{
			...(options.columns !== undefined ? { columns: options.columns } : {}),
			...(options.rows !== undefined ? { rows: options.rows } : {}),
		},
	);
	return { ink, chosen, requested, quits, deleted, keys, models };
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
 * Onto the Generate row, which sits under every installed scenario.
 *
 * Counted from the scenarios rather than written as a fixed number of presses, so a test
 * that changes the fixture list does not silently start pressing ENTER on a scenario.
 */
async function toGenerate(m: Mounted, scenarios = 1) {
	for (let i = 0; i < scenarios; i++) await m.ink.type(KEY.down);
}

/** From the title screen all the way to the config page. */
async function toConfig(m: Mounted, scenarios = 1) {
	await toNew(m);
	await toGenerate(m, scenarios);
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
		expect(text).toContain("Generate a New Scenario");
		// Finished first, because it is the only kind that is ready before ENTER.
		expect(text.indexOf("The Drowned Archipelago")).toBeLessThan(
			text.indexOf("Generate a New Scenario"),
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

	it("separates generating from the shelf it sits under", async () => {
		// A rule, so two unlike kinds of choice look unlike. With nothing above it there is
		// nothing to separate, and drawing one anyway reads as a heading for a list of one.
		const withShelf = mount();
		await toNew(withShelf);
		expect(flowed(withShelf.ink.screen())).toContain("OR HAVE ONE WRITTEN");
		withShelf.ink.unmount();

		const empty = mount({ scenarios: [] });
		await toNew(empty);
		expect(flowed(empty.ink.screen())).not.toContain("OR HAVE ONE WRITTEN");
		empty.ink.unmount();
	});

	it("says generating is not on offer, in the caller's words", async () => {
		// The reason differs — a missing key or a deliberate NO_AI — and giving the wrong
		// one is worse than giving none, so the launcher does not guess.
		const m = mount({ canUseModel: false, unavailableNote: "NO_AI is set." });
		await toNew(m);
		expect(m.ink.screen()).toContain("NO_AI is set.");
		// Shown but greyed rather than hidden, so it does not read as the wrong build. The
		// cursor cannot reach it, so pressing down and ENTER still takes the scenario.
		await toGenerate(m);
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.flavour).toBe("prebuilt");
		m.ink.unmount();
	});

	it("has nothing to offer but generating when nothing is installed", async () => {
		const m = mount({ scenarios: [] });
		await toNew(m);
		const text = m.ink.screen();
		expect(text).toContain("❯ Generate a New Scenario");
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

describe("configuring a world to be written", () => {
	it("shows every setting with its current value", async () => {
		const m = mount();
		await toConfig(m);
		const text = m.ink.screen();
		for (const label of [
			"Length",
			"Premise",
			"Look",
			"Names and trades",
			"Day and night",
			"Improvise while playing",
			"Write this world",
		]) {
			expect(text, `no setting called ${label}`).toContain(label);
		}
		// Defaults, visible rather than implied: a settings page whose values are hidden
		// until you touch them is a page nobody can check before spending four minutes.
		expect(text).toContain("medium");
		expect(text).toContain("let the model choose");
		m.ink.unmount();
	});

	it("says roughly what it will cost before anything is spent", async () => {
		const m = mount();
		await toConfig(m);
		// On a line of its own rather than in a paragraph, so it is readable wherever the
		// cursor happens to be — which on a 24-row terminal is the only way it is readable
		// at all, because only the selected row gets a paragraph.
		const prose = flowed(m.ink.screen());
		expect(prose).toContain("~60 model calls");
		expect(prose).toContain("cannot be paused");
		m.ink.unmount();
	});

	it("costs more for a longer world, and says so", async () => {
		const m = mount();
		await toConfig(m);
		await m.ink.type(KEY.right);
		const longer = flowed(m.ink.screen());
		expect(longer).toContain("long");
		expect(longer).toContain("~120 model calls");
		expect(longer).not.toContain("~60 model calls");
		m.ink.unmount();
	});

	it("cycles a setting with either arrow, and wraps at both ends", async () => {
		const m = mount();
		await toConfig(m);
		await m.ink.type(KEY.left);
		expect(m.ink.screen()).toContain("short");
		await m.ink.type(KEY.left);
		expect(m.ink.screen()).toContain("long");
		m.ink.unmount();
	});

	it("also cycles on ENTER, so the arrows need not be discovered", async () => {
		const m = mount();
		await toConfig(m);
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("long");
		m.ink.unmount();
	});

	it("turns the clock off and on", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Day and night");
		expect(m.ink.screen()).toContain("on");
		await m.ink.type(KEY.right);
		expect(m.ink.screen()).toContain("off");
		m.ink.unmount();
	});

	it("takes a premise and shows it back", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("ENTER to keep it");
		await m.ink.type("a drowned archipelago");
		await m.ink.type(KEY.enter);
		const text = m.ink.screen();
		expect(text).toContain("a drowned archipelago");
		// And the cursor is still where it was. The list used to be unmounted to show the
		// field, which took its cursor with it and sent the player back to the top.
		expect(text).toContain("❯ Premise");
		m.ink.unmount();
	});

	it("keeps the settings readable while the premise is being typed", async () => {
		// The field takes the footer's rows rather than the whole page, so the length and
		// the packs you already chose are still on screen while you write.
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		const text = m.ink.screen();
		expect(text).toContain("Length");
		expect(text).toContain("Write this world");
		expect(text).toContain("ESC to drop it");
		m.ink.unmount();
	});

	it("does not move the cursor while the premise is being typed", async () => {
		// Both the list and the field are mounted, so a stray arrow key must reach only
		// one of them. `isActive` is what makes that true.
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		await m.ink.type(KEY.down);
		await m.ink.type(KEY.enter);
		expect(m.ink.screen()).toContain("❯ Premise");
		m.ink.unmount();
	});

	it("keeps a premise typed and then abandoned out of the request", async () => {
		// ESC out of the field is "never mind", so what it leaves behind must not be
		// treated as an instruction.
		const m = mount();
		await toConfig(m);
		await toRow(m, "Premise");
		await m.ink.type(KEY.enter);
		await m.ink.type("   ");
		await m.ink.type(KEY.escape);
		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);
		expect(m.requested).toHaveLength(1);
		expect(m.requested[0]?.brief.premise).toBeUndefined();
		m.ink.unmount();
	});

	it("reports what was asked for, rather than a choice there is nothing to choose yet", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);
		expect(m.requested).toHaveLength(1);
		expect(m.requested[0]?.brief.duration).toBe("medium");
		expect(m.requested[0]?.dayAndNight).toBe(true);
		expect(m.requested[0]?.liveInGame).toBe(true);
		// No world exists, so there is nothing a LaunchChoice could honestly describe.
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});

	it("says what a pack is, rather than what the setting is for", async () => {
		// Choosing a look from a list of names is choosing blind, and it was: the row used
		// to explain the *knob* — the same sentence whichever pack the cursor had landed on.
		const m = mount({
			tilePacks: [
				{ name: "gramarye", description: "Inked and warm, with a deep sea.", preview: [] },
			],
			contentPacks: [{ name: "camelot", description: "Knights and oaths rather than coin." }],
		});
		await toConfig(m);
		await toRow(m, "Look");
		await m.ink.type(KEY.right);
		expect(m.ink.screen()).toContain("Inked and warm");
		await toRow(m, "Names and trades");
		await m.ink.type(KEY.right);
		expect(m.ink.screen()).toContain("Knights and oaths");
		m.ink.unmount();
	});

	it("still names a pack that describes nothing, rather than leaving the row blank", async () => {
		const m = mount({ tilePacks: [{ name: "unlabelled", preview: [] }] });
		await toConfig(m);
		await toRow(m, "Look");
		await m.ink.type(KEY.right);
		// A blank body reads as a pack that failed to load, which is a worse lie than
		// admitting the pack has no line of its own.
		expect(m.ink.screen()).toContain("does not describe itself");
		m.ink.unmount();
	});

	it("draws the chosen look, which is the only honest answer to what it looks like", async () => {
		const m = mount({
			tilePacks: [
				{
					name: "gramarye",
					description: "Inked and warm.",
					// Two rows of one distinctive cell each, so finding them on screen proves
					// the preview was drawn rather than that some other row happened to match.
					preview: [[{ ch: "≈", fg: [10, 20, 30] }], [{ ch: "▲", fg: [40, 50, 60] }]],
				},
			],
		});
		await toConfig(m);
		await toRow(m, "Look");
		await m.ink.type(KEY.right);
		const screen = m.ink.screen();
		expect(screen).toContain("≈");
		expect(screen).toContain("▲");
		m.ink.unmount();
	});

	it("carries the settings it was given into the request", async () => {
		const m = mount({
			tilePacks: [{ name: "gramarye", description: "Inked and warm.", preview: [] }],
			contentPacks: [{ name: "camelot", description: "Knights and oaths." }],
		});
		await toConfig(m);
		await m.ink.type(KEY.right); // length → long
		await toRow(m, "Look");
		await m.ink.type(KEY.right); // look → gramarye
		await toRow(m, "Names and trades");
		await m.ink.type(KEY.right); // names → camelot
		await toRow(m, "Day and night");
		await m.ink.type(KEY.right); // day and night → off
		await toRow(m, "Improvise while playing");
		await m.ink.type(KEY.right); // improvise → off
		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);

		expect(m.requested).toHaveLength(1);
		expect(m.requested[0]).toMatchObject({
			tiles: "gramarye",
			pack: "camelot",
			dayAndNight: false,
			liveInGame: false,
		});
		expect(m.requested[0]?.brief.duration).toBe("long");
		m.ink.unmount();
	});

	it("no longer asks whether to keep the working, because it always is", async () => {
		// The row it replaces defaulted to off, which put the prompt-by-prompt view behind
		// a question asked on the same screen that costs four minutes — so the run that
		// most wanted the view was reliably the run that did not have it.
		const m = mount();
		await toConfig(m);
		expect(m.ink.screen()).not.toContain("Keep the working");
		m.ink.unmount();
	});

	it("cannot pick a pack that is not installed", async () => {
		// Greyed rather than absent, so the row still explains what it would have done.
		const m = mount();
		await toConfig(m);
		const text = m.ink.screen();
		expect(text).toContain("Look");
		expect(text).toContain("the default");
		// The cursor skips both pack rows, so four downs from Length lands past them.
		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);
		expect(m.requested[0]?.tiles).toBeUndefined();
		expect(m.requested[0]?.pack).toBeUndefined();
		m.ink.unmount();
	});

	it("goes back to the shelf on Esc", async () => {
		const m = mount();
		await toConfig(m);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("The Drowned Archipelago");
		expect(m.requested).toHaveLength(0);
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

describe("choosing a model for a world", () => {
	it("offers the choice on the page that decides what a world costs", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Model");
		expect(flowed(m.ink.screen())).toContain("per Mtok");
		m.ink.unmount();
	});

	it("carries the choice onto the request, not just into settings", async () => {
		const m = mount();
		await toConfig(m);
		await toRow(m, "Model");
		await m.ink.type(KEY.right);
		const picked = m.models.at(-1);
		await toRow(m, "Write this world");
		await m.ink.type(KEY.enter);
		expect(m.requested).toHaveLength(1);
		expect(m.requested[0]?.models).toBe(picked);
		m.ink.unmount();
	});

	it("remembers a model that was browsed and then walked away from", async () => {
		// The price comparison is the reason to come here; making it only count when
		// a world is written would throw the answer away every time.
		const m = mount();
		await toConfig(m);
		await toRow(m, "Model");
		await m.ink.type(KEY.right);
		await m.ink.type(KEY.escape);
		expect(m.models).toHaveLength(1);
		m.ink.unmount();
	});

	it("says nothing about price while the default is chosen", async () => {
		// "at about 1× the usual price" is noise on the line every player reads
		// before every world.
		const m = mount({ modelSet: "gemini-2.5" });
		await toConfig(m);
		expect(flowed(m.ink.screen())).not.toContain("the usual price");
		m.ink.unmount();
	});

	it("warns on the cost line once a dearer model is chosen", async () => {
		const m = mount({ modelSet: "claude-sonnet" });
		await toConfig(m);
		const text = flowed(m.ink.screen());
		expect(text).toContain("model calls on Claude Sonnet 5");
		expect(text).toContain("the usual price");
		m.ink.unmount();
	});
});
