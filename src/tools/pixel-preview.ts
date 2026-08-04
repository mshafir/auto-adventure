/**
 * Render the same world twice — glyph tiles and quadrant pixel tiles — and
 * report what the second costs.
 *
 * This exists because frame size is the number this renderer keeps score with
 * (see the notes in `sync-output.ts` and `compose.ts`), and "pixel tiles are
 * more expensive" is worth very little as a claim without a figure attached.
 * Both modes are given the *same terminal rectangle*, which is the only fair
 * comparison: pixel mode buys resolution by spending vertical field of view,
 * not by spending cells.
 *
 *   vite-node src/tools/pixel-preview.ts -- --seed alpha --at 0,0
 */
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { CHUNK, type ChunkCoord } from "../core/world/coords.js";
import { encodeScene } from "../ui/render/ansi.js";
import { type ColorDepth, detectColorDepth, type RGB } from "../ui/render/color.js";
import { type Cell, composeScene } from "../ui/render/compose.js";
import { allRegisteredGlyphs } from "../ui/render/glyphs.js";
import {
	encodeQuadrantScene,
	type QuadCell,
	quadrantScene,
	tilesAcrossQuadrant,
	tilesDownQuadrant,
} from "../ui/render/quadrant.js";
import { expandScene, TILE_WIDTH, tilesAcross } from "../ui/render/scale.js";
import { spriteCoverage } from "../ui/render/sprite.js";
import { createWorldTileSource } from "../ui/render/world-source.js";

function parseArgs(argv: readonly string[]) {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i] ?? "");
		if (!match?.[1]) continue;
		if (match[2] !== undefined) {
			args.set(match[1], match[2]);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			args.set(match[1], next);
			i++;
		} else {
			args.set(match[1], "true");
		}
	}
	return args;
}

const key = (c: RGB) => `${c[0]},${c[1]},${c[2]}`;

function styleCount(cells: Iterable<{ fg: RGB; bg: RGB }>): number {
	const seen = new Set<string>();
	for (const c of cells) seen.add(`${key(c.fg)}/${key(c.bg)}`);
	return seen.size;
}

function bytes(lines: readonly string[]): number {
	return lines.reduce((n, line) => n + Buffer.byteLength(line, "utf8"), 0);
}

function kb(n: number): string {
	return `${(n / 1024).toFixed(1)}KB`;
}

function pct(a: number, b: number): string {
	if (b === 0) return "n/a";
	const d = ((a - b) / b) * 100;
	return `${d >= 0 ? "+" : ""}${d.toFixed(0)}%`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const seedArg = args.get("seed") ?? "alpha";
	const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : hashString(seedArg);
	const at = (args.get("at") ?? "0,0").split(",");
	const cc: ChunkCoord = { cx: Number(at[0] ?? 0) | 0, cy: Number(at[1] ?? 0) | 0 };

	// The terminal rectangle both modes must fit into. Defaults to a 120x40
	// terminal minus the 32-column side panel and a few rows of HUD, which is
	// what the game actually gives the map.
	const columns = Number(args.get("columns") ?? 88);
	const rows = Number(args.get("rows") ?? 34);
	const depth = (args.get("color") as ColorDepth | undefined) ?? detectColorDepth();
	const mode = args.get("mode") ?? "both";
	const flat = args.has("flat");

	const { chunk } = generateChunk({ seed }, cc);
	const source = createWorldTileSource({
		seed,
		chunkAt: (qx, qy) => (qx === cc.cx && qy === cc.cy ? chunk : undefined),
	});
	const options = { shadows: !flat, relief: !flat };
	const origin = { x: cc.cx * CHUNK, y: cc.cy * CHUNK };

	// --- glyph mode: one row per tile, TILE_WIDTH columns per tile ----------
	const glyphCamera = { ...origin, width: tilesAcross(columns), height: rows };
	const glyphScene = composeScene(source, glyphCamera, options);
	const glyphCells = expandScene(glyphScene, TILE_WIDTH, glyphCamera);
	const glyphLines = encodeScene(glyphCells, depth);

	// --- pixel mode: half a tile per row, half a tile per column ------------
	const pixelCamera = {
		...origin,
		width: tilesAcrossQuadrant(columns),
		height: tilesDownQuadrant(rows),
	};
	const pixelScene = composeScene(source, pixelCamera, options);
	const quads = quadrantScene(pixelScene);
	const pixelLines = encodeQuadrantScene(quads, depth);
	const naiveLines = encodeQuadrantScene(quads, depth, { polarity: false });

	if (mode === "glyph" || mode === "both") {
		process.stdout.write(`\nglyph tiles — ${glyphCamera.width}x${glyphCamera.height} tiles\n`);
		process.stdout.write(`${glyphLines.join("\n")}\n`);
	}
	if (mode === "pixel" || mode === "both") {
		process.stdout.write(
			`\nquadrant pixel tiles — ${pixelCamera.width}x${pixelCamera.height} tiles\n`,
		);
		process.stdout.write(`${pixelLines.join("\n")}\n`);
	}

	const flatGlyph = glyphCells.flat() as Cell[];
	const flatQuad = quads.flat() as QuadCell[];
	const { missing } = spriteCoverage(allRegisteredGlyphs());

	const g = bytes(glyphLines);
	const p = bytes(pixelLines);
	const n = bytes(naiveLines);

	process.stdout.write(
		[
			"",
			`seed ${seedArg} (${seed})  chunk ${cc.cx},${cc.cy}  rect ${columns}x${rows} cells  depth ${depth}`,
			"",
			`glyph   ${String(glyphCamera.width).padStart(3)}x${String(glyphCamera.height).padEnd(3)} tiles  ${kb(g).padStart(7)}  ${String(styleCount(flatGlyph)).padStart(4)} styles`,
			`pixel   ${String(pixelCamera.width).padStart(3)}x${String(pixelCamera.height).padEnd(3)} tiles  ${kb(p).padStart(7)}  ${String(styleCount(flatQuad)).padStart(4)} styles   ${pct(p, g)} bytes vs glyph`,
			`  without polarity choice        ${kb(n).padStart(7)}                  ${pct(n, g)} bytes vs glyph`,
			`  polarity saves                 ${kb(n - p).padStart(7)}  (${pct(p, n)})`,
			"",
			`tiles shown: glyph ${glyphCamera.width * glyphCamera.height}, pixel ${pixelCamera.width * pixelCamera.height} (${Math.round((pixelCamera.width * pixelCamera.height * 100) / (glyphCamera.width * glyphCamera.height))}% of the view)`,
			`pixels per tile: glyph 1 (a glyph), pixel 16 (4x4)`,
			missing.length > 0
				? `glyphs with no sprite (${missing.length}): ${missing.join(" ")}`
				: "sprite coverage: every registered glyph has a sprite",
			"",
		].join("\n"),
	);
}

main();
