import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import stringWidth from "string-width";
import { repoRoot } from "../../paths.js";

/**
 * The title, as art, read off disk.
 *
 * In a file rather than a string literal because it *is* art: nobody wants to
 * count the columns of a `#`-block letter inside a TypeScript template, and a
 * theme pack should eventually be able to bring its own. Read through `repoRoot`
 * for the same reason the content packs are — the game is started from the repo,
 * from `dist/` and from wherever a player happens to be standing.
 *
 * The file holds several sizes, widest first, separated by a line of `---`. That
 * is the whole format, and it exists because a title screen has to survive an
 * eighty-column terminal: the widest banner is 77 columns and would wrap into
 * nonsense, so a narrower stacked one takes over, then a two-row face for a short
 * one, and below that the plain words. Wrapping is the failure mode worth designing
 * against — a wrapped banner does not look small, it looks broken.
 *
 * The letterforms are Block Elements, which `glyph-safety.ts` vouches for as
 * single-width and which the map already draws thousands of every frame. A
 * character from a block that attracts emoji presentation would shear the art on
 * the one screen that has no fallback to shear into.
 */
const TITLE = join(repoRoot(), "assets", "ui", "title.txt");

/** What is shown when the file is missing, or when nothing in it fits. */
export const PLAIN_TITLE = "AUTO ADVENTURE";

export interface Banner {
	readonly lines: readonly string[];
	readonly width: number;
	readonly height: number;
}

let cached: readonly Banner[] | undefined;

/** Every size in the file, widest first. Read once; it cannot change while running. */
export function bannerVariants(path = TITLE): readonly Banner[] {
	if (cached && path === TITLE) return cached;

	const variants = readVariants(path);
	if (path === TITLE) cached = variants;
	return variants;
}

function readVariants(path: string): readonly Banner[] {
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// A title screen is not worth failing a launch over; the plain words will do.
		return [];
	}

	return raw
		.split(/^---$/m)
		.map((block) => block.split("\n"))
		.map(trimBlankEnds)
		.filter((lines) => lines.length > 0)
		.map((lines) => ({
			lines,
			// `stringWidth`, not `length`: the block letterforms are outside ASCII, and
			// a size chosen on code-unit count would let one through that wraps.
			width: Math.max(...lines.map((line) => stringWidth(line))),
			height: lines.length,
		}))
		.sort((a, b) => b.width - a.width);
}

/** Leading and trailing blank lines are formatting in the file, not part of the art. */
function trimBlankEnds(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
	return lines.slice(start, end);
}

/**
 * The largest banner that fits, or the plain words if none does.
 *
 * Never returns something too wide. A banner that wraps is worse than no banner —
 * it reads as a rendering fault rather than as a small terminal.
 *
 * Height matters as much as width and for a different reason. The two big sizes
 * are eleven rows and five; on a short terminal the eleven-row one would push the
 * menu off the bottom of the frame, so the two-row face exists to be chosen there
 * rather than to be narrower.
 */
export function bannerFor(columns: number, rows: number, path = TITLE): readonly string[] {
	const fits = bannerVariants(path).find(
		(variant) => variant.width <= columns && variant.height <= rows,
	);
	return fits?.lines ?? [PLAIN_TITLE];
}

/** Test seam, for a suite that points at a fixture file. */
export function clearBannerCache(): void {
	cached = undefined;
}
