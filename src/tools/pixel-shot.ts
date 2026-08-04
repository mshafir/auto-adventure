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
 */

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { CHUNK, type ChunkCoord } from "../core/world/coords.js";
import { composeScene } from "../ui/render/compose.js";
import { rasterScene } from "../ui/render/raster.js";
import { TILE_PX } from "../ui/render/sprite.js";
import { createWorldTileSource } from "../ui/render/world-source.js";

function crc32(buf: Buffer): number {
	let c = ~0;
	for (const byte of buf) {
		c ^= byte;
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
	}
	return ~c >>> 0;
}

function chunkPart(type: string, data: Buffer): Buffer {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

/** Minimal truecolour PNG. `rgb` is width*height*3, row-major. */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
	const stride = width * 3;
	// One filter byte per scanline; filter 0 (None) keeps this simple and the
	// images compress fine anyway because tile art repeats.
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunkPart("IHDR", ihdr),
		chunkPart("IDAT", deflateSync(raw, { level: 9 })),
		chunkPart("IEND", Buffer.alloc(0)),
	]);
}

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

	const { chunk } = generateChunk({ seed }, cc);
	const source = createWorldTileSource({
		seed,
		chunkAt: (qx, qy) => (qx === cc.cx && qy === cc.cy ? chunk : undefined),
	});
	const camera = { x: cc.cx * CHUNK, y: cc.cy * CHUNK, width: tilesW, height: tilesH };
	const scene = composeScene(source, camera, { shadows: !flat, relief: !flat });

	// Exactly the buffer the kitty path transmits, so what this writes to a PNG
	// is what the terminal is asked to draw — not a second implementation of it.
	const frame = rasterScene(scene, { tilePx: tile });

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
