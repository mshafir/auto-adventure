import dotenvFlow from "dotenv-flow";
import { hashString } from "./core/rand/hash.js";

dotenvFlow.config({ silent: true });

function envNumber(key: string, fallback: number): number {
	const raw = process.env[key];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function envFlag(key: string): boolean {
	const raw = process.env[key];
	return raw === "1" || raw === "true";
}

/** Turn a human-friendly seed ("hollowmoor") into the numeric world seed. */
export function resolveSeed(value: string | undefined): number {
	if (!value) return hashString("auto-adventure");
	return /^-?\d+$/.test(value) ? Number(value) : hashString(value);
}

export const CONFIG = {
	worldName: process.env.WORLD_NAME ?? "default",
	seed: resolveSeed(process.env.WORLD_SEED),
	/** Play with no LLM at all. The world is fully generated and traversable. */
	noAi: envFlag("NO_AI"),
	saveDebounceMs: envNumber("SAVE_DEBOUNCE_MS", 2000),
	prefetchRadius: envNumber("PREFETCH_RADIUS", 2),
} as const;

/**
 * Model selection, per call type, all overridable.
 *
 * These are plain provider-prefixed strings routed through the Vercel AI
 * Gateway (`AI_GATEWAY_API_KEY`), so switching a call type to a different
 * provider is an environment variable rather than a code change. Flash-Lite
 * handles the high-volume structured work where latency is visible and the
 * output is never read directly; Flash handles prose the player actually sees.
 */
export const MODELS = {
	director: process.env.MODEL_DIRECTOR ?? "google/gemini-2.5-flash-lite",
	dialogue: process.env.MODEL_DIALOGUE ?? "google/gemini-2.5-flash",
	summary: process.env.MODEL_SUMMARY ?? "google/gemini-2.5-flash-lite",
	bible: process.env.MODEL_BIBLE ?? "google/gemini-2.5-flash",
} as const;

export function hasGatewayKey(): boolean {
	return Boolean(process.env.AI_GATEWAY_API_KEY);
}
