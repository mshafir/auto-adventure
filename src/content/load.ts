import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PACK } from "../core/content/default.js";
import { type ContentPack, mergePack, type PackOverride } from "../core/content/pack.js";
import { PackOverrideSchema } from "../core/content/schema.js";
import { logger } from "../utils/log.js";

/**
 * Reading packs off disk.
 *
 * Kept out of `core` because it touches the filesystem, and `core` has to stay
 * callable from a validator, a test and a headless tool with no assets directory at
 * all. That is also why the baked default is code: the pure generators always have a
 * complete set of tables, and a missing or broken file degrades to the default rather
 * than to a world of people called "undefined undefined".
 */

/**
 * Where the shipped packs live.
 *
 * Resolved by walking up from this module rather than from `process.cwd()`, because
 * the game is run from the repo root, from `dist`, and from a test's temporary
 * directory. `src/content/` and `dist/content/` are both two levels under the repo
 * root, so the same relative path answers for a source run and a compiled one.
 */
export function packRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "assets", "content");
}

export function packPath(name: string): string {
	return join(packRoot(), `${name}.json`);
}

/** Pack names available on disk, for a launcher or an error message. */
export function listPacks(): string[] {
	const root = packRoot();
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.sort();
}

/**
 * Read one override file.
 *
 * Returns undefined for every way a file can be wrong — missing, unparseable, or a
 * shape that would break a generator — because a bad pack must not stop a game from
 * starting. It says so in the log rather than throwing: the player asked to play, not
 * to debug their JSON, and the authoring tool is where a bad pack deserves a hard
 * error.
 */
export function readOverride(path: string): PackOverride | undefined {
	if (!existsSync(path)) {
		logger.warn(`content pack ${path} does not exist; using the default`);
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		logger.warn(`content pack ${path} is not valid JSON`, error);
		return undefined;
	}
	const parsed = PackOverrideSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		logger.warn(
			`content pack ${path} is not usable: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? "?"}`,
		);
		return undefined;
	}
	return parsed.data as PackOverride;
}

/**
 * Resolve what the player asked for: a shipped name, or a path to a file.
 *
 * A name is tried first so `CONTENT_PACK=thornwick` works from any directory, and a
 * value containing a separator or ending in `.json` is treated as a path so a pack
 * can live beside a draft rather than in this repo.
 */
export function resolveOverride(spec: string | undefined): PackOverride | undefined {
	const wanted = spec?.trim();
	if (!wanted) return undefined;

	const looksLikePath = wanted.endsWith(".json") || wanted.includes("/") || wanted.includes("\\");
	if (!looksLikePath) {
		const named = packPath(wanted);
		if (existsSync(named)) return readOverride(named);
		logger.warn(`no content pack named "${wanted}"; known: ${listPacks().join(", ") || "none"}`);
		return undefined;
	}
	return readOverride(resolve(wanted));
}

/** The pack a spec names, laid over the baked default. */
export function loadPack(spec: string | undefined): ContentPack {
	return mergePack(DEFAULT_PACK, resolveOverride(spec));
}
