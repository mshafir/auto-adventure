import { generateObject, NoObjectGeneratedError, streamObject } from "ai";
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
		const abort = abortWith(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const result = streamObject({
				model: request.model,
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
			recordCall(request.kind, request.model, await result.usage, Date.now() - started);
			return object;
		} catch (error) {
			const permanent = NoObjectGeneratedError.isInstance(error);
			if (permanent || attempt === retries || request.signal?.aborted) {
				recordFailure(request.kind, request.model, error);
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
		const abort = abortWith(request.signal, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const result = await generateObject({
				model: request.model,
				schema: request.schema,
				system: request.system,
				prompt: request.prompt,
				abortSignal: abort.signal,
				...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			});
			recordCall(request.kind, request.model, result.usage, Date.now() - started);
			return result.object as T;
		} catch (error) {
			// A schema mismatch will repeat; a timeout or a 429 will not. Retrying
			// the former just burns tokens to get the same answer back. Nor is there
			// anything to retry for once the caller has given up.
			const permanent = NoObjectGeneratedError.isInstance(error);
			if (permanent || attempt === retries || request.signal?.aborted) {
				recordFailure(request.kind, request.model, error);
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
