/**
 * Time the pixel path, stage by stage.
 *
 * A frame goes composite -> rasterise -> deflate -> base64, and only one of
 * those is worth optimising. Guessing which cost a round of work on the wrong
 * one, so this measures each against real terminal geometry rather than against
 * a convenient square.
 *
 *   npx vite-node src/tools/pixel-bench.ts -- --cell 19x42 --cols 163 --rows 29
 */
import { deflateSync } from "node:zlib";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { CHUNK } from "../core/world/coords.js";
import { composeScene } from "../ui/render/compose.js";
import { lightFor } from "../ui/render/lighting.js";
import { rasterScene, tileFit } from "../ui/render/raster.js";
import { TILE_PX } from "../ui/render/sprite.js";
import { createWorldTileSource } from "../ui/render/world-source.js";

function arg(name: string, fallback: string): string {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

const [cellW, cellH] = arg("cell", "19x42").split("x").map(Number) as [number, number];
const columns = Number(arg("cols", "163"));
const rows = Number(arg("rows", "29"));
const tilePx = Number(arg("tile", String(TILE_PX)));
const passes = Number(arg("passes", "20"));
const DEFLATE_LEVEL = Number(arg("level", "1"));

const seed = hashString("bench");
const { chunk } = generateChunk({ seed }, { cx: 0, cy: 0 });
const source = createWorldTileSource({
	seed,
	chunkAt: (qx, qy) => (qx === 0 && qy === 0 ? chunk : undefined),
});

const fit = tileFit(columns, rows, { width: cellW, height: cellH }, tilePx);
const light = lightFor(14, undefined, false);
const options = { tint: light.tint, tintStrength: light.strength, shadows: true, relief: true };

function time(label: string, run: () => void): number {
	// One pass first, so a cold JIT is not attributed to the stage.
	run();
	const start = performance.now();
	for (let i = 0; i < passes; i++) run();
	const each = (performance.now() - start) / passes;
	process.stdout.write(`${label.padEnd(14)} ${each.toFixed(1)} ms\n`);
	return each;
}

const camera = { x: CHUNK / 2, y: CHUNK / 2, width: fit.width, height: fit.height };
const megapixels = (fit.width * tilePx * (fit.height * tilePx)) / 1e6;

process.stdout.write(
	`cell ${cellW}x${cellH}px, map ${columns}x${rows} cells, tile ${tilePx}px\n` +
		`camera ${fit.width}x${fit.height} tiles, image ${fit.width * tilePx}x${fit.height * tilePx}px ` +
		`(${megapixels.toFixed(1)} Mpx, ${(megapixels * 3).toFixed(1)} MB raw)\n\n`,
);

let scene = composeScene(source, camera, options);
let frame = rasterScene(scene, { tilePx });
let deflated = deflateSync(frame.rgb);

const compose = time("compose", () => {
	scene = composeScene(source, camera, options);
});
const raster = time("rasterise", () => {
	frame = rasterScene(scene, { tilePx });
});
const deflate = time("deflate", () => {
	deflated = deflateSync(frame.rgb, { level: DEFLATE_LEVEL });
});
const base64 = time("base64", () => {
	deflated.toString("base64");
});

const total = compose + raster + deflate + base64;
process.stdout.write(
	`\ntotal          ${total.toFixed(1)} ms  (${(1000 / total).toFixed(1)} fps ceiling)\n` +
		`payload        ${(deflated.length / 1024).toFixed(0)} KB deflated, ` +
		`${((deflated.length * 4) / 3 / 1024).toFixed(0)} KB base64\n`,
);

// What each compression level buys and costs, since the choice is a real
// trade — CPU here against bytes down the pipe to the terminal.
if (process.argv.includes("--levels")) {
	process.stdout.write("\nlevel   time     payload\n");
	for (const level of [0, 1, 2, 3, 4, 6, 9]) {
		const start = performance.now();
		let out = deflateSync(frame.rgb, { level });
		for (let i = 1; i < 5; i++) out = deflateSync(frame.rgb, { level });
		const each = (performance.now() - start) / 5;
		process.stdout.write(
			`${String(level).padEnd(7)} ${each.toFixed(1).padStart(6)} ms  ` +
				`${((out.length * 4) / 3 / 1024).toFixed(0).padStart(5)} KB base64\n`,
		);
	}
}
