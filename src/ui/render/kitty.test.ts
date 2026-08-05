import { describe, expect, it } from "vitest";
import {
	encodeCell,
	encodeRowStart,
	FRAME_IMAGE_ID,
	imageIdSequence,
	MAX_PLACEHOLDER_INDEX,
	PLACEHOLDER,
	placeholderRows,
	transmitFrame,
} from "./kitty.js";

const ESC = "";

function frame(width: number, height: number) {
	return { rgb: Buffer.alloc(width * height * 3), width, height, columns: 4, rows: 2 };
}

describe("placeholderRows", () => {
	// The bug this file exists to prevent. A viewport is around 88 columns and
	// the diacritic table stops at 64, so any scheme that needs a diacritic per
	// column cannot draw a real map — it throws partway across the first row.
	it("encodes a viewport wider than the diacritic table", () => {
		const wide = MAX_PLACEHOLDER_INDEX + 40;
		expect(() => placeholderRows(wide, 30)).not.toThrow();
		expect(placeholderRows(wide, 30)).toHaveLength(30);
	});

	it("anchors each row once and then runs bare", () => {
		const [row] = placeholderRows(4, 1);
		const cells = (row ?? "").split(PLACEHOLDER).length - 1;
		expect(cells).toBe(4);
		// One diacritic in the whole row: the anchor on its first cell.
		expect([...(row ?? "")].filter((ch) => ch >= "̀" && ch <= "ٟ")).toHaveLength(1);
	});

	it("names every cell when asked, for debugging a terminal", () => {
		const [row] = placeholderRows(4, 1, { explicit: true });
		expect([...(row ?? "")].filter((ch) => ch >= "̀" && ch <= "ٟ")).toHaveLength(8);
	});

	it("carries the image id as a foreground colour on every row", () => {
		const rows = placeholderRows(3, 2);
		for (const row of rows) expect(row.startsWith(imageIdSequence())).toBe(true);
		// 0x616476 -> 97;100;118. Read as a number by the terminal, not a colour.
		expect(imageIdSequence(FRAME_IMAGE_ID)).toBe(`${ESC}[38;2;97;100;118m`);
	});

	it("resets at the end of a row so the id cannot bleed into the panels", () => {
		for (const row of placeholderRows(3, 2)) expect(row.endsWith(`${ESC}[0m`)).toBe(true);
	});

	// Rows are bounded by the terminal's height, so this should never fire in
	// practice — but a silent wrap would draw the wrong slice of the image,
	// which is far harder to recognise than a thrown error.
	it("refuses a row index past the table rather than wrapping", () => {
		expect(() => encodeRowStart(MAX_PLACEHOLDER_INDEX)).toThrow(/past the diacritic table/);
		expect(() => encodeCell(0, MAX_PLACEHOLDER_INDEX)).toThrow(/column/);
	});
});

describe("transmitFrame", () => {
	it("wraps the payload in an APC graphics escape", () => {
		const out = transmitFrame(frame(2, 2));
		expect(out.startsWith(`${ESC}_G`)).toBe(true);
		expect(out.endsWith(`${ESC}\\`)).toBe(true);
	});

	it("declares the pixel size, the cell rectangle and a virtual placement", () => {
		const out = transmitFrame(frame(8, 4));
		expect(out).toContain("s=8");
		expect(out).toContain("v=4");
		expect(out).toContain("c=4");
		expect(out).toContain("r=2");
		// U=1 is what makes the image appear via placeholders rather than wherever
		// the cursor happened to be when the escape arrived.
		expect(out).toContain("U=1");
	});

	// Ink reads stdin in raw mode for keys, so an unsolicited acknowledgement
	// would arrive as garbage keystrokes and walk the player somewhere.
	it("asks the terminal to stay silent", () => {
		expect(transmitFrame(frame(2, 2))).toContain("q=2");
	});

	it("splits a large payload into chunks, with control data only on the first", () => {
		// Genuinely incompressible bytes, so the payload really does exceed one
		// chunk. A linear sequence looks random and deflates to almost nothing.
		const big = frame(256, 256);
		let x = 123456789;
		for (let i = 0; i < big.rgb.length; i++) {
			x ^= x << 13;
			x ^= x >>> 17;
			x ^= x << 5;
			big.rgb[i] = x & 0xff;
		}
		const out = transmitFrame(big);
		const escapes = out.split(`${ESC}_G`).length - 1;
		expect(escapes).toBeGreaterThan(1);
		// Every chunk but the last says more is coming; the last says it is done.
		expect(out).toContain("m=1;");
		expect(out.endsWith(`${ESC}\\`)).toBe(true);
		expect(out.split("s=256").length - 1).toBe(1);
	});

	it("compresses the payload", () => {
		// A flat frame is exactly what tile art looks like, and it must not cost
		// three bytes a pixel on the wire.
		const flat = frame(128, 128);
		expect(transmitFrame(flat).length).toBeLessThan(flat.rgb.length / 4);
	});
});
