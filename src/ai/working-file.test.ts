import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearLogRing, logger, logRing } from "../utils/log.js";
import { clearTranscript, recordExchange, transcript } from "./transcript.js";
import {
	beginWorking,
	endWorking,
	loadWorkingInto,
	readWorking,
	type WorkingRecord,
	workingDir,
	workingPath,
} from "./working-file.js";

/**
 * The record that outlives the run.
 *
 * Both in-memory buffers die with the process, which makes them no use for the question
 * somebody actually has — "the world I wrote last night came out wrong, why?" — and none
 * for the in-game view of a world this process did not write. So both streams land in one
 * file beside the artifact, appended as they arrive rather than at the end, because a run
 * that ended badly is the run most worth reading and is exactly the run that never reaches
 * an end.
 */

const CALL = {
	kind: "site" as const,
	model: "google/gemini-2.5-flash",
	system: "You name places.",
	prompt: "A village on a river.",
	millis: 812,
	attempt: 1,
};

function exchangesIn(records: readonly WorkingRecord[]): string[] {
	return records
		.filter((record): record is Extract<WorkingRecord, { kind: "exchange" }> => {
			return record.kind === "exchange";
		})
		.map((record) => record.exchange.prompt);
}

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "aa-working-"));
	process.env.AUTO_ADVENTURE_SCENARIOS = dir;
	clearTranscript();
	clearLogRing();
});

afterEach(() => {
	endWorking();
	delete process.env.AUTO_ADVENTURE_SCENARIOS;
	clearTranscript();
	clearLogRing();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the working file", () => {
	it("writes an exchange as it lands rather than at the end", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, object: { name: "Millford" } });

		// Read while the run is still notionally going: a run that dies mid-pass has to
		// leave behind what it had, which is the whole reason this appends.
		const records = readWorking("the-tide-glass") ?? [];
		expect(exchangesIn(records)).toEqual([CALL.prompt]);
	});

	it("writes the log beside it, in the same file", () => {
		beginWorking("the-tide-glass");
		logger.debug("dropping late spec for committed site 42");

		const records = readWorking("the-tide-glass") ?? [];
		expect(records.some((r) => r.kind === "log" && r.line.text.includes("site 42"))).toBe(true);
	});

	it("never writes the same entry twice, however often it is told", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL });
		// A log line fires the same drain an exchange does, so a sink that wrote the whole
		// buffer each time would duplicate every exchange before it.
		logger.info("wrote a thing");
		logger.info("wrote another");

		expect(exchangesIn(readWorking("the-tide-glass") ?? [])).toHaveLength(1);
	});

	it("starts a fresh file per run rather than appending to the last world's", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, prompt: "first run" });
		endWorking();

		clearTranscript();
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, prompt: "second run" });

		expect(exchangesIn(readWorking("the-tide-glass") ?? [])).toEqual(["second run"]);
	});

	it("stops writing once the run is over", () => {
		beginWorking("the-tide-glass");
		endWorking();
		recordExchange({ ...CALL });

		expect(exchangesIn(readWorking("the-tide-glass") ?? [])).toHaveLength(0);
	});

	it("reads a run back into the transcript, for a world this process did not write", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, object: { name: "Millford" } });
		endWorking();
		clearTranscript();

		expect(loadWorkingInto("the-tide-glass")).toBe(true);
		expect(transcript()).toHaveLength(1);
		expect(transcript()[0]?.prompt).toBe(CALL.prompt);
	});

	it("says so rather than throwing when a world has no working file", () => {
		expect(loadWorkingInto("never-written")).toBe(false);
		expect(readWorking("never-written")).toBeUndefined();
	});

	it("reads the good lines either side of one a killed run left half-written", () => {
		// The file is appended to live, so a process killed mid-write can leave a partial
		// last line. That is not a reason to refuse the hundred good ones above it.
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL, prompt: "before" });
		endWorking();
		fs.appendFileSync(workingPath("the-tide-glass"), '{"kind":"exchange","exch');

		expect(exchangesIn(readWorking("the-tide-glass") ?? [])).toEqual(["before"]);
	});

	it("keeps out of the way of the scenarios themselves", () => {
		beginWorking("the-tide-glass");
		recordExchange({ ...CALL });

		// `listScenarios` reads root-level *.json only, so the working file has to be
		// neither at the root nor named .json — or a diagnostic would turn up on the
		// launcher's shelf as a world to play.
		expect(workingDir()).not.toBe(dir);
		expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
	});

	it("gives up on a file it cannot write, once, and says so", () => {
		// A generation run must never die because a diagnostic could not be appended — and
		// a record that stopped recording in silence is worse than one never opened, since
		// the gap in it reads as a gap in the run.
		//
		// Reporting it is what makes this re-entrant: the warning goes through the logger,
		// `onLog` fires from inside `emit`, and the drain is called again from inside its
		// own catch. Without `broken` being set first that recurses until the stack ends.
		beginWorking("the-tide-glass");
		fs.rmSync(workingDir(), { recursive: true, force: true });
		fs.writeFileSync(workingDir(), "not a directory");

		expect(() => recordExchange({ ...CALL })).not.toThrow();
		expect(logRing().filter((line) => line.text.includes("could not be written"))).toHaveLength(1);
		// And it stays given up on rather than failing afresh on every later line.
		logger.info("something else happened");
		expect(logRing().filter((line) => line.text.includes("could not be written"))).toHaveLength(1);
	});
});
