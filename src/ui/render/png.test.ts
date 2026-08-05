import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, encodePng } from "./png.js";

/**
 * A decoder is only honestly tested against bytes it did not write, so the filtered
 * cases below are assembled by hand: the encoder always writes filter 0, and a decoder
 * that only ever sees its own output is a decoder that has never been tested.
 */

function rgbOf(
	width: number,
	height: number,
	fn: (x: number, y: number) => [number, number, number],
) {
	const rgb = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = fn(x, y);
			const at = (y * width + x) * 3;
			rgb[at] = r;
			rgb[at + 1] = g;
			rgb[at + 2] = b;
		}
	}
	return rgb;
}

/** A PNG with a filter of our choosing, so the decoder meets bytes it did not write. */
function pngWithFilter(
	width: number,
	height: number,
	filter: number,
	rows: number[][],
): Uint8Array {
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = filter;
		for (let i = 0; i < stride; i++)
			raw[y * (stride + 1) + 1 + i] = (rows[y] as number[])[i] as number;
	}
	const crc = (buf: Buffer) => {
		let c = ~0;
		for (const byte of buf) {
			c ^= byte;
			for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
		}
		return ~c >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe("round trip", () => {
	it("gets back exactly what it wrote", () => {
		const rgb = rgbOf(9, 5, (x, y) => [x * 20, y * 40, (x * y) % 256]);
		const image = decodePng(encodePng(9, 5, rgb));
		expect(image.width).toBe(9);
		expect(image.height).toBe(5);
		for (let i = 0; i < 45; i++) {
			expect([image.rgba[i * 4], image.rgba[i * 4 + 1], image.rgba[i * 4 + 2]]).toEqual([
				rgb[i * 3],
				rgb[i * 3 + 1],
				rgb[i * 3 + 2],
			]);
		}
	});

	it("fills in opaque alpha for a truecolour source", () => {
		const image = decodePng(
			encodePng(
				2,
				2,
				rgbOf(2, 2, () => [1, 2, 3]),
			),
		);
		expect([...image.rgba.filter((_, i) => i % 4 === 3)]).toEqual([255, 255, 255, 255]);
	});
});

describe("filters it did not write", () => {
	// Filter 1 is Sub: each byte is stored as its difference from the pixel to the
	// left. A decoder that ignored the filter byte would read this as a gradient
	// running the wrong way, which is exactly the kind of wrong that still looks
	// like a picture.
	it("undoes Sub", () => {
		const bytes = pngWithFilter(3, 1, 1, [[10, 20, 30, 5, 5, 5, 1, 1, 1]]);
		const image = decodePng(bytes);
		expect([...image.rgba.slice(0, 12)]).toEqual([
			10, 20, 30, 255, 15, 25, 35, 255, 16, 26, 36, 255,
		]);
	});

	it("undoes Up", () => {
		const bytes = pngWithFilter(1, 3, 2, [
			[10, 20, 30],
			[1, 2, 3],
			[1, 1, 1],
		]);
		const image = decodePng(bytes);
		expect([...image.rgba]).toEqual([10, 20, 30, 255, 11, 22, 33, 255, 12, 23, 34, 255]);
	});

	it("undoes Paeth", () => {
		// The predictor picks whichever of left, up and up-left is nearest a linear
		// estimate, so on the first row with nothing above it, it degenerates to Sub.
		const bytes = pngWithFilter(2, 1, 4, [[9, 9, 9, 1, 1, 1]]);
		const image = decodePng(bytes);
		expect([...image.rgba]).toEqual([9, 9, 9, 255, 10, 10, 10, 255]);
	});
});

describe("what it refuses", () => {
	it("refuses something that is not a PNG", () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
	});

	it("names what it found rather than decoding it wrongly", () => {
		// Colour type 3 is a palette. Reading its index bytes as RGB triples produces a
		// picture — of static — which is worse than refusing.
		// Signature (8) + length (4) + type (4) puts IHDR's data at 16; colour type is
		// its tenth byte.
		const bytes = Buffer.from(encodePng(1, 1, Buffer.from([0, 0, 0])));
		bytes[16 + 9] = 3;
		// The IHDR crc is now wrong, but nothing checks it; what matters is the message.
		expect(() => decodePng(bytes)).toThrow(/colour type/);
	});
});
