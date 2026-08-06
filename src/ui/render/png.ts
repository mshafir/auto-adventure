import { deflateSync, inflateSync } from "node:zlib";

/**
 * PNG, both ways, in about two hundred lines and with no dependency.
 *
 * The encoder was already here — inside `tools/pixel-shot.ts`, because that was the
 * only thing that needed it. Tile packs need the other direction: art arrives as a
 * PNG, because that is the format art arrives in, and a full-colour tile atlas has no
 * business being base64 inside a JSON file. Having both halves in one module is also
 * what lets a round-trip test exist, which is the only honest way to check a decoder.
 *
 * Deliberately narrow. It reads 8-bit truecolour with or without alpha, no
 * interlacing, no palettes, no 16-bit — which is what every tool writes by default and
 * what the encoder below emits. Anything else is refused with a message naming what it
 * found, rather than decoded wrongly into a picture of static.
 */

export interface Image {
	readonly width: number;
	readonly height: number;
	/** Packed RGBA, four bytes per pixel, row-major. */
	readonly rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

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

/**
 * Minimal truecolour PNG. `pixels` is width*height*`channels`, row-major.
 *
 * Three channels is a screenshot; four is a tile atlas. The alpha path is not
 * decoration: a decor tile with no transparency is a decor tile with a rectangle of
 * background painted round it, and {@link decodePng} has always read colour type 6 —
 * so without this the repo could read an atlas it had no way to write.
 */
export function encodePng(
	width: number,
	height: number,
	pixels: Buffer,
	channels: 3 | 4 = 3,
): Buffer {
	const stride = width * channels;
	// One filter byte per scanline; filter 0 (None) keeps this simple and the
	// images compress fine anyway because tile art repeats.
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0;
		pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = channels === 4 ? 6 : 2; // colour type: truecolour, with alpha or without
	return Buffer.concat([
		Buffer.from(SIGNATURE),
		chunkPart("IHDR", ihdr),
		chunkPart("IDAT", deflateSync(raw, { level: 9 })),
		chunkPart("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Read a PNG into packed RGBA.
 *
 * Always RGBA out, whatever came in, because the caller is compositing tiles and an
 * opaque atlas and a cut-out one should not be two code paths. A truecolour source
 * gets an alpha of 255 throughout.
 */
export function decodePng(data: Uint8Array): Image {
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	for (const [i, byte] of SIGNATURE.entries()) {
		if (buf[i] !== byte) throw new Error("not a PNG (bad signature)");
	}

	let width = 0;
	let height = 0;
	let depth = 0;
	let colour = -1;
	const idat: Buffer[] = [];

	let at = 8;
	while (at + 8 <= buf.length) {
		const length = buf.readUInt32BE(at);
		const type = buf.toString("ascii", at + 4, at + 8);
		const body = buf.subarray(at + 8, at + 8 + length);
		at += 12 + length;

		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8] as number;
			colour = body[9] as number;
			const interlace = body[12] as number;
			if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported (want 8)`);
			if (colour !== 2 && colour !== 6) {
				throw new Error(`PNG colour type ${colour} is not supported (want truecolour, 2 or 6)`);
			}
			if (interlace !== 0) throw new Error("interlaced PNG is not supported");
		} else if (type === "IDAT") {
			idat.push(Buffer.from(body));
		} else if (type === "IEND") {
			break;
		}
	}

	if (width === 0 || height === 0) throw new Error("PNG has no IHDR");
	const channels = colour === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) throw new Error("PNG data is short");

	const rgba = new Uint8Array(width * height * 4);
	// Unfiltered in place, one scanline at a time. Every filter refers to the
	// reconstructed bytes of the line above, so the previous line must already be
	// undone — which is why this cannot be done per pixel in isolation.
	const line = new Uint8Array(stride);
	const previous = new Uint8Array(stride);
	for (let y = 0; y < height; y++) {
		const offset = y * (stride + 1);
		const filter = raw[offset] as number;
		for (let i = 0; i < stride; i++) line[i] = raw[offset + 1 + i] as number;
		unfilter(filter, line, previous, channels);

		for (let x = 0; x < width; x++) {
			const from = x * channels;
			const to = (y * width + x) * 4;
			rgba[to] = line[from] as number;
			rgba[to + 1] = line[from + 1] as number;
			rgba[to + 2] = line[from + 2] as number;
			rgba[to + 3] = channels === 4 ? (line[from + 3] as number) : 255;
		}
		previous.set(line);
	}

	return { width, height, rgba };
}

/**
 * Undo one scanline's filter, in place.
 *
 * The five PNG filters, spelled out rather than folded together, because each is a
 * one-line recurrence and a clever unified version of them is unreadable and no
 * faster. `bpp` is the byte offset of the pixel to the left.
 */
function unfilter(filter: number, line: Uint8Array, previous: Uint8Array, bpp: number): void {
	const n = line.length;
	switch (filter) {
		case 0:
			return;
		case 1:
			for (let i = bpp; i < n; i++)
				line[i] = ((line[i] as number) + (line[i - bpp] as number)) & 255;
			return;
		case 2:
			for (let i = 0; i < n; i++) line[i] = ((line[i] as number) + (previous[i] as number)) & 255;
			return;
		case 3:
			for (let i = 0; i < n; i++) {
				const left = i >= bpp ? (line[i - bpp] as number) : 0;
				line[i] = ((line[i] as number) + ((left + (previous[i] as number)) >> 1)) & 255;
			}
			return;
		case 4:
			for (let i = 0; i < n; i++) {
				const left = i >= bpp ? (line[i - bpp] as number) : 0;
				const up = previous[i] as number;
				const upLeft = i >= bpp ? (previous[i - bpp] as number) : 0;
				line[i] = ((line[i] as number) + paeth(left, up, upLeft)) & 255;
			}
			return;
		default:
			throw new Error(`unknown PNG filter ${filter}`);
	}
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}
