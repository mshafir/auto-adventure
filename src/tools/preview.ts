/**
 * Render generated world straight to stdout, bypassing Ink and the game loop.
 *
 * This is the iteration loop for terrain: no UI, no network, no tokens. Run it
 * against a few seeds and look at the output before touching the generator.
 */

import { resolveTileTheme } from "../content/tiles.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { chunkToAscii } from "../core/tiles/chunk.js";
import { CHUNK, type ChunkCoord } from "../core/world/coords.js";
import { sitesAround } from "../core/world/macro.js";
import { encodeScene } from "../ui/render/ansi.js";
import { type ColorDepth, detectColorDepth } from "../ui/render/color.js";
import { composeScene } from "../ui/render/compose.js";
import { expandScene, TILE_WIDTH } from "../ui/render/scale.js";
import { createWorldTileSource } from "../ui/render/world-source.js";
import { worldFromArgs } from "./recipe-arg.js";

/**
 * Accepts both `--key=value` and `--key value`.
 *
 * Only the `=` form used to parse, so the space-separated form documented in the
 * README turned every flag into the string "true" — `--at 0,0` became chunk
 * `NaN,NaN`, which generates a chunk of pure void and reports it as 100% alpine
 * rather than failing.
 */
function parseArgs(argv: readonly string[]) {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i] ?? "");
		if (!match?.[1]) continue;
		if (match[2] !== undefined) {
			args.set(match[1], match[2]);
			continue;
		}
		// A following token that is not itself a flag is this flag's value.
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

/** Reject a non-finite coordinate rather than generating a chunk of void. */
function coord(text: string, flag: string): number {
	const n = Number(text);
	if (!Number.isFinite(n))
		throw new Error(`--${flag}: expected a number, got ${JSON.stringify(text)}`);
	return Math.trunc(n);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const seedArg = args.get("seed") ?? "alpha";
	const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : hashString(seedArg);

	const at = (args.get("at") ?? "0,0").split(",");
	const cc: ChunkCoord = { cx: coord(at[0] ?? "0", "at"), cy: coord(at[1] ?? "0", "at") };
	const width = Number(args.get("width") ?? CHUNK);
	const height = Number(args.get("height") ?? 32);
	const depth = (args.get("color") as ColorDepth | undefined) ?? detectColorDepth();
	const ascii = args.has("ascii");
	// Defaults to whatever the game draws, so this stays a faithful preview.
	const xscale = Math.max(1, Math.trunc(Number(args.get("xscale") ?? TILE_WIDTH)) || 1);

	const started = Date.now();
	const { world } = worldFromArgs(seed, args.get("recipe"));
	const theme = resolveTileTheme(args.get("tiles"));
	const { chunk, summary, buildings } = generateChunk({ world }, cc);
	const elapsed = Date.now() - started;

	if (ascii) {
		process.stdout.write(`${chunkToAscii(chunk)}\n`);
	} else {
		const source = createWorldTileSource({
			seed,
			chunkAt: (qx, qy) => (qx === cc.cx && qy === cc.cy ? chunk : undefined),
		});
		// At 2x the same terminal width shows half as many tiles, so narrow the
		// camera to match rather than letting the rows overflow and wrap.
		const camera = {
			x: cc.cx * CHUNK,
			y: cc.cy * CHUNK,
			width: Math.floor(width / xscale),
			height,
		};
		// Matches what the game draws, so this stays a faithful preview.
		const scene = composeScene(source, camera, {
			theme,
			shadows: !args.has("flat"),
			relief: !args.has("flat"),
		});
		const scaled = expandScene(scene, xscale, camera);
		process.stdout.write(`${encodeScene(scaled, depth).join("\n")}\n`);
	}

	const biomes = Object.entries(summary.biomeCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([name, n]) => `${name} ${Math.round((n / (CHUNK * CHUNK)) * 100)}%`)
		.join(", ");

	const sites = sitesAround(world, cc.cx, cc.cy)
		.filter((s) => Math.abs(s.mx - cc.cx) <= 1 && Math.abs(s.my - cc.cy) <= 1)
		.map((s) => `${s.kind}(${s.importance}) r${s.radius} @${s.site.x},${s.site.y}`)
		.join("; ");

	process.stdout.write(
		[
			"",
			`seed ${seedArg} (${seed})  chunk ${cc.cx},${cc.cy}  generated in ${elapsed}ms`,
			`biomes: ${biomes}`,
			`elevation ${summary.elevationRange[0].toFixed(2)}-${summary.elevationRange[1].toFixed(2)}  water ${Math.round(summary.waterFraction * 100)}%  passable ${Math.round(summary.passableFraction * 100)}%`,
			`roads in: ${summary.roadEntries.join(", ") || "none"}  river: ${summary.hasRiver ? "yes" : "no"}`,
			`sites nearby: ${sites || "none"}`,
			`buildings here: ${buildings.length}${buildings.length ? ` (${[...new Set(buildings.map((b) => b.kind))].join(", ")})` : ""}`,
			"",
		].join("\n"),
	);
}

main();
