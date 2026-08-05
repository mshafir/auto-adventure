import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushGraphics, queueGraphics, withSynchronizedOutput } from "./sync-output.js";

const BEGIN = "\u001B[?2026h";
const END = "\u001B[?2026l";

/** Just enough of a stream for the wrapper, plus the properties Ink reads. */
function fakeStream() {
	const writes: unknown[] = [];
	const stream = new EventEmitter() as unknown as NodeJS.WriteStream & { writes: unknown[] };
	Object.assign(stream, {
		writes,
		columns: 120,
		rows: 40,
		isTTY: true,
		write(chunk: unknown) {
			writes.push(chunk);
			return true;
		},
	});
	return stream;
}

const wasTTY = process.stdout.isTTY;

beforeEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_SYNC_OUTPUT;
});

afterEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: wasTTY, configurable: true });
	delete process.env.NO_SYNC_OUTPUT;
	// The queue is module state, so a test that queues and never writes would
	// otherwise hand its image to whichever test ran next.
	flushGraphics();
});

describe("synchronized output", () => {
	it("brackets a frame so the terminal presents it in one go", () => {
		const stream = fakeStream();
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual([`${BEGIN}FRAME${END}`]);
	});

	it("emits exactly one update per write, because Ink erases and repaints together", () => {
		// Ink writes `eraseLines(n) + output` in a single call. If the markers were
		// ever split across two writes the erase would be presented on its own,
		// which is the flicker this exists to remove.
		const stream = fakeStream();
		const out = withSynchronizedOutput(stream);
		out.write("erase+paint one");
		out.write("erase+paint two");
		for (const write of stream.writes) {
			expect(String(write).startsWith(BEGIN)).toBe(true);
			expect(String(write).endsWith(END)).toBe(true);
			expect(String(write).split(BEGIN)).toHaveLength(2);
		}
	});

	it("passes a Buffer through untouched rather than stringifying it", () => {
		const stream = fakeStream();
		const buffer = Buffer.from([1, 2, 3]);
		withSynchronizedOutput(stream).write(buffer);
		expect(stream.writes).toEqual([buffer]);
	});

	it("forwards the properties Ink reads off stdout", () => {
		const wrapped = withSynchronizedOutput(fakeStream());
		expect(wrapped.columns).toBe(120);
		expect(wrapped.rows).toBe(40);
		expect(wrapped.isTTY).toBe(true);
	});

	it("keeps the resize event working, with `this` bound to the real stream", () => {
		// A Proxy that returns unbound methods leaves `this` as the proxy, which
		// breaks EventEmitter's internal state in ways that are painful to debug.
		const stream = fakeStream();
		const wrapped = withSynchronizedOutput(stream);
		let seen = 0;
		wrapped.on("resize", () => seen++);
		stream.emit("resize");
		expect(seen).toBe(1);
		expect(stream.listenerCount("resize")).toBe(1);
	});

	it("adds no markers when NO_SYNC_OUTPUT is set", () => {
		process.env.NO_SYNC_OUTPUT = "1";
		const stream = fakeStream();
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual(["FRAME"]);
	});

	it("adds no markers when the output is redirected, so they stay out of files", () => {
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		const stream = fakeStream();
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual(["FRAME"]);
	});

	/*
	 * The whole reason the wrapper is installed even with the markers off. The
	 * pixel renderer queues its image so it lands in the same update as the frame
	 * displaying it; if turning synchronisation off also unhooked the queue, the
	 * image would simply never be written and the map would go blank.
	 */
	it("still carries queued graphics when the markers are off", () => {
		process.env.NO_SYNC_OUTPUT = "1";
		const stream = fakeStream();
		queueGraphics("IMAGE");
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual(["IMAGEFRAME"]);
	});

	// Image first, then the placeholders that display it — the order they were
	// produced in, since Ink writes its frame after the render that queued it.
	it("puts queued graphics inside the update, ahead of the frame", () => {
		const stream = fakeStream();
		queueGraphics("IMAGE");
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual([`${BEGIN}IMAGEFRAME${END}`]);
	});

	// Each transmission is a whole frame. Two renders before one write means the
	// first image will never be displayed, so sending it is pure cost.
	it("keeps only the newest queued image", () => {
		const stream = fakeStream();
		queueGraphics("OLD");
		queueGraphics("NEW");
		withSynchronizedOutput(stream).write("FRAME");
		expect(stream.writes).toEqual([`${BEGIN}NEWFRAME${END}`]);
	});

	it("does not repeat an image on the next frame", () => {
		const stream = fakeStream();
		queueGraphics("IMAGE");
		const out = withSynchronizedOutput(stream);
		out.write("ONE");
		out.write("TWO");
		expect(stream.writes).toEqual([`${BEGIN}IMAGEONE${END}`, `${BEGIN}TWO${END}`]);
	});
});
