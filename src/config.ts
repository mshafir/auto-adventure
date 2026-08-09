import dotenvFlow from "dotenv-flow";
import { type ModelChoice, modelChoice } from "./ai/catalogue.js";
import { hashString } from "./core/rand/hash.js";
import { isDuration, normalizeBrief, type ScenarioBrief } from "./core/world/brief.js";
import { readSettings } from "./persist/settings.js";

dotenvFlow.config({ silent: true });

// Nothing above may import `./utils/log.js`, directly or transitively. That
// module reads LOG_LEVEL and LOG_FILE at evaluation time, and imports are
// evaluated before this file's body — so importing it here would read those
// variables before `dotenvFlow.config()` had a chance to define them.
//
// `./persist/settings.js` carries the same rule and says so, which is why the
// stored key and model can be read from here at all.

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

/**
 * The brief, as environment variables.
 *
 * `SCENARIO_PROMPT` is the one most people want: freeform text describing the
 * world and the story wanted from it. The rest refine it.
 *
 * An unrecognised `SCENARIO_DURATION` is dropped rather than rejected. Duration
 * only does anything when a scenario is generated ahead of time — a live world is
 * unbounded and has no arc to shorten — so the authoring tool is where a bad
 * value deserves a real error, not here, where it would abort a playable game.
 */
export function briefFromEnv(env: NodeJS.ProcessEnv = process.env): ScenarioBrief | undefined {
	const duration = env.SCENARIO_DURATION?.trim();
	return normalizeBrief({
		premise: env.SCENARIO_PROMPT,
		setting: env.SCENARIO_SETTING,
		storyline: env.SCENARIO_STORYLINE,
		tone: env.SCENARIO_TONE,
		protagonist: env.SCENARIO_PROTAGONIST,
		avoid: env.SCENARIO_AVOID,
		...(duration && isDuration(duration) ? { duration } : {}),
	});
}

export const CONFIG = {
	worldName: process.env.WORLD_NAME ?? "default",
	seed: resolveSeed(process.env.WORLD_SEED),
	/**
	 * Whether the seed and the slot were actually asked for.
	 *
	 * Both have defaults, so their values alone cannot say whether anyone chose
	 * them. The launcher needs to know: a named slot means "open that world" and
	 * skips the menu entirely, which is what keeps scripted and headless runs
	 * working, and a named seed must survive into a new world rather than being
	 * replaced by one derived from the slot.
	 */
	worldNameExplicit: Boolean(process.env.WORLD_NAME),
	seedExplicit: Boolean(process.env.WORLD_SEED),
	/** What this world was asked to be about. Undefined is the default premise. */
	brief: briefFromEnv(),
	/** Play with no LLM at all. The world is fully generated and traversable. */
	noAi: envFlag("NO_AI"),
	/**
	 * A shipped pack name (`thornwick`) or a path to one (`./my-pack.json`).
	 *
	 * Only steers a *new* world: a save carries the pack it was made with, because
	 * names are derived and adopting a different one would rename everybody already
	 * met while keeping their memories.
	 */
	contentPack: process.env.CONTENT_PACK,
	/** A directory under `.packs/tiles/`, or a path to one. Chooses how the map looks. */
	tilePack: process.env.TILE_PACK,
	saveDebounceMs: envNumber("SAVE_DEBOUNCE_MS", 2000),
	prefetchRadius: envNumber("PREFETCH_RADIUS", 2),
} as const;

/**
 * Which pair of models the player picked, or the default.
 *
 * Read through a function rather than captured once, because the options page
 * and the config page can both change it inside a single run — and re-reading a
 * small JSON file between model calls is not a cost worth caching against.
 * `MODEL_SET` exists so a scripted run can pin one without a settings file.
 */
export function activeModels(): ModelChoice {
	return modelChoice(process.env.MODEL_SET?.trim() || readSettings().modelSet);
}

/**
 * Model selection, per call type, all overridable.
 *
 * These are plain provider-prefixed strings routed through the Vercel AI
 * Gateway (`AI_GATEWAY_API_KEY`), so switching a call type to a different
 * provider is an environment variable rather than a code change. The cheap half
 * of the chosen pair handles the high-volume structured work where latency is
 * visible and the output is never read directly; the dear half handles prose the
 * player actually sees.
 *
 * Getters rather than values, and that is the whole point: this used to be a
 * frozen object read at import time, which meant the only way to change a model
 * was to restart the process. A launcher that can offer the choice has to be able
 * to answer differently on the next call, and every one of the eighteen
 * `MODELS.director` call sites reads the same as it always did.
 *
 * A per-slot environment variable still wins over everything, so the escape hatch
 * that existed before the catalogue did still works.
 */
export const MODELS: Readonly<Record<"director" | "dialogue" | "summary" | "bible", string>> = {
	get director() {
		return process.env.MODEL_DIRECTOR ?? activeModels().fast.model;
	},
	get dialogue() {
		return process.env.MODEL_DIALOGUE ?? activeModels().prose.model;
	},
	get summary() {
		return process.env.MODEL_SUMMARY ?? activeModels().fast.model;
	},
	get bible() {
		return process.env.MODEL_BIBLE ?? activeModels().prose.model;
	},
};

/**
 * The gateway key, from the environment or from the player's settings.
 *
 * The environment wins, so a CI run or a `AI_GATEWAY_API_KEY=… npm start` is
 * never quietly overridden by whatever happens to be saved on that machine.
 */
export function gatewayKey(): string | undefined {
	return process.env.AI_GATEWAY_API_KEY?.trim() || readSettings().gatewayKey;
}

export function hasGatewayKey(): boolean {
	return Boolean(gatewayKey());
}

/**
 * Put the stored key where the AI SDK will find it.
 *
 * The gateway provider reads `AI_GATEWAY_API_KEY` out of `process.env` itself,
 * deep inside the SDK, and there is no seam to hand it a key directly. So a key
 * that arrived from the settings file has to be put back into the environment
 * before the first model call — which is what this does, and why the options page
 * calls it again after saving rather than asking the player to restart.
 *
 * Only ever fills a hole. A real environment variable is left exactly as it was.
 */
export function installGatewayKey(): void {
	if (process.env.AI_GATEWAY_API_KEY?.trim()) return;
	const stored = readSettings().gatewayKey;
	if (stored) process.env.AI_GATEWAY_API_KEY = stored;
}
