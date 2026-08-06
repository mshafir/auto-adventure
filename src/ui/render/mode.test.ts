import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUERY_IMAGE_ID } from "./kitty.js";
import {
	cellPixels,
	cellPixelsWereMeasured,
	DEFAULT_FRAME_PIXELS,
	graphicsProbe,
	measureCellPixels,
	probePlan,
	probeTerminal,
	renderTilePixels,
	resolveTileMode,
	setCellPixels,
	setGraphicsProbe,
	tilePixels,
} from "./mode.js";
import { tileFit } from "./raster.js";
import { TILE_WIDTH } from "./scale.js";

afterEach(() => {
	setCellPixels(undefined);
	// Module state, so an answer left here would decide the mode for whichever test
	// ran next — including the ones asserting what happens when nobody asked.
	setGraphicsProbe(undefined);
});

/** What Ghostty actually answers, byte for byte: a 19x42 cell in a 1554px area. */
const CELL_REPLY = "\u001B[6;42;19t";
const AREA_REPLY = "\u001B[4;1554;3097t";
/** And what it answers the graphics query with, byte for byte. */
const OK_REPLY = `\u001B_Gi=${QUERY_IMAGE_ID};OK\u001B\\`;
/** A terminal that speaks the protocol but will not do this: still an answer. */
const ERROR_REPLY = `\u001B_Gi=${QUERY_IMAGE_ID};ENOTSUP:no\u001B\\`;

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

	it("adds the graphics query when it is asked for, and nothing else", async () => {
		const { stream, written } = fakeStdout();
		await probeTerminal(fakeStdin(), stream, { timeoutMs: 20 });
		expect(written.join("")).toBe(
			`\u001B[16t\u001B[14t\u001B_Gi=${QUERY_IMAGE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\u001B\\`,
		);
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

	/*
	 * Two queries go out, so two answers come back, and both have to be read.
	 * Returning on the first left the answer to the second sitting in the
	 * terminal's input buffer — and the next thing to read stdin is Ink, which
	 * took it for somebody typing: the tail of the reply printed itself out, and
	 * the rest was routed as keystrokes.
	 */
	it("waits for both answers rather than leaving one for Ink to eat", async () => {
		const { stream } = fakeStdout();
		const stdin = fakeStdin();
		const promise = measureCellPixels(stdin, stream, 500);
		await Promise.resolve();

		stdin.emit("data", Buffer.from(`${CELL_REPLY}`, "latin1"));
		// Still listening: the answer to the second query has not arrived.
		expect(stdin.listenerCount("data")).toBe(1);

		stdin.emit("data", Buffer.from(`${AREA_REPLY}`, "latin1"));
		expect(await promise).toEqual({ width: 19, height: 42 });
		expect(stdin.listenerCount("data")).toBe(0);
	});

	// Two escape sequences, with nothing promising they arrive in one read.
	// Parsing the chunk in hand rather than everything received misses the split.
	it("reads a reply that arrives in pieces", async () => {
		const { stream } = fakeStdout();
		const stdin = fakeStdin();
		const promise = measureCellPixels(stdin, stream, 500);
		await Promise.resolve();

		const whole = `${CELL_REPLY}${AREA_REPLY}`;
		for (const piece of [whole.slice(0, 5), whole.slice(5, 14), whole.slice(14)]) {
			stdin.emit("data", Buffer.from(piece, "latin1"));
		}
		expect(await promise).toEqual({ width: 19, height: 42 });
	});

	/*
	 * The timeout is the only thing holding the event loop open while this waits,
	 * and it used to be unref'd. On the path that matters — after the launcher,
	 * whose own Ink instance leaves stdin unref'd — node found no work left and
	 * exited: the game closed without a word after the menu, having never drawn a
	 * frame and logged nothing to say why.
	 */
	it("keeps the process alive while it waits for an answer", async () => {
		const { stream } = fakeStdout();
		const timers = () =>
			(process.getActiveResourcesInfo?.() ?? []).filter((r) => r === "Timeout").length;
		const before = timers();
		const promise = measureCellPixels(fakeStdin(), stream, 60);
		expect(timers()).toBeGreaterThan(before);
		expect(await promise).toEqual({ width: 8, height: 16 });
	});
});

describe("the graphics probe", () => {
	it("reads an OK as yes", async () => {
		const { stream } = fakeStdout();
		const probe = await probeTerminal(fakeStdin(OK_REPLY), stream, { timeoutMs: 50 });
		expect(probe.graphics).toBe(true);
		expect(graphicsProbe()).toBe(true);
	});

	// A terminal that knows the protocol and is refusing this particular request has
	// answered — but the answer is no, and the pixel renderer must not run on it.
	it("reads an error code as no, not as silence", async () => {
		const { stream } = fakeStdout();
		const probe = await probeTerminal(fakeStdin(ERROR_REPLY), stream, { timeoutMs: 50 });
		expect(probe.graphics).toBe(false);
		expect(graphicsProbe()).toBe(false);
	});

	it("ignores an OK about somebody else's image", async () => {
		// Ids are global to the terminal, so a reply left over from a neighbouring
		// program is a real possibility — and taking it for our own would turn the
		// pixel renderer on for a terminal that never said anything.
		const { stream } = fakeStdout();
		const probe = await probeTerminal(fakeStdin("\u001B_Gi=1;OK\u001B\\"), stream, {
			timeoutMs: 50,
		});
		expect(probe.graphics).toBe(false);
	});

	it("records no answer as no, and never asking as unknown", async () => {
		const { stream } = fakeStdout();
		expect((await probeTerminal(fakeStdin(), stream, { timeoutMs: 20 })).graphics).toBe(false);
		expect(graphicsProbe()).toBe(false);

		setGraphicsProbe(undefined);
		await probeTerminal(fakeStdin(OK_REPLY), stream, { timeoutMs: 20, graphics: false });
		// Asked nothing, so it has no business answering on the terminal's behalf.
		expect(graphicsProbe()).toBeUndefined();
	});

	/*
	 * Three questions now, so three answers, and every one of them has to be read.
	 * The two-query version of this bug shipped: returning early left
	 * `<ESC>[4;1554;3097t` in the terminal's input buffer, Ink took it for somebody
	 * typing, and the shell printed `42;19t;1554;3097t` after the game exited.
	 */
	it("waits for all three answers rather than leaving one for Ink to eat", async () => {
		const { stream } = fakeStdout();
		const stdin = fakeStdin();
		const promise = probeTerminal(stdin, stream, { timeoutMs: 500 });
		await Promise.resolve();

		stdin.emit("data", Buffer.from(CELL_REPLY, "latin1"));
		expect(stdin.listenerCount("data")).toBe(1);
		stdin.emit("data", Buffer.from(AREA_REPLY, "latin1"));
		// Still listening: the graphics query has not been answered.
		expect(stdin.listenerCount("data")).toBe(1);

		stdin.emit("data", Buffer.from(OK_REPLY, "latin1"));
		expect(await promise).toEqual({ cell: { width: 19, height: 42 }, graphics: true });
		expect(stdin.listenerCount("data")).toBe(0);
	});

	it("reads all three when they arrive together, and when they arrive in pieces", async () => {
		const { stream } = fakeStdout();
		const whole = `${CELL_REPLY}${AREA_REPLY}${OK_REPLY}`;

		expect(await probeTerminal(fakeStdin(whole), stream, { timeoutMs: 500 })).toEqual({
			cell: { width: 19, height: 42 },
			graphics: true,
		});

		const stdin = fakeStdin();
		const promise = probeTerminal(stdin, stream, { timeoutMs: 500 });
		await Promise.resolve();
		for (let at = 0; at < whole.length; at += 7) {
			stdin.emit("data", Buffer.from(whole.slice(at, at + 7), "latin1"));
		}
		expect(await promise).toEqual({ cell: { width: 19, height: 42 }, graphics: true });
	});
});

describe("probePlan", () => {
	const stdin = (isTTY: boolean) => ({ isTTY }) as NodeJS.ReadStream;
	const stdout = (isTTY: boolean) => ({ isTTY }) as NodeJS.WriteStream;

	it("asks everything of an ordinary terminal", () => {
		expect(probePlan({}, stdin(true), stdout(true))).toEqual({});
	});

	it("skips the graphics query under a multiplexer but still measures", () => {
		// tmux prints an APC sequence it does not understand rather than eating it, so
		// asking would spray the escape across the screen to learn something the mode
		// resolution ignores anyway. The cell size is still worth having, because
		// TILE_MODE=kitty under tmux is a thing people try.
		expect(probePlan({ TMUX: "/tmp/x" }, stdin(true), stdout(true))).toEqual({ graphics: false });
	});

	/*
	 * Blocked from pixel mode, but still asked. herdr swallows the escape rather
	 * than printing it, so the question is free — and its answer is the diagnosis:
	 * a genuine `OK` from something that then draws nothing is what identified it,
	 * and a tool reporting "not asked" would have hidden the one fact that mattered.
	 */
	it("still asks a multiplexer that swallows escapes quietly", () => {
		expect(probePlan({ HERDR_PANE_ID: "w2:p6" }, stdin(true), stdout(true))).toEqual({});
	});

	it("asks nothing when glyphs are forced or there is nobody to answer", () => {
		expect(probePlan({ TILE_MODE: "glyph" }, stdin(true), stdout(true))).toBeUndefined();
		expect(probePlan({}, stdin(false), stdout(true))).toBeUndefined();
		expect(probePlan({}, stdin(true), stdout(false))).toBeUndefined();
	});
});

describe("tilePixels", () => {
	/*
	 * A tile gets the room the glyph renderer gives it — TILE_WIDTH columns — so
	 * the two show the same field of view. A fixed sixteen pixels is smaller than
	 * a cell on any modern terminal, which is how the pixel map came to show two
	 * and a half times as much world at a third of the size.
	 */
	it("gives a tile the columns the glyph renderer gives it", () => {
		expect(tilePixels({}, { width: 19, height: 42 })).toBe(19 * TILE_WIDTH);
		expect(tilePixels({}, { width: 8, height: 16 })).toBe(8 * TILE_WIDTH);
	});

	it("scales with ZOOM", () => {
		const cell = { width: 19, height: 42 };
		expect(tilePixels({ ZOOM: "2" }, cell)).toBe(19 * TILE_WIDTH * 2);
		expect(tilePixels({ ZOOM: "0.5" }, cell)).toBe(19);
	});

	it("lets TILE_PX pin an exact size, and ignores nonsense", () => {
		const cell = { width: 19, height: 42 };
		expect(tilePixels({ TILE_PX: "24" }, cell)).toBe(24);
		expect(tilePixels({ TILE_PX: "banana" }, cell)).toBe(19 * TILE_WIDTH);
		expect(tilePixels({ ZOOM: "0" }, cell)).toBe(19 * TILE_WIDTH);
		// Below four pixels a sprite is not a picture of anything.
		expect(tilePixels({ ZOOM: "0.01" }, cell)).toBe(4);
	});
});

/**
 * How big a frame is allowed to be, which is not the same question as how big a
 * tile wants to be.
 *
 * A frame is drawn at the map's own screen resolution, so a large window decides
 * its size for us. At 163x70 cells with Ghostty's 19x42 cell that came to eight
 * megapixels — 24MB of raw RGB, sent again on every keypress, inflated and turned
 * into a fresh texture by the terminal each time. Hold a direction key and it is
 * hundreds of megabytes a second, and the terminal died doing it.
 */
describe("renderTilePixels", () => {
	const CELL = { width: 19, height: 42 };
	const frame = (tiles: { width: number; height: number }, px: number) =>
		tiles.width * px * (tiles.height * px);

	it("draws a tile at its full size while the frame is a reasonable one", () => {
		// A 37-row window: 81x32 tiles at 38px is 3.7MP, which is under the budget and
		// is what the game was already doing happily.
		expect(renderTilePixels(81, 32, {}, CELL)).toBe(tilePixels({}, CELL));
	});

	/*
	 * And the case that killed the terminal. Same tile size, twice the rows.
	 */
	it("draws smaller rather than sending an eight-megapixel frame", () => {
		const tiles = { width: 81, height: 68 };
		const wanted = tilePixels({}, CELL);
		expect(frame(tiles, wanted)).toBeGreaterThan(DEFAULT_FRAME_PIXELS);

		const drawn = renderTilePixels(tiles.width, tiles.height, {}, CELL);
		expect(drawn).toBeLessThan(wanted);
		expect(frame(tiles, drawn)).toBeLessThanOrEqual(DEFAULT_FRAME_PIXELS);
	});

	it("keeps any frame inside the budget, at any size of window", () => {
		for (let across = 20; across <= 200; across += 7) {
			for (let down = 10; down <= 120; down += 7) {
				const px = renderTilePixels(across, down, {}, CELL);
				// The floor wins on an absurdly large grid, since a tile below it is not a
				// picture of anything; everything reachable from a real window is capped.
				if (px > 8) {
					expect(
						frame({ width: across, height: down }, px),
						`${across}x${down}`,
					).toBeLessThanOrEqual(DEFAULT_FRAME_PIXELS);
				}
			}
		}
	});

	it("never draws a tile too small to be a picture of anything", () => {
		expect(renderTilePixels(4000, 4000, {}, CELL)).toBe(8);
	});

	it("lets FRAME_PIXELS move the budget in both directions", () => {
		const tiles = { width: 81, height: 68 };
		const tight = renderTilePixels(tiles.width, tiles.height, { FRAME_PIXELS: "1000000" }, CELL);
		const loose = renderTilePixels(tiles.width, tiles.height, { FRAME_PIXELS: "40000000" }, CELL);
		expect(frame(tiles, tight)).toBeLessThanOrEqual(1_000_000);
		// Above the budget the tile is back to the size it wanted, never larger.
		expect(loose).toBe(tilePixels({}, CELL));
	});

	it("ignores a budget that is nonsense or absurdly small", () => {
		const tiles = { width: 81, height: 68 };
		const plain = renderTilePixels(tiles.width, tiles.height, {}, CELL);
		expect(renderTilePixels(tiles.width, tiles.height, { FRAME_PIXELS: "banana" }, CELL)).toBe(
			plain,
		);
		expect(renderTilePixels(tiles.width, tiles.height, { FRAME_PIXELS: "10" }, CELL)).toBe(plain);
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

	describe("once the terminal has been asked", () => {
		// Under vitest stdout is not a terminal, and that check comes first — so
		// without this every case below would resolve to "output is not a terminal"
		// and pass for the wrong reason.
		const wasTTY = process.stdout.isTTY;
		beforeEach(() => {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		});
		afterEach(() => {
			Object.defineProperty(process.stdout, "isTTY", { value: wasTTY, configurable: true });
		});

		/*
		 * The whole point of asking. Ghostty, kitty and WezTerm were on the list;
		 * every other capable terminal got glyphs and no explanation.
		 */
		it("takes the terminal's own answer over the list of known names", () => {
			setGraphicsProbe(true);
			setCellPixels({ width: 19, height: 42 });
			const answered = resolveTileMode({ TERM: "xterm-256color" });
			expect(answered.mode).toBe("kitty");
			expect(answered.because).toContain("answered");
		});

		/*
		 * A yes is necessary and not sufficient, which a blank map in a herdr pane
		 * is what taught. It answered the graphics query with a real `OK` carrying
		 * our own image id, answered neither size query, and drew nothing — it
		 * composites its panes itself, and image cells do not survive that.
		 *
		 * Requiring the cell size is not a lie detector bolted on afterwards: the
		 * camera's size in tiles comes from dividing the map area by the cell, so a
		 * pixel viewport laid out from the assumed 8x16 is the wrong shape and puts
		 * the player off toward an edge. Not knowing it is reason enough on its own.
		 */
		it("wants a cell size as well as a yes, since the camera is laid out from it", () => {
			setGraphicsProbe(true);
			const guessing = resolveTileMode({ TERM: "xterm-256color" });
			expect(guessing.mode).toBe("glyph");
			expect(guessing.because).toContain("cell size");

			// Told rather than measured is still knowing.
			expect(resolveTileMode({ CELL_PX: "19x42" }).mode).toBe("kitty");
			// And a forced mode still overrides the lot.
			expect(resolveTileMode({ TILE_MODE: "kitty" }).mode).toBe("kitty");
		});

		/*
		 * Named, not probed, and the two directions of evidence are different: a
		 * multiplexer sets its own variables, so seeing one means being inside it,
		 * while TERM_PROGRAM is inherited *through* it and proves nothing.
		 */
		it("does not let a herdr pane talk its way into pixels", () => {
			setGraphicsProbe(true);
			setCellPixels({ width: 19, height: 42 });
			const herdr = { HERDR_PANE_ID: "w2:p6", TERM_PROGRAM: "ghostty" };
			expect(resolveTileMode(herdr).mode).toBe("glyph");
			expect(resolveTileMode(herdr).because).toContain("multiplexer");
		});

		/*
		 * And the cost of asking, stated plainly: a terminal on the list that drops
		 * the reply now gets glyphs. `TILE_MODE=kitty` is the way back.
		 */
		it("believes a no from a terminal the list would have said yes to", () => {
			setGraphicsProbe(false);
			expect(resolveTileMode({ TERM_PROGRAM: "ghostty" }).mode).toBe("glyph");
			expect(resolveTileMode({ TERM_PROGRAM: "ghostty", TILE_MODE: "kitty" }).mode).toBe("kitty");
		});

		it("falls back to the list only when nobody asked", () => {
			expect(graphicsProbe()).toBeUndefined();
			const sniffed = resolveTileMode({ TERM_PROGRAM: "ghostty" });
			expect(sniffed.mode).toBe("kitty");
			expect(sniffed.because).toContain("not probed");
		});
	});
});
