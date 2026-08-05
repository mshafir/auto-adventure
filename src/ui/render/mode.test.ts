import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	cellPixels,
	cellPixelsWereMeasured,
	measureCellPixels,
	resolveTileMode,
	setCellPixels,
} from "./mode.js";
import { tileFit } from "./raster.js";

afterEach(() => setCellPixels(undefined));

/** A stdin that answers the cell-size query with whatever it is told to. */
function fakeStdin(reply?: string) {
	const stream = new EventEmitter() as unknown as NodeJS.ReadStream & { isRaw: boolean };
	stream.isTTY = true;
	stream.isRaw = false;
	stream.setRawMode = ((raw: boolean) => {
		stream.isRaw = raw;
		return stream;
	}) as NodeJS.ReadStream["setRawMode"];
	stream.resume = (() => stream) as NodeJS.ReadStream["resume"];
	stream.pause = (() => stream) as NodeJS.ReadStream["pause"];
	if (reply !== undefined) {
		queueMicrotask(() => stream.emit("data", Buffer.from(reply, "latin1")));
	}
	return stream;
}

function fakeStdout() {
	const written: string[] = [];
	const stream = {
		isTTY: true,
		columns: 80,
		rows: 24,
		write: (s: string) => {
			written.push(s);
			return true;
		},
	} as unknown as NodeJS.WriteStream;
	return { stream, written };
}

describe("measureCellPixels", () => {
	it("reads the size the terminal reports", async () => {
		const { stream } = fakeStdout();
		const size = await measureCellPixels(fakeStdin("\u001B[6;30;13t"), stream, 50);
		expect(size).toEqual({ width: 13, height: 30 });
		expect(cellPixelsWereMeasured()).toBe(true);
		expect(cellPixels({})).toEqual({ width: 13, height: 30 });
	});

	/**
	 * Checks the bytes, not just that the string looks right.
	 *
	 * The query shipped once with no escape byte at all: it wrote the literal
	 * text `[16t[14t` to the terminal, which printed it and of course never
	 * answered. The assertion here used to be `toContain("[16t")` — with no
	 * escape either — so it passed against the broken output. A test written in
	 * the same typo as the code proves nothing.
	 */
	it("actually sends escape sequences, not their printable text", async () => {
		const { stream, written } = fakeStdout();
		await measureCellPixels(fakeStdin(), stream, 20);
		expect(written.join("")).toBe("\u001B[16t\u001B[14t");
	});

	it("falls back to the text-area query when the cell query is ignored", async () => {
		const { stream } = fakeStdout();
		// 1168x1184 pixels over a 73x37 grid is a 16x32 cell.
		stream.columns = 73;
		stream.rows = 37;
		const size = await measureCellPixels(fakeStdin("\u001B[4;1184;1168t"), stream, 50);
		expect(size).toEqual({ width: 16, height: 32 });
		expect(cellPixelsWereMeasured()).toBe(true);
	});

	// A terminal that does not implement the query simply never answers, which is
	// the common case and must not hang the launch.
	it("gives up quickly when the terminal says nothing", async () => {
		const { stream } = fakeStdout();
		const size = await measureCellPixels(fakeStdin(), stream, 20);
		expect(size).toEqual({ width: 8, height: 16 });
		expect(cellPixelsWereMeasured()).toBe(false);
	});

	it("leaves stdin as it found it, for Ink to configure", async () => {
		const stdin = fakeStdin("\u001B[6;30;13t");
		const { stream } = fakeStdout();
		await measureCellPixels(stdin, stream, 50);
		expect(stdin.isRaw).toBe(false);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	it("does not query a stream that is not a terminal", async () => {
		const { stream, written } = fakeStdout();
		const stdin = fakeStdin();
		stdin.isTTY = false;
		expect(await measureCellPixels(stdin, stream, 20)).toEqual({ width: 8, height: 16 });
		expect(written).toHaveLength(0);
	});

	it("lets CELL_PX override a measurement", async () => {
		const { stream } = fakeStdout();
		await measureCellPixels(fakeStdin("\u001B[6;30;13t"), stream, 50);
		expect(cellPixels({ CELL_PX: "9x18" })).toEqual({ width: 9, height: 18 });
	});
});

describe("tileFit", () => {
	/**
	 * The reason the cell size is worth querying rather than guessing. The camera
	 * is sized from this, so a wrong cell size draws a viewport of one shape while
	 * centring the player for a viewport of another — and the player drifts toward
	 * an edge instead of staying in the middle.
	 */
	it("fits a different number of tiles as the cell size changes", () => {
		const guessed = tileFit(88, 28, { width: 8, height: 16 });
		const real = tileFit(88, 28, { width: 13, height: 30 });
		expect(guessed).toEqual({ width: 44, height: 28 });
		expect(real).toEqual({ width: 71, height: 52 });
	});

	it("never returns zero tiles", () => {
		expect(tileFit(1, 1, { width: 2, height: 2 })).toEqual({ width: 1, height: 1 });
	});
});

describe("resolveTileMode", () => {
	it("honours an explicit request in both directions", () => {
		expect(resolveTileMode({ TILE_MODE: "glyph" }).mode).toBe("glyph");
		expect(resolveTileMode({ TILE_MODE: "kitty" }).mode).toBe("kitty");
	});

	it("falls back to glyphs for anything it cannot prove", () => {
		expect(resolveTileMode({ TILE_MODE: "sixel" }).mode).toBe("glyph");
		expect(resolveTileMode({ TMUX: "/tmp/x", TERM_PROGRAM: "ghostty" }).mode).toBe("glyph");
		expect(resolveTileMode({}).mode).toBe("glyph");
	});

	it("says why, so a bug report can include it", () => {
		expect(resolveTileMode({ TILE_MODE: "sixel" }).because).toContain("sixel");
		expect(resolveTileMode({ TMUX: "/tmp/x" }).because).toContain("multiplexer");
	});
});
