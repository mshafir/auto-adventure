import type { Duration } from "../core/world/brief.js";
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
 * On always. It used to be a switch that defaulted to off, on the grounds that keeping
 * every prompt of a long run is tens of megabytes of strings held live — which is true, and
 * is what the bounded, duration-sized buffer below is for. What the switch actually bought
 * was a debug view nobody could find, on the one screen where somebody watching four
 * minutes of authoring go wrong most wants one.
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
 * How many exchanges to keep, by how large a world is being written.
 *
 * One number cannot serve both ends. Eviction takes the *head*, so a run with more calls
 * than room loses the shape, the lore and the region passes — the first three somebody
 * reading a bad world asks about. A `long` world is around 120 calls, and a model that
 * needs its retries turns each of those into three exchanges, which the old flat 400 could
 * not hold.
 */
export const TRANSCRIPT_LIMITS: Readonly<Record<Duration, number>> = {
	tiny: 200,
	short: 400,
	medium: 800,
	long: 1600,
};

/** What an unsized run holds: playing a world, or a caller that never said. */
export const DEFAULT_TRANSCRIPT_LIMIT = TRANSCRIPT_LIMITS.medium;

let limit: number = DEFAULT_TRANSCRIPT_LIMIT;
let nextSeq = 1;
const kept: Exchange[] = [];

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Set the buffer to the size of the world about to be written.
 *
 * Called once, before the first pass. `undefined` means the default — a caller with no
 * duration in hand is not a caller asking for the smallest buffer.
 */
export function sizeTranscript(duration: Duration | undefined): void {
	limit = duration ? TRANSCRIPT_LIMITS[duration] : DEFAULT_TRANSCRIPT_LIMIT;
	evict();
	announce();
}

export function transcriptLimit(): number {
	return limit;
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
	evict();

	/*
	 * No second copy to the log.
	 *
	 * The whole exchange used to go to `logger.debug` as well, because this buffer dies
	 * with the process and the file was the only thing that survived a run which ended
	 * badly. `working-file.ts` is that survivor now, and it holds the same text in a form
	 * something can read back — so writing it twice would only be a way for the two copies
	 * to disagree.
	 */
	announce();
}

/**
 * Trim to the limit in force, from the head.
 *
 * The head and not the tail: an exchange the buffer has dropped is one the reader can no
 * longer scroll back to, and the oldest is the one they are least likely to want.
 */
function evict(): void {
	if (kept.length > limit) kept.splice(0, kept.length - limit);
}

export function transcript(): readonly Exchange[] {
	return kept;
}

/**
 * Adopt a transcript read back off disk.
 *
 * For the in-game view of a world this process did not write: the exchanges are the ones
 * `working-file.ts` recorded while it was being authored. Numbering continues past what was
 * seeded, so a live call afterwards cannot collide with a seeded `#1`.
 */
export function seedTranscript(exchanges: readonly Exchange[]): void {
	if (exchanges.length === 0) return;
	kept.push(...exchanges);
	evict();
	for (const exchange of kept) nextSeq = Math.max(nextSeq, exchange.seq + 1);
	announce();
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
