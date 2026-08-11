import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderInk } from "../../../test/harness/ink.js";
import { resetTelemetry } from "../../ai/telemetry.js";
import { clearTranscript, recordExchange } from "../../ai/transcript.js";
import { clearLogRing, logger } from "../../utils/log.js";
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

/** The same screen with the mend on offer, which is a second thing a key can mean. */
function mountOffering(props: Partial<Parameters<typeof GenerateProgress>[0]> = {}) {
	const polished: number[] = [];
	const m = mount({ onPolish: () => polished.push(1), ...props });
	return { ...m, polished };
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

/**
 * The offer to read the world back and write the faults out.
 *
 * A second decision, taken with the findings in front of the player: everything before this
 * point is part of the price of writing a world at all, and this one costs a call for the
 * reading and a call per scene it mends. So it is offered, and only ever when it can be
 * taken — a key on the screen that does nothing reads as the game having stopped responding
 * at the exact moment somebody is deciding whether to trust it.
 */
describe("offering to mend it", () => {
	const FAULTS = [{ severity: "warning", message: "nobody tells you where Aldermoor is" }];

	it("makes the offer only when there is something to make it with", () => {
		const plain = mount({ findings: FAULTS });
		expect(plain.screen()).not.toContain("read back");
		plain.ink.unmount();

		const offering = mountOffering({ findings: FAULTS });
		expect(offering.screen()).toContain("read back");
		offering.ink.unmount();
	});

	it("takes P as the offer rather than as 'I have read this'", async () => {
		const m = mountOffering({ findings: FAULTS });
		await m.ink.settle();
		await m.ink.type("p");
		expect(m.polished).toHaveLength(1);
		expect(m.dismissed).toHaveLength(0);
		m.ink.unmount();
	});

	it("still starts the game on anything else", async () => {
		const m = mountOffering({ findings: FAULTS });
		await m.ink.settle();
		await m.ink.type(KEY.space);
		expect(m.dismissed).toHaveLength(1);
		expect(m.polished).toHaveLength(0);
		m.ink.unmount();
	});

	/*
	 * The one case that used to say nothing at all: a world read back and mended until there
	 * was nothing left wrong with it went straight into play, so the player paid for the pass
	 * and was never told it had worked.
	 */
	it("shows the review even when nothing is left wrong, if asked to", () => {
		const m = mount({ findings: [], done: true, verdict: "A player could follow this through." });
		const text = m.screen();
		expect(text).toContain("Nothing is wrong with it");
		expect(text).toContain("could follow this through");
		m.ink.unmount();
	});

	it("puts the reader's verdict on the screen, not in the log", () => {
		const m = mount({ findings: FAULTS, verdict: "The second scene never names the town." });
		expect(m.screen()).toContain("never names the town");
		m.ink.unmount();
	});
});

/**
 * The working, for the run where the last world came out wrong.
 *
 * The point of keeping it in the program rather than only in the log: by the time
 * somebody wants to know why the towns came out empty they are four minutes into a
 * full-screen wait, and "open another shell and tail a file" is not an answer.
 */
describe("reading the working", () => {
	afterEach(() => {
		clearTranscript();
		clearLogRing();
		resetTelemetry();
	});

	function recorded() {
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
	}

	it("offers the working on every run, not only one that asked for it", () => {
		// It used to be offered only when a toggle on the config page had been set, which
		// meant the run that most wanted it — the one that came out wrong — was reliably
		// the run that had not thought to ask.
		const m = mount();
		expect(m.screen()).toContain("ESC to stop");
		expect(m.screen()).toContain("D for the working");
		m.ink.unmount();
	});

	it("shows the log beside the exchanges, on a key of its own", async () => {
		// The other half of the answer to "why did this world come out like that". The
		// exchanges say what was asked and what came back; the log says what the pipeline
		// then did with it — dropped a late spec, escalated, replayed a remembered reply.
		recorded();
		logger.debug("dropping late spec for committed site 42");

		const m = mount();
		await m.ink.settle();
		await m.ink.type("d");
		expect(m.screen()).toContain("L log");
		await m.ink.type("l");
		expect(m.screen()).toContain("committed site 42");
		m.ink.unmount();
	});

	it("shows the prompt that was actually sent", async () => {
		recorded();
		const m = mount();
		await m.ink.settle();
		await m.ink.type("d");
		const text = m.screen();
		expect(text).toContain("SLUICEFORD");
		expect(text).toContain("You name places.");
		m.ink.unmount();
	});

	it("switches to what came back, and comes out again on ESC", async () => {
		recorded();
		const m = mount();
		await m.ink.settle();
		await m.ink.type("d");
		await m.ink.type(KEY.right);
		expect(m.screen()).toContain("Millford");

		// ESC here means "put this down", not "throw the world away". A reader who
		// opened the transcript has not asked to stop the run.
		await m.ink.type(KEY.escape);
		expect(m.stopped).toHaveLength(0);
		expect(m.screen()).toContain("lore: The Long Siege");
		m.ink.unmount();
	});

	it("does not read D as 'I have finished reading the faults'", async () => {
		// The screen most worth opening the working from is the one reporting what came
		// out wrong, and that screen otherwise starts the game on any key at all.
		recorded();
		const m = mount({
			findings: [{ severity: "warning", message: "nobody lives in Millford" }],
		});
		await m.ink.settle();
		await m.ink.type("d");
		expect(m.dismissed).toHaveLength(0);
		expect(m.screen()).toContain("SLUICEFORD");
		m.ink.unmount();
	});
});
