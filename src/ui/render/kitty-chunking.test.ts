import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { transmitFrame } from "./kitty.js";

const ESC = "";

/**
 * Decode a transmission the way a terminal would.
 *
 * Written against the wire format rather than against `transmitFrame`'s
 * internals, so it fails if the escapes are malformed in any way a terminal
 * would care about — the point being to check chunking without a terminal to
 * check it in.
 */
function receive(escapes: string) {
	const parts = escapes.split(`${ESC}_G`).slice(1);
	const controls: Record<string, string>[] = [];
	let payload = "";

	for (const part of parts) {
		expect(part.endsWith(`${ESC}\\`), "chunk is not terminated with ST").toBe(true);
		const body = part.slice(0, -2);
		const semi = body.indexOf(";");
		expect(semi, "chunk has no ; separating control data from payload").toBeGreaterThan(-1);
		const control: Record<string, string> = {};
		for (const pair of body.slice(0, semi).split(",")) {
			const [k, v] = pair.split("=");
			if (k) control[k] = v ?? "";
		}
		controls.push(control);
		payload += body.slice(semi + 1);
	}

	return { controls, rgb: inflateSync(Buffer.from(payload, "base64")) };
}

/** An image deflate cannot collapse, so it is guaranteed to need many chunks. */
function noise(width: number, height: number): Buffer {
	const rgb = Buffer.alloc(width * height * 3);
	let x = 88675123;
	for (let i = 0; i < rgb.length; i++) {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		rgb[i] = x & 0xff;
	}
	return rgb;
}

describe("chunked transmission", () => {
	const width = 320;
	const height = 256;
	const rgb = noise(width, height);
	const escapes = transmitFrame({ rgb, width, height, columns: 40, rows: 16 });
	const { controls, rgb: received } = receive(escapes);

	it("needs many chunks, as a real frame does", () => {
		// The bug this file exists for: the original smoke test used a flat pattern
		// that fitted in one chunk, so it passed while the game drew nothing.
		expect(controls.length).toBeGreaterThan(8);
	});

	// The whole question: do the pieces reassemble into the pixels we started
	// with? If they do, chunking is not what is breaking the map.
	it("reassembles to exactly the pixels that went in", () => {
		expect(received.length).toBe(rgb.length);
		expect(received.equals(rgb)).toBe(true);
	});

	it("puts the control data on the first chunk only", () => {
		const [first, ...rest] = controls;
		expect(first?.a).toBe("T");
		expect(first?.f).toBe("24");
		expect(first?.s).toBe(String(width));
		expect(first?.v).toBe(String(height));
		for (const control of rest) {
			// A terminal reads a repeated `a=` on a continuation chunk as a new
			// command, which is how a transmission turns into garbage on screen.
			expect(Object.keys(control)).toEqual(["m"]);
		}
	});

	it("marks every chunk but the last as continuing", () => {
		const flags = controls.map((c) => c.m);
		expect(flags.slice(0, -1).every((m) => m === "1")).toBe(true);
		expect(flags.at(-1)).toBe("0");
	});

	it("splits on base64 boundaries so no chunk ends mid-quantum", () => {
		for (const part of escapes.split(`${ESC}_G`).slice(1, -1)) {
			const body = part.slice(0, -2);
			const data = body.slice(body.indexOf(";") + 1);
			expect(data.length % 4).toBe(0);
			expect(data).not.toContain("=");
		}
	});

	it("keeps each chunk's payload within the 4096-byte limit", () => {
		for (const part of escapes.split(`${ESC}_G`).slice(1)) {
			const body = part.slice(0, -2);
			expect(body.slice(body.indexOf(";") + 1).length).toBeLessThanOrEqual(4096);
		}
	});

	it("emits no newline inside an escape, which would end it early", () => {
		for (const part of escapes.split(`${ESC}_G`).slice(1)) {
			expect(part).not.toContain("\n");
		}
	});

	it("round-trips a single-chunk frame too", () => {
		const flat = Buffer.alloc(64 * 64 * 3, 7);
		const one = transmitFrame({ rgb: flat, width: 64, height: 64, columns: 8, rows: 4 });
		const got = receive(one);
		expect(got.controls).toHaveLength(1);
		expect(got.rgb.equals(flat)).toBe(true);
	});
});
