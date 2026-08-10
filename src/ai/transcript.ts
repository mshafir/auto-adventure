import { logger, setLogLevel } from "../utils/log.js";
import { type CallKind, estimatedCost } from "./telemetry.js";

/**
 * What was actually said to the model, and what came back.
 *
 * The telemetry beside this answers "how much" — calls, tokens, dollars. It cannot
 * answer the question anybody debugging a bad world actually has, which is *why this
 * came out like that*: which system prompt, with which facts in it, produced the
 * settlement with nobody in it. That answer only exists in the text of the exchange,
 * and until now the text existed nowhere at all. The log recorded a one-line summary
 * and the prompts were simply gone.
 *
 * Off by default and deliberately so. Keeping every prompt of a long run is tens of
 * megabytes of strings held live, and a game does not need them. It is turned on for a
 * generation run by somebody who is trying to find something out.
 *
 * Held in memory as well as written to the log, because a log file is not somewhere a
 * player can read from — they are inside a full-screen terminal application at the time,
 * and telling them to open another shell and tail a file is telling them no.
 */

export interface Exchange {
	/** Monotonic within a session; also the display order and the scroll key. */
	readonly seq: number;
	readonly kind: CallKind;
	readonly model: string;
	readonly system: string;
	readonly prompt: string;
	/** Milliseconds from the request going out to the answer landing or failing. */
	readonly millis: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cost: number;
	/** The answer, formatted as JSON. Absent when the call failed. */
	readonly response?: string;
	/** Why it failed, in words. Absent when it did not. */
	readonly error?: string;
	/** Which attempt this was, counting from one, so retries are visible as retries. */
	readonly attempt: number;
}

/**
 * How many exchanges to keep.
 *
 * A long world is a few hundred calls, so this holds all of one and the tail of
 * anything larger. Bounded rather than unbounded because the alternative is a debug
 * switch that eventually ends the session it was meant to explain.
 */
export const TRANSCRIPT_LIMIT = 400;

let enabled = false;
let nextSeq = 1;
const kept: Exchange[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Turn the recording on, and turn the log file's level down with it.
 *
 * One switch for both, because they are one decision. Somebody who asks for the
 * prompt-by-prompt view wants the debug lines the rest of the codebase already writes —
 * "dropping late spec for committed site", "replaying a remembered reply" — and having
 * to also know that `LOG_LEVEL` exists, and to have set it before the process started,
 * is the kind of thing that makes a debug feature go unused.
 */
export function setDebugAi(on: boolean): void {
	enabled = on;
	if (on) {
		setLogLevel("debug");
		logger.info("ai debug logging on: full prompts and answers are being kept");
	}
	announce();
}

export function debugAi(): boolean {
	return enabled;
}

export function onTranscript(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(): void {
	for (const listener of listeners) listener();
}

export interface RecordExchange {
	readonly kind: CallKind;
	readonly model: string;
	readonly system: string;
	readonly prompt: string;
	readonly millis: number;
	readonly attempt: number;
	readonly usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined };
	readonly object?: unknown;
	readonly error?: unknown;
}

export function recordExchange(input: RecordExchange): void {
	if (!enabled) return;

	const inputTokens = input.usage?.inputTokens;
	const outputTokens = input.usage?.outputTokens;
	const exchange: Exchange = {
		seq: nextSeq++,
		kind: input.kind,
		model: input.model,
		system: input.system,
		prompt: input.prompt,
		millis: Math.round(input.millis),
		attempt: input.attempt,
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(outputTokens === undefined ? {} : { outputTokens }),
		cost: estimatedCost(input.model, inputTokens ?? 0, outputTokens ?? 0),
		...(input.object === undefined ? {} : { response: format(input.object) }),
		...(input.error === undefined ? {} : { error: describe(input.error) }),
	};

	kept.push(exchange);
	// The head, not the tail: an exchange the buffer has dropped is one the reader can
	// no longer scroll back to, and the oldest is the one they are least likely to want.
	if (kept.length > TRANSCRIPT_LIMIT) kept.splice(0, kept.length - TRANSCRIPT_LIMIT);

	// The whole exchange to the log as well, on its own lines. The in-memory copy is
	// bounded and dies with the process; the file is what survives a run that ended
	// badly, which is exactly the run somebody is going to want to read.
	logger.debug(
		`ai exchange #${exchange.seq} ${exchange.kind} ${exchange.model} attempt ${exchange.attempt} ${exchange.millis}ms\n` +
			`--- system ---\n${exchange.system}\n` +
			`--- prompt ---\n${exchange.prompt}\n` +
			`--- ${exchange.error ? "error" : "answer"} ---\n${exchange.error ?? exchange.response ?? "(nothing)"}`,
	);
	announce();
}

export function transcript(): readonly Exchange[] {
	return kept;
}

/** Reset between tests, and between one generation run and the next. */
export function clearTranscript(): void {
	kept.length = 0;
	nextSeq = 1;
	announce();
}

function format(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * A failure, in as much detail as it actually carries.
 *
 * "No object generated: response did not match schema" is the most common failure in
 * the whole pipeline and, on its own, the least useful sentence in it — it says a model
 * said something wrong without saying what. The SDK's `NoObjectGeneratedError` carries
 * the raw text it could not parse, and that text is the entire answer: whether the
 * model wrote prose instead of JSON, dropped a required field, or produced something
 * perfectly good that the schema was too strict to admit.
 *
 * Read off the shape rather than by importing the error class, because this module has
 * no business depending on the AI SDK — and because a provider that reports the same
 * thing under a different name still has the text on it.
 */
function describe(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const head = `${error.name}: ${error.message}`;
	const raw = (error as { text?: unknown }).text;
	if (typeof raw !== "string" || raw.length === 0) return head;
	return `${head}\n\n--- what it actually said ---\n${raw}`;
}
