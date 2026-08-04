import { logger } from "../utils/log.js";

export type CallKind = "bible" | "region" | "site" | "dialogue" | "summary";

interface Bucket {
	calls: number;
	failures: number;
	inputTokens: number;
	outputTokens: number;
	millis: number;
}

/**
 * Per-session accounting for model calls.
 *
 * A game that quietly makes an LLM call every time the player walks east is a
 * game with an unbounded bill, so the cost is measured rather than assumed.
 * Prices are per million tokens and only need to be roughly right — the point
 * is to notice an order-of-magnitude regression, not to reconcile an invoice.
 */
const PRICES: Readonly<Record<string, readonly [number, number]>> = {
	"google/gemini-2.5-flash": [0.3, 2.5],
	"google/gemini-2.5-flash-lite": [0.1, 0.4],
};

const buckets = new Map<CallKind, Bucket>();

function bucketFor(kind: CallKind): Bucket {
	let bucket = buckets.get(kind);
	if (!bucket) {
		bucket = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, millis: 0 };
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
	bucket.calls++;
	bucket.inputTokens += usage?.inputTokens ?? 0;
	bucket.outputTokens += usage?.outputTokens ?? 0;
	bucket.millis += millis;
	logger.debug(
		`ai ${kind} ${model} ${Math.round(millis)}ms in=${usage?.inputTokens ?? "?"} out=${usage?.outputTokens ?? "?"}`,
	);
}

export function recordFailure(kind: CallKind, model: string, error: unknown): void {
	bucketFor(kind).failures++;
	logger.warn(`ai ${kind} ${model} failed: ${error instanceof Error ? error.message : error}`);
}

export function estimatedCost(model: string, inputTokens: number, outputTokens: number): number {
	const price = PRICES[model];
	if (!price) return 0;
	return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}

export function telemetrySnapshot(): {
	readonly rows: readonly {
		kind: CallKind;
		calls: number;
		failures: number;
		inputTokens: number;
		outputTokens: number;
		avgMs: number;
	}[];
	readonly totalTokens: number;
} {
	const rows = [...buckets.entries()].map(([kind, b]) => ({
		kind,
		calls: b.calls,
		failures: b.failures,
		inputTokens: b.inputTokens,
		outputTokens: b.outputTokens,
		avgMs: b.calls === 0 ? 0 : Math.round(b.millis / b.calls),
	}));
	const totalTokens = rows.reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);
	return { rows, totalTokens };
}

export function logTelemetry(): void {
	const { rows, totalTokens } = telemetrySnapshot();
	if (rows.length === 0) return;
	for (const row of rows) {
		logger.info(
			`ai total ${row.kind}: ${row.calls} calls (${row.failures} failed), ` +
				`${row.inputTokens}+${row.outputTokens} tokens, ${row.avgMs}ms avg`,
		);
	}
	logger.info(`ai total tokens this session: ${totalTokens}`);
}

/** Reset between tests. */
export function resetTelemetry(): void {
	buckets.clear();
}
