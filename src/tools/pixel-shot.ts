/**
 * Write the pixel renderer's frame straight to a PNG.
 *
 * The same buffer the kitty path transmits, so this is not a second
 * implementation of the renderer — it is the renderer, with a different sink.
 * Useful because a PNG can be inspected on any machine, including ones with no
 * kitty graphics support and no terminal at all.
 *
 * PNG rather than the SVG the `screens` tool emits because a viewport is
 * hundreds of thousands of pixels, and one rect each makes an SVG nothing will
 * open happily.
 *
 *   vite-node src/tools/pixel-shot.ts -- --at 4,4 --out /tmp/tiles.png
 *   vite-node src/tools/pixel-shot.ts -- --at 0,-1 --tiles gramarye --recipe .scenarios/green-chapel.json
 */

import { writeFileSync } from "node:fs";
import { resolveTileTheme } from "../content/tiles.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { createInitialState } from "../core/rules/state.js";
import { CHUNK, type ChunkCoord, chunkKey } from "../core/world/coords.js";
import { composeScene } from "../ui/render/compose.js";
import { minimapCells } from "../ui/render/minimap-data.js";
import { paintMinimap } from "../ui/render/overlay.js";
import { encodePng } from "../ui/render/png.js";
import { rasterScene } from "../ui/render/raster.js";
import { TILE_PX } from "../ui/render/sprite.js";
import { createWorldTileSource } from "../ui/render/world-source.js";
import { worldFromArgs } from "./recipe-arg.js";

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

function main() {
	const args = parseArgs(process.argv.slice(2));
	const seedArg = args.get("seed") ?? "alpha";
	const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : hashString(seedArg);
	const at = (args.get("at") ?? "0,0").split(",");
	const cc: ChunkCoord = { cx: Number(at[0] ?? 0) | 0, cy: Number(at[1] ?? 0) | 0 };
	const tilesW = Number(args.get("width") ?? 44);
	const tilesH = Number(args.get("height") ?? 24);
	const zoom = Number(args.get("zoom") ?? 3);
	const tile = Number(args.get("tile") ?? TILE_PX);
	const out = args.get("out") ?? "tiles.png";
	const flat = args.has("flat");

	// Takes `--recipe` for the same reason `preview` and `survey` do: a scenario that
	// says what its world is cannot be looked at through a tool that only knows the seed.
	const world = worldFromArgs(seed, args.get("recipe"));
	const { chunk } = generateChunk({ world }, cc);
	const source = createWorldTileSource({
		seed,
		chunkAt: (qx, qy) => (qx === cc.cx && qy === cc.cy ? chunk : undefined),
	});
	const camera = { x: cc.cx * CHUNK, y: cc.cy * CHUNK, width: tilesW, height: tilesH };
	const theme = resolveTileTheme(args.get("tiles"));
	const scene = composeScene(source, camera, { theme, shadows: !flat, relief: !flat });

	// Exactly the buffer the kitty path transmits, so what this writes to a PNG
	// is what the terminal is asked to draw — not a second implementation of it.
	const frame = rasterScene(scene, { tilePx: tile, sprites: theme.sprites });

	// `--minimap` paints the overlay the game paints, from a state that has walked
	// the chunks around the camera. Without it there is no way to look at the
	// pixel minimap short of a kitty terminal and a pair of eyes.
	if (args.has("minimap")) {
		const discovered: string[] = [];
		for (let dy = -8; dy <= 8; dy++) {
			for (let dx = -8; dx <= 8; dx++) discovered.push(chunkKey(cc.cx + dx, cc.cy + dy));
		}
		const state = {
			...createInitialState(
				{ id: "shot", name: "shot", seed, createdAt: "2026-01-01T00:00:00.000Z" },
				{ x: camera.x + Math.floor(tilesW / 2), y: camera.y + Math.floor(tilesH / 2) },
			),
			discovered,
		};
		const chunkPx = Number(args.get("chunk-px") ?? tile * 2);
		paintMinimap(frame, minimapCells(state, 13, 7), {
			chunk: { width: chunkPx, height: chunkPx },
		});
	}

	// Magnified by nearest-neighbour, because the point is to inspect pixels.
	const zw = frame.width * zoom;
	const buf = Buffer.alloc(zw * frame.height * zoom * 3);
	for (let y = 0; y < frame.height; y++) {
		for (let x = 0; x < frame.width; x++) {
			const src = (y * frame.width + x) * 3;
			for (let dy = 0; dy < zoom; dy++) {
				let i = ((y * zoom + dy) * zw + x * zoom) * 3;
				for (let dx = 0; dx < zoom; dx++) {
					buf[i++] = frame.rgb[src] as number;
					buf[i++] = frame.rgb[src + 1] as number;
					buf[i++] = frame.rgb[src + 2] as number;
				}
			}
		}
	}

	writeFileSync(out, encodePng(zw, frame.height * zoom, buf));
	process.stdout.write(
		`${out}  ${frame.width}x${frame.height} px (${tilesW}x${tilesH} tiles at ${tile}px) at ${zoom}x\n`,
	);
}

main();
