import { logger } from "../utils/log.js";
import { CATALOGUE, type ModelPrice } from "./catalogue.js";

export type CallKind = "bible" | "region" | "site" | "dialogue" | "summary";

interface Bucket {
	calls: number;
	failures: number;
	inputTokens: number;
	outputTokens: number;
	millis: number;
	/** Dollars, accumulated per call at that call's own model's price. */
	cost: number;
}

/**
 * Per-session accounting for model calls.
 *
 * A game that quietly makes an LLM call every time the player walks east is a
 * game with an unbounded bill, so the cost is measured rather than assumed.
 * Prices are per million tokens and only need to be roughly right — the point
 * is to notice an order-of-magnitude regression, not to reconcile an invoice.
 *
 * The prices come from `catalogue.ts` rather than being kept here, and that is the
 * whole of what changed: this file used to carry two hard-coded rows, so a world
 * written on any of the other twelve models in the catalogue was costed at exactly
 * zero. Silently — the number was reported, it was simply always $0.00, which is the
 * worst way for a cost display to be wrong. One table, so adding a model to the
 * launcher adds it to the bill.
 */
const PRICES: ReadonlyMap<string, ModelPrice> = (() => {
	const prices = new Map<string, ModelPrice>();
	for (const choice of CATALOGUE) {
		prices.set(choice.fast.model, choice.fast.price);
		prices.set(choice.prose.model, choice.prose.price);
		// The escalation target too. It is the dearest model in the row by construction,
		// so leaving it out understates a run by exactly the difference somebody chose
		// the cheap model to avoid — the one number the display exists to be right about.
		if (choice.strong) prices.set(choice.strong.model, choice.strong.price);
	}
	return prices;
})();

const buckets = new Map<CallKind, Bucket>();

/**
 * Told whenever the numbers move, so a screen watching them can redraw.
 *
 * A listener rather than polling: the generation screen already re-renders on every
 * progress line, and progress lines arrive per *pass* while calls arrive per *call* —
 * so between "populated 11 places" and "plotted 3 beats" the cost would sit frozen for
 * a minute at a time, which is the same stalled-looking screen the elapsed clock exists
 * to avoid.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onTelemetry(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function announce(): void {
	for (const listener of listeners) listener();
}

function bucketFor(kind: CallKind): Bucket {
	let bucket = buckets.get(kind);
	if (!bucket) {
		bucket = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, millis: 0, cost: 0 };
		buckets.set(kind, bucket);
	}
	return bucket;
}

export function recordCall(
	kind: CallKind,
	model: string,
	usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
	millis: number,
): void {
	const bucket = bucketFor(kind);
	const input = usage?.inputTokens ?? 0;
	const output = usage?.outputTokens ?? 0;
	bucket.calls++;
	bucket.inputTokens += input;
	bucket.outputTokens += output;
	bucket.millis += millis;
	// Priced per call rather than per bucket at the end, because a bucket can hold calls
	// made on two different models: `MODELS` is read through a getter, so changing the
	// model set mid-session is supported and would otherwise cost the whole bucket at
	// whichever price happened to be current when somebody asked for the total.
	bucket.cost += estimatedCost(model, input, output);
	logger.debug(
		`ai ${kind} ${model} ${Math.round(millis)}ms in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"}`,
	);
	announce();
}

export function recordFailure(kind: CallKind, model: string, error: unknown): void {
	bucketFor(kind).failures++;
	logger.warn(`ai ${kind} ${model} failed: ${error instanceof Error ? error.message : error}`);
	announce();
}

export function estimatedCost(model: string, inputTokens: number, outputTokens: number): number {
	const price = PRICES.get(model);
	if (!price) return 0;
	return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** Whether anything is known about what this model costs, for a display that must not lie. */
export function isPriced(model: string): boolean {
	return PRICES.has(model);
}

export interface TelemetryRow {
	readonly kind: CallKind;
	readonly calls: number;
	readonly failures: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly avgMs: number;
	readonly cost: number;
}

export interface TelemetrySnapshot {
	readonly rows: readonly TelemetryRow[];
	readonly calls: number;
	readonly failures: number;
	readonly totalTokens: number;
	/** Dollars, at catalogue prices. Understates a run that used an unpriced model. */
	readonly totalCost: number;
}

export function telemetrySnapshot(): TelemetrySnapshot {
	const rows = [...buckets.entries()].map(([kind, b]) => ({
		kind,
		calls: b.calls,
		failures: b.failures,
		inputTokens: b.inputTokens,
		outputTokens: b.outputTokens,
		avgMs: b.calls === 0 ? 0 : Math.round(b.millis / b.calls),
		cost: b.cost,
	}));
	return {
		rows,
		calls: rows.reduce((sum, r) => sum + r.calls, 0),
		failures: rows.reduce((sum, r) => sum + r.failures, 0),
		totalTokens: rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0),
		totalCost: rows.reduce((sum, r) => sum + r.cost, 0),
	};
}

/**
 * Dollars, in as many places as the number deserves.
 *
 * A world costs cents, so two decimal places would print `$0.00` for most of a run and
 * `$0.01` for the rest — a display that is technically accurate and tells the player
 * nothing about whether the thing they just chose is dear. Four places below a dollar,
 * two above, where the cents are the interesting digits again.
 */
export function money(dollars: number): string {
	if (dollars === 0) return "$0";
	if (dollars < 1) return `$${dollars.toFixed(4)}`;
	return `$${dollars.toFixed(2)}`;
}

/** `12.4k`, because raw token counts stop being readable in the hundreds of thousands. */
export function tokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(2)}M`;
}

export function logTelemetry(): void {
	const snapshot = telemetrySnapshot();
	if (snapshot.rows.length === 0) return;
	for (const row of snapshot.rows) {
		logger.info(
			`ai total ${row.kind}: ${row.calls} calls (${row.failures} failed), ` +
				`${row.inputTokens}+${row.outputTokens} tokens, ${row.avgMs}ms avg, ${money(row.cost)}`,
		);
	}
	logger.info(
		`ai total this session: ${snapshot.totalTokens} tokens, ${money(snapshot.totalCost)}`,
	);
}

/** Reset between tests. */
export function resetTelemetry(): void {
	buckets.clear();
	announce();
}
