import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenarioRoot } from "../paths.js";
import { type LogLine, logger, logRing, onLog } from "../utils/log.js";
import { type Exchange, onTranscript, seedTranscript, transcript } from "./transcript.js";

/**
 * The record of a run, on disk, outliving the process that made it.
 *
 * Both in-memory buffers die when the program does, which makes them no use for the
 * question somebody actually has — "the world I wrote last night came out wrong, why?" —
 * and no use at all for the in-game view of a world this process did not write itself. So
 * both streams land in one file beside the artifact.
 *
 * Appended as entries arrive rather than written at the end, because a run that died
 * mid-pass is the run most worth reading and is exactly the run that never reaches an end.
 * Written for *every* run, including one whose artifact is thrown away: this is diagnostics
 * rather than content, and the record of a failed attempt is the record worth having.
 *
 * Kept in a subdirectory, and not named `.json`, because `listScenarios` reads root-level
 * `*.json` — a diagnostic must never turn up on the launcher's shelf as a world to play.
 *
 * The dependency runs one way. This module reads `transcript.ts` and `log.ts`; neither
 * knows it exists. A sink those two had to be told about would be a third thing to keep in
 * step with them.
 */

export type WorkingRecord =
	| { readonly kind: "exchange"; readonly exchange: Exchange }
	| { readonly kind: "log"; readonly line: LogLine };

/** Where the working files live. Hidden, so it reads as bookkeeping rather than content. */
export function workingDir(): string {
	return join(scenarioRoot(), ".working");
}

export function workingPath(id: string): string {
	return join(workingDir(), `${id}.jsonl`);
}

/**
 * An open record, and how much of each stream has already reached it.
 *
 * Both streams announce into the same drain, so an exchange landing and a log line landing
 * each ask for everything new. Counting what has gone out is what keeps that from writing
 * the whole buffer again on every line.
 */
interface Sink {
	readonly path: string;
	exchanges: number;
	log: number;
	readonly off: readonly (() => void)[];
	/** Set once a write has failed, so a broken file costs one attempt rather than a run. */
	broken: boolean;
}

let sink: Sink | undefined;

/**
 * Open the record for a run, replacing whatever the last one left.
 *
 * Truncated rather than appended to: two runs of the same world in one file would read as
 * one run that asked everything twice.
 */
export function beginWorking(id: string): void {
	endWorking();
	const path = workingPath(id);
	try {
		mkdirSync(workingDir(), { recursive: true });
		writeFileSync(path, "");
	} catch {
		// No file, no record, and no complaint. A diagnostic that cannot be written must
		// not stop a world from being written, and the only place left to report it is the
		// log — which is the very thing that would re-enter this.
		return;
	}
	sink = { path, exchanges: 0, log: 0, off: [onTranscript(drain), onLog(drain)], broken: false };
	drain();
}

/**
 * Close the record.
 *
 * Safe to call when none is open, which is what makes it usable in a `finally` without the
 * caller having to track whether the run ever got as far as starting one.
 */
export function endWorking(): void {
	if (!sink) return;
	for (const off of sink.off) off();
	sink = undefined;
}

/**
 * Append everything that has landed since the last drain.
 *
 * Re-entrant by construction, and deliberately so: the failure below is reported through
 * the logger, `onLog` fires from inside `emit`, and so reporting it calls this function
 * again from inside its own catch block. `broken` is set *before* that happens, which is
 * what turns the second call into an immediate return rather than the same failure for
 * ever. The order of those two lines is the whole guard — do not swap them.
 */
function drain(): void {
	if (!sink || sink.broken) return;
	try {
		const exchanges = transcript();
		const log = logRing();
		const lines: string[] = [];
		for (let i = sink.exchanges; i < exchanges.length; i++) {
			lines.push(JSON.stringify({ kind: "exchange", exchange: exchanges[i] }));
		}
		for (let i = sink.log; i < log.length; i++) {
			lines.push(JSON.stringify({ kind: "log", line: log[i] }));
		}
		if (lines.length > 0) appendFileSync(sink.path, `${lines.join("\n")}\n`);
		sink.exchanges = exchanges.length;
		sink.log = log.length;
	} catch (error) {
		// Given up on rather than retried: a file that cannot be appended to now will not
		// start working later in the same run, and a diagnostic must never be the reason
		// four minutes of authoring is lost.
		//
		// Said once, though. A record that stopped recording without saying so is worse
		// than one that was never opened, because the gap in it reads as a gap in the run.
		const path = sink.path;
		sink.broken = true;
		logger.warn(`the working record at ${path} could not be written; it stops here`, error);
	}
}

/**
 * Every record of a run, or nothing where there is no file.
 *
 * A malformed line is skipped rather than fatal. The file is appended to live, so a run
 * killed mid-write can leave a partial last line — which is no reason to refuse the
 * hundred good ones above it.
 */
export function readWorking(id: string): WorkingRecord[] | undefined {
	const path = workingPath(id);
	if (!existsSync(path)) return undefined;
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const records: WorkingRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line) as WorkingRecord);
		} catch {
			// Skipped, not fatal. See the note above the function.
		}
	}
	return records;
}

/**
 * Put a world's recorded exchanges into the live transcript.
 *
 * What makes the in-game working page useful for a scenario somebody else generated, or
 * one generated last week. Reports whether anything was read, so a caller can tell "no
 * record" from "an empty record".
 *
 * Refuses outright when the transcript already holds something, which is the case that
 * matters rather than a defensive flourish: a world written a moment ago on the previous
 * screen has every one of these exchanges in memory already, and reading the file back over
 * the top of them would show the player each one twice. The invariant belongs here rather
 * than with the caller, because a second caller would have to rediscover it.
 *
 * Only the exchanges. The log lines are in the file for whoever reads it, but seeding them
 * into this session's ring would mix last week's authoring with this session's play in one
 * list with no way to tell which was which.
 */
export function loadWorkingInto(id: string): boolean {
	if (transcript().length > 0) return false;
	const records = readWorking(id);
	if (!records) return false;
	const exchanges = records
		.filter((record): record is Extract<WorkingRecord, { kind: "exchange" }> => {
			return record.kind === "exchange";
		})
		.map((record) => record.exchange);
	if (exchanges.length === 0) return false;
	seedTranscript(exchanges);
	return true;
}
