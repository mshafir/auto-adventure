import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../../test/harness/ink.js";
import { GenerateProgress } from "./generate-progress.js";

/**
 * What the player is told about a world that came out wrong.
 *
 * The screen this replaces printed "finished, with faults noted in the log", which told
 * them two useless things: that something is wrong, and that the answer is in a file they
 * have never opened and have no reason to know about — four minutes into a wait they had
 * just paid for.
 */

const AT = Date.parse("2026-08-06T12:00:00.000Z");

function mount(props: Partial<Parameters<typeof GenerateProgress>[0]> = {}) {
	const dismissed: number[] = [];
	const stopped: number[] = [];
	const ink = renderInk(
		<GenerateProgress
			columns={100}
			rows={24}
			depth="none"
			lines={["lore: The Long Siege", "named 4 regions"]}
			calls={12}
			startedAt={AT}
			onDismiss={() => dismissed.push(1)}
			onStop={() => stopped.push(1)}
			{...props}
		/>,
		{ columns: 100, rows: 24 },
	);
	return { ink, dismissed, stopped, screen: () => stripAnsi(ink.lastFrame() ?? "") };
}

describe("while a world is being written", () => {
	it("shows what each pass produced, so a wait is something to read", () => {
		const m = mount();
		const text = m.screen();
		expect(text).toContain("lore: The Long Siege");
		expect(text).toContain("named 4 regions");
		m.ink.unmount();
	});

	it("says how long it has been and how many calls it has cost", () => {
		const m = mount();
		expect(m.screen()).toContain("12 model calls");
		m.ink.unmount();
	});

	it("stops on ESC, and says stopping rather than pretending it was instant", async () => {
		const m = mount();
		await m.ink.settle();
		await m.ink.type(KEY.escape);
		expect(m.stopped).toHaveLength(1);
		m.ink.unmount();

		const stopping = mount({ stopping: true });
		expect(stopping.screen()).toContain("stopping after this pass");
		stopping.ink.unmount();
	});
});

describe("once it is written and something is wrong with it", () => {
	const FINDINGS = [
		{ severity: "warning", message: "6 of 12 people have nothing to say about the story" },
		{ severity: "error", message: 'beat "report-to-corbin" can never open' },
		{ severity: "warning", message: "329 tiles of walking between the first two beats" },
	];

	it("says what is wrong, in the words the validator wrote", () => {
		const m = mount({ findings: FINDINGS, path: "/x/.scenarios/a-world.json" });
		const text = m.screen();
		expect(text).toContain("can never open");
		expect(text).toContain("nothing to say about the story");
		m.ink.unmount();
	});

	it("puts the errors first, because a truncated list must not drop them", () => {
		const m = mount({ findings: FINDINGS });
		const text = m.screen();
		expect(text.indexOf("can never open")).toBeLessThan(text.indexOf("nothing to say"));
		m.ink.unmount();
	});

	it("says the world is playable, because an error reads as 'it did not work'", () => {
		const m = mount({ findings: FINDINGS });
		expect(m.screen()).toContain("playable");
		m.ink.unmount();
	});

	it("says where it was kept", () => {
		const m = mount({ findings: FINDINGS, path: "/x/.scenarios/a-world.json" });
		expect(m.screen()).toContain("a-world.json");
		m.ink.unmount();
	});

	it("waits for the player rather than scrolling past", async () => {
		const m = mount({ findings: FINDINGS });
		await m.ink.settle();
		expect(m.dismissed).toHaveLength(0);
		await m.ink.type(KEY.space);
		expect(m.dismissed).toHaveLength(1);
		// And ESC here means "go on", not "stop": there is nothing left to stop.
		expect(m.stopped).toHaveLength(0);
		m.ink.unmount();
	});

	it("counts what it could not fit rather than dropping it silently", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			severity: "warning",
			message: `finding number ${i}`,
		}));
		const m = mount({ findings: many });
		expect(m.screen()).toMatch(/and \d+ more/);
		m.ink.unmount();
	});

	it("stays inside its frame however many there are", () => {
		const many = Array.from({ length: 40 }, (_, i) => ({
			severity: "error",
			message: `finding number ${i}`,
		}));
		const m = mount({ findings: many });
		expect(
			m
				.screen()
				.split("\n")
				.filter((row) => row.length > 0),
		).toHaveLength(24);
		m.ink.unmount();
	});

	it("does not interrupt a world that came out clean", () => {
		// Nothing to read means nothing to dismiss: the player asked for a world, not for a
		// keypress confirming that it worked.
		const m = mount({ findings: [] });
		expect(m.screen()).not.toContain("press any key");
		m.ink.unmount();
	});
});
