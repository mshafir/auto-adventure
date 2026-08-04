import { describe, expect, it } from "vitest";
import { type InkHarness, KEY, renderInk } from "../../../test/harness/ink.js";
import { hashString } from "../../core/rand/hash.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { Launcher } from "./launcher.js";

const SAVE: SaveSummary = {
	worldId: "hollowmoor",
	name: "hollowmoor",
	seed: hashString("hollowmoor"),
	at: { x: 4, y: 9 },
	day: 3,
	playedAt: 1000,
};

const SCENARIO: ScenarioSummary = {
	id: "drowned-archipelago",
	title: "The Drowned Archipelago",
	blurb: "Debt-collectors and rope.",
	path: "/tmp/x.json",
	siteCount: 13,
};

interface Mounted {
	readonly ink: InkHarness;
	readonly chosen: LaunchChoice[];
	readonly quits: number[];
}

function mount(
	options: { saves?: SaveSummary[]; canUseModel?: boolean; unavailableNote?: string } = {},
): Mounted {
	const chosen: LaunchChoice[] = [];
	const quits: number[] = [];
	const saves = options.saves ?? [SAVE];
	const ink = renderInk(
		<Launcher
			saves={saves}
			scenarios={[SCENARIO]}
			canUseModel={options.canUseModel ?? true}
			{...(options.unavailableNote ? { unavailableNote: options.unavailableNote } : {})}
			context={{ saves, baseWorldId: "default", noAi: false }}
			onChoose={(choice) => chosen.push(choice)}
			onQuit={() => quits.push(1)}
		/>,
	);
	return { ink, chosen, quits };
}

/** Step onto the "Briefed" row and open the field. With no saves the rows are
 * scenario, then Briefed. */
async function openBrief(m: Mounted) {
	await m.ink.settle();
	await m.ink.type(KEY.down);
	await m.ink.type(KEY.enter);
}

describe("the launcher", () => {
	it("shows what there is to continue, play and start", async () => {
		const { ink } = mount();
		await ink.settle();
		const text = ink.screen();
		expect(text).toContain("Continue");
		expect(text).toContain("hollowmoor");
		expect(text).toContain("Scenarios");
		expect(text).toContain("The Drowned Archipelago");
		expect(text).toContain("New world");
		ink.unmount();
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

	it("starts with a selection on the first real row", async () => {
		const { ink } = mount();
		await ink.settle();
		expect(ink.screen()).toMatch(/❯ hollowmoor/);
		ink.unmount();
	});

	it("resumes the highlighted save on ENTER", async () => {
		const { ink, chosen } = mount();
		await ink.settle();
		await ink.type(KEY.enter);
		expect(chosen).toHaveLength(1);
		expect(chosen[0]?.worldId).toBe("hollowmoor");
		expect(chosen[0]?.mustExist).toBe(true);
		ink.unmount();
	});

	it("walks past the headings when moving down", async () => {
		const { ink, chosen } = mount();
		await ink.settle();
		// One row below the only save is the scenario, with a heading in between that
		// the cursor has to step over.
		await ink.type(KEY.down);
		await ink.type(KEY.enter);
		expect(chosen[0]?.flavour).toBe("prebuilt");
		expect(chosen[0]?.worldId).toBe("drowned-archipelago");
		ink.unmount();
	});

	it("asks for a brief before starting a briefed world", async () => {
		const m = mount({ saves: [] });
		await openBrief(m);
		expect(m.ink.screen()).toContain("What should this world be about?");
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});

	it("carries the typed premise into the choice", async () => {
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type("a drowned archipelago");
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.brief?.premise).toBe("a drowned archipelago");
		m.ink.unmount();
	});

	it("shows what is being typed", async () => {
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type("rope");
		expect(m.ink.screen()).toContain("rope");
		m.ink.unmount();
	});

	it("erases on backspace", async () => {
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type("rope");
		await m.ink.type(KEY.backspace);
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.brief?.premise).toBe("rop");
		m.ink.unmount();
	});

	it("does not put arrow keys into the brief", async () => {
		// Without filtering these, pressing up would insert a raw escape sequence.
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type("rope");
		await m.ink.type(KEY.up);
		await m.ink.type(KEY.down);
		await m.ink.type(KEY.enter);
		expect(m.chosen[0]?.brief?.premise).toBe("rope");
		m.ink.unmount();
	});

	it("treats an empty brief as no brief", async () => {
		// Whitespace is not an instruction. The world should be unguided rather than
		// prompted with a blank.
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type("   ");
		await m.ink.type(KEY.enter);
		expect(m.chosen).toHaveLength(1);
		expect(m.chosen[0]?.brief).toBeUndefined();
		m.ink.unmount();
	});

	it("goes back to the list when the brief is abandoned", async () => {
		const m = mount({ saves: [] });
		await openBrief(m);
		await m.ink.type(KEY.escape);
		expect(m.ink.screen()).toContain("New world");
		expect(m.chosen).toHaveLength(0);
		m.ink.unmount();
	});

	it("says why a live world is missing, in the caller's words", async () => {
		// The reason differs — a missing key or a deliberate NO_AI — and giving the
		// wrong one is worse than giving none, so the launcher does not guess.
		const { ink } = mount({ canUseModel: false, unavailableNote: "NO_AI is set." });
		await ink.settle();
		const text = ink.screen();
		expect(text).toContain("NO_AI is set.");
		expect(text).not.toContain("Unguided");
		ink.unmount();
	});

	it("offers no explanation when none was given", async () => {
		const { ink } = mount({ canUseModel: false });
		await ink.settle();
		expect(ink.screen()).not.toContain("not on offer");
		ink.unmount();
	});

	it("quits on Q without choosing anything", async () => {
		const { ink, chosen, quits } = mount();
		await ink.settle();
		await ink.type("q");
		expect(quits).toHaveLength(1);
		expect(chosen).toHaveLength(0);
		ink.unmount();
	});
});
