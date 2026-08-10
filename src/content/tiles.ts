import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { packRoot } from "../paths.js";
import { DEFAULT_THEME, resolveTheme, type TileTheme } from "../ui/render/theme.js";
import { compilePack, TilePackSchema } from "../ui/render/tile-pack.js";
import { type PreviewCell, previewRows } from "../ui/render/tile-preview.js";
import { logger } from "../utils/log.js";

/**
 * Reading tile packs off disk.
 *
 * The same shape as `content/load.ts` and for the same reason: `ui/render` has to stay
 * callable from a test and a headless tool with no `.packs` directory, so the
 * filesystem lives out here and the renderer takes a value.
 *
 * And the same failure policy. Every way a pack can be wrong — missing, unparseable,
 * a double-width glyph that would tear the row — logs and falls back to the built-in
 * look. The player asked to play, not to debug somebody's JSON, and a game that
 * refuses to start over a tile is worse than a game that starts looking ordinary.
 */

export function tilePackRoot(): string {
	return join(packRoot(), "tiles");
}

/** Tile pack names available on disk, for a launcher or an error message. */
export function listTilePacks(): string[] {
	const root = tilePackRoot();
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "tiles.json")))
		.map((entry) => entry.name)
		.sort();
}

/** Read one pack directory into a resolved theme, or undefined if it is unusable. */
export function readTilePack(directory: string): TileTheme | undefined {
	const manifestPath = join(directory, "tiles.json");
	if (!existsSync(manifestPath)) {
		logger.warn(`tile pack ${directory} has no tiles.json`);
		return undefined;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch (error) {
		logger.warn(`tile pack ${manifestPath} is not valid JSON`, error);
		return undefined;
	}

	const parsed = TilePackSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		logger.warn(
			`tile pack ${manifestPath} is not usable: ${issue?.path.join(".") || "(root)"} ${issue?.message ?? "?"}`,
		);
		return undefined;
	}

	const atlasPath = join(directory, "atlas.png");
	let atlas: Uint8Array | undefined;
	if (existsSync(atlasPath)) {
		try {
			atlas = readFileSync(atlasPath);
		} catch (error) {
			logger.warn(`tile pack ${atlasPath} could not be read`, error);
		}
	}

	try {
		return resolveTheme(compilePack(parsed.data, atlas));
	} catch (error) {
		// `resolveTheme` throws on an unsafe glyph, which is the one thing a pack can do
		// that would break the display rather than merely look wrong.
		logger.warn(`tile pack ${parsed.data.name} was refused: ${(error as Error).message}`);
		return undefined;
	}
}

/**
 * Resolve what a world asked for: a shipped name, or a path to a directory.
 *
 * Mirrors `resolveOverride` exactly, down to which spellings count as a path, so a
 * player who has learned how `CONTENT_PACK` behaves already knows how this behaves.
 */
export function resolveTileTheme(spec: string | undefined): TileTheme {
	const wanted = spec?.trim();
	if (!wanted) return DEFAULT_THEME;

	const looksLikePath = wanted.includes("/") || wanted.includes("\\");
	const directory = looksLikePath ? resolve(wanted) : join(tilePackRoot(), wanted);
	if (!existsSync(directory)) {
		logger.warn(`no tile pack named "${wanted}"; known: ${listTilePacks().join(", ") || "none"}`);
		return DEFAULT_THEME;
	}
	return readTilePack(directory) ?? DEFAULT_THEME;
}

/** A tile pack, as a chooser needs it: what it is called, what it is, and what it looks like. */
export interface TilePackEntry {
	readonly name: string;
	readonly description?: string;
	/** A few rows of a world drawn in it. Empty only if the pack could not be read. */
	readonly preview: readonly (readonly PreviewCell[])[];
}

/**
 * Every tile pack on disk, with a description and a strip of world drawn in it.
 *
 * The preview is the point, and the description is the consolation prize. A look is the
 * one setting on the page that is *entirely* visual, so a sentence about it is a
 * description of a picture — and three rows of the actual thing answers the question
 * that no amount of "warm, inked, high-contrast" ever will.
 *
 * Resolving a pack means reading its manifest, its atlas and building its glyph tables,
 * which is real work per pack — so this is called once when the page mounts rather than
 * per keystroke as the cursor moves along the list.
 */
export function tilePackCatalogue(): TilePackEntry[] {
	return listTilePacks().map((name) => {
		const theme = readTilePack(join(tilePackRoot(), name));
		return {
			name,
			...(theme?.description ? { description: theme.description } : {}),
			preview: theme ? previewRows(theme) : [],
		};
	});
}

/** The built-in look, offered alongside the packs so it can be previewed too. */
export function defaultTilePackEntry(name: string): TilePackEntry {
	return {
		name,
		description: "The built-in look: muted, readable, and what every world starts as.",
		preview: previewRows(DEFAULT_THEME),
	};
}
