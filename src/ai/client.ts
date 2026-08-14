import { generateObject, streamObject } from "ai";
import type { z } from "zod";
import { hasGatewayKey } from "../config.js";
import { logger } from "../utils/log.js";
import { type CallKind, recordCall, recordFailure } from "./telemetry.js";

/**
 * The only place the game talks to a model.
 *
 * Two rules hold everywhere above this file: a model call never throws into
 * gameplay, and a model call never blocks a frame. `structured` returns
 * `undefined` on any failure — timeout, malformed JSON, missing key, schema
 * mismatch — and every caller has a deterministic fallback ready, so the worst
 * case of a total network outage is a world with procedurally-generated names
 * instead of authored ones.
 *
 * Models are plain provider-prefixed strings (`google/gemini-2.5-flash`), which
 * the AI SDK routes through the Vercel AI Gateway using `AI_GATEWAY_API_KEY`.
 * Changing provider is therefore an environment variable, not a code change.
 */

export interface StructuredRequest<T> {
	readonly kind: CallKind;
	readonly model: string;
	readonly schema: z.ZodType<T>;
	readonly system: string;
	readonly prompt: string;
	readonly timeoutMs?: number;
	readonly retries?: number;
	/**
	 * A dearer model to spend the last attempt on, when the catalogue offers one.
	 *
	 * Only the final attempt, and only once the ordinary model has already failed — so
	 * this costs nothing on the calls that work, which is most of them. It exists because
	 * a model that answers a schema two times in three is not a model that fails: it is a
	 * model that loses a third of the world, silently, to the deterministic fallback.
	 */
	readonly escalateTo?: string;
	readonly temperature?: number;
	/**
	 * The caller giving up, as distinct from this call timing out.
	 *
	 * Combined with the per-attempt timeout rather than replacing it, so both still hold.
	 * Aborting through this stops the retry loop as well: a timeout is worth another
	 * attempt and a player who pressed ESC is not.
	 */
	readonly signal?: AbortSignal;
}

/**
 * One controller that fires when either the timeout or the caller does.
 *
 * `AbortSignal.any` would do this in one line and is Node 20; the floor here is 18, and a
 * launcher that crashes on an older runtime is a worse trade than six lines.
 */
function abortWith(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const relay = () => controller.abort();
	signal?.addEventListener("abort", relay, { once: true });
	if (signal?.aborted) controller.abort();
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", relay);
		},
	};
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;

/**
 * File the whole exchange in the log.
 *
 * Here rather than at the call sites because this is the only place that has all of it —
 * the system prompt, the prompt, the answer and how long it took are together for exactly
 * the width of this function and nowhere else.
 *
 * It used to go to an in-memory buffer with a page in the menu to read it. Nobody read the
 * page, so both are gone and this is what is left: `logger.debug` is off unless asked for,
 * the file survives a run that ended badly, and there is one copy rather than two that can
 * disagree.
 *
 * `attempt` is one-based on the way out, because "attempt 0" is a thing only the loop
 * counter believes.
 *
 * `model` is passed rather than read off the request, because the last attempt may have
 * gone to a dearer one — and a record that labelled an escalated call with the model that
 * had already failed would be lying about the one line a reader is looking for.
 */
function keep<T>(
	request: StructuredRequest<T>,
	attempt: number,
	millis: number,
	outcome: {
		readonly usage?: { inputTokens?: number | undefined; outputTokens?: number | undefined };
		readonly object?: unknown;
		readonly error?: unknown;
	},
	model: string,
): void {
	logger.debug(
		`ai ${request.kind} ${model} attempt ${attempt + 1} in ${Math.round(millis)}ms` +
			`${outcome.usage ? ` (${outcome.usage.inputTokens ?? 0}/${outcome.usage.outputTokens ?? 0} tokens)` : ""}`,
		{
			system: request.system,
			prompt: request.prompt,
			...(outcome.object === undefined ? {} : { object: outcome.object }),
			...(outcome.error === undefined ? {} : { error: String(outcome.error) }),
		},
	);
}

export function aiAvailable(): boolean {
	return hasGatewayKey();
}

function backoff(attempt: number): Promise<void> {
	// 400ms, 1200ms. Long enough to ride out a rate limit, short enough that the
	// prefetch ring has usually resolved before the player walks into it.
	const delay = 400 * 3 ** attempt;
	return new Promise((resolve) => setTimeout(resolve, delay));
}

export interface StreamedRequest<T> extends StructuredRequest<T> {
	/**
	 * Called as the object fills in, zero or more times before the result returns.
	 *
	 * Typed `Partial<T>` rather than the SDK's own `DeepPartial`, which is not exported.
	 * The difference matters for nested arrays — a half-streamed `string[]` really can
	 * hold `undefined` where `Partial<T>` promises a string — so read scalar fields from
	 * this and wait for the resolved object for anything else. The one caller reads
	 * `speech`, which is a string at the top level and safe.
	 *
	 * Must not throw: it runs inside the stream loop, and a listener that threw would
	 * turn a cosmetic preview into a failed call.
	 */
	readonly onPartial: (partial: Partial<T>) => void;
}

/**
 * The same call, reporting the answer as it arrives.
 *
 * Same contract as {@link structured} in every way that matters — never throws, returns
 * `undefined` on any failure, retries the same way — so a caller can swap one for the
 * other and only gain the preview. `onPartial` is *advisory*: the value it hands over is
 * incomplete by construction and may be abandoned entirely if the attempt fails and a
 * retry starts over, which is why the resolved object is still the only thing acted on.
 *
 * Kept separate from `structured` rather than folded in behind an optional callback,
 * because streaming and not-streaming fail differently: `streamObject` surfaces a schema
 * mismatch when the stream ends rather than when the call returns, and conflating the two
 * would put that difference in the path of every authoring call, none of which want it.
 */
export async function streamed<T>(request: StreamedRequest<T>): Promise<T | undefined> {
	if (!aiAvailable()) return undefined;

	const retries = request.retries ?? DEFAULT_RETRIES;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const started = Date.now();
		// The last attempt goes to the dearer model where there is one to go to.
		const model = attempt === retries && request.escalateTo ? request.escalateTo : request.model;
		const abort = abortWith(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const result = streamObject({
				model,
				schema: request.schema,
				system: request.system,
				prompt: request.prompt,
				abortSignal: abort.signal,
				...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			});
			for await (const partial of result.partialObjectStream) {
				request.onPartial(partial as Partial<T>);
			}
			// After the stream, not during: this is where a schema mismatch surfaces, and
			// awaiting it is what makes the failure look like `structured`'s.
			const object = (await result.object) as T;
			const usage = await result.usage;
			recordCall(request.kind, model, usage, Date.now() - started);
			keep(request, attempt, Date.now() - started, { usage, object }, model);
			return object;
		} catch (error) {
			// Kept on every attempt, not only the last. A run that answers on the third try
			// is telling you something about the first two, and that is exactly what somebody
			// reading a transcript is trying to find out.
			keep(request, attempt, Date.now() - started, { error }, model);
			if (attempt === retries || request.signal?.aborted) {
				recordFailure(request.kind, model, error);
				return undefined;
			}
			logger.debug(`ai ${request.kind} attempt ${attempt + 1} failed streaming, retrying`);
			await backoff(attempt);
		} finally {
			abort.done();
		}
	}
	return undefined;
}

export async function structured<T>(request: StructuredRequest<T>): Promise<T | undefined> {
	if (!aiAvailable()) return undefined;

	const retries = request.retries ?? DEFAULT_RETRIES;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const started = Date.now();
		// The last attempt goes to the dearer model where there is one to go to.
		const model = attempt === retries && request.escalateTo ? request.escalateTo : request.model;
		const abort = abortWith(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const result = await generateObject({
				model,
				schema: request.schema,
				system: request.system,
				prompt: request.prompt,
				abortSignal: abort.signal,
				...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			});
			recordCall(request.kind, model, result.usage, Date.now() - started);
			keep(
				request,
				attempt,
				Date.now() - started,
				{ usage: result.usage, object: result.object },
				model,
			);
			return result.object as T;
		} catch (error) {
			keep(request, attempt, Date.now() - started, { error }, model);
			/*
			 * A schema mismatch used to be treated as permanent — "it will repeat, so
			 * retrying only burns tokens to be told the same thing" — and that turned out
			 * to be measurably false. On a real run `openai/gpt-5-mini` answered the
			 * dialogue schema 8 times out of 26 on the same shape of prompt: not a model
			 * that cannot do it, a model that does it two times in three. Every one of the
			 * other 18 conversations was thrown away on the first roll, and the symptom
			 * was a world where most of the cast had nothing written for them.
			 *
			 * So every failure is retried now, and the last attempt is spent on a dearer
			 * model where the catalogue names one. Both costs are bounded, and both are
			 * paid only on a call that has already failed.
			 */
			if (attempt === retries || request.signal?.aborted) {
				recordFailure(request.kind, model, error);
				return undefined;
			}
			logger.debug(`ai ${request.kind} attempt ${attempt + 1} failed, retrying`);
			await backoff(attempt);
		} finally {
			abort.done();
		}
	}
	return undefined;
}
