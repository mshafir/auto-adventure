import { generateObject, NoObjectGeneratedError } from "ai";
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

export async function structured<T>(request: StructuredRequest<T>): Promise<T | undefined> {
	if (!aiAvailable()) return undefined;

	const retries = request.retries ?? DEFAULT_RETRIES;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const started = Date.now();
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
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
			// the former just burns tokens to get the same answer back.
			const permanent = NoObjectGeneratedError.isInstance(error);
			if (permanent || attempt === retries) {
				recordFailure(request.kind, request.model, error);
				return undefined;
			}
			logger.debug(`ai ${request.kind} attempt ${attempt + 1} failed, retrying`);
			await backoff(attempt);
		} finally {
			clearTimeout(timer);
		}
	}
	return undefined;
}
