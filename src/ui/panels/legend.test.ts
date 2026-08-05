import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { D } from "../../core/tiles/decor.js";
import { T } from "../../core/tiles/terrain.js";
import { rgb, toHex } from "../render/color.js";
import { checkGlyph } from "../render/glyph-safety.js";
import { PAL } from "../render/palette.js";
import { inkAt, paintFor } from "../render/sprite.js";
import { mapLegend } from "./legend.js";

/** The thing itself, without the shape phrase the pixel key appends. */
const named = (label: string) => label.split(" — ")[0] ?? label;

describe("the map key", () => {
	it("shows the glyph renderer's own characters", () => {
		const chars = mapLegend("glyph").map((entry) => entry.ch);
		expect(new Set(chars).size).toBeGreaterThan(3);
		expect(chars).toContain("A");
	});

	/*
	 * The bug this exists for. Every entry came out of the glyph registry whichever
	 * renderer was drawing, so a player looking at cones, waves and blobs was handed
	 * a list of `♠ ▒ ~` for trees, water and hedge.
	 */
	it("shows no characters at all in pixel mode, because there are none on the map", () => {
		const chars = new Set(mapLegend("kitty").map((entry) => entry.ch));
		expect(chars.size).toBe(1);
		expect([...chars][0]).toBe("█");
	});

	/*
	 * Read out of the same registry the renderer draws from, in both modes. That is
	 * what stops a key describing a colour the game stopped using — and it is why the
	 * pixel key is a translation of the glyph one rather than a second list to keep
	 * in step by hand.
	 */
	it("takes a thing's colour from the same place in either mode", () => {
		const glyph = new Map(mapLegend("glyph").map((entry) => [entry.label, entry.color]));
		const shared = mapLegend("kitty").filter((entry) => glyph.has(named(entry.label)));
		for (const entry of shared) {
			expect(entry.color, entry.label).toBe(glyph.get(named(entry.label)));
		}
		// And the shared things are most of the list, or the check above proves little.
		expect(shared.length).toBeGreaterThanOrEqual(9);
	});

	/*
	 * Why the pixel key says what shape a thing is drawn as, rather than leaving the
	 * swatch to speak for itself: a door and a chest are the same amber, so a key of
	 * pure colour would carry two rows nobody could tell apart.
	 */
	it("says what each thing is drawn as, since colours are not all distinct", () => {
		const entries = mapLegend("kitty");
		const byColour = new Map<string, number>();
		for (const entry of entries) byColour.set(entry.color, (byColour.get(entry.color) ?? 0) + 1);
		expect(
			[...byColour.values()].some((n) => n > 1),
			"no two entries share a colour",
		).toBe(true);

		for (const entry of entries) {
			if (entry.label.startsWith("folk,")) continue;
			expect(entry.label, `${entry.label} says nothing about its shape`).toContain(" — ");
		}
	});

	/*
	 * Identity does not survive the move to sprites — everyone is the same figure at
	 * tile size, because a letter is not legible in forty pixels — but disposition
	 * does, as colour. So the pixel key states what the glyph key never had to.
	 */
	it("names the four shades of person, which is all pixel mode can tell apart", () => {
		const folk = mapLegend("kitty").filter((entry) => entry.label.startsWith("folk"));
		expect(folk).toHaveLength(4);
		expect(folk.map((entry) => entry.color)).toEqual([
			toHex(PAL.friendly),
			toHex(PAL.neutral),
			toHex(PAL.wary),
			toHex(PAL.hostile),
		]);
	});

	it("puts you first in both, since that is the one thing worth finding fast", () => {
		expect(mapLegend("glyph")[0]?.label).toBe("you");
		expect(mapLegend("kitty")[0]?.label).toContain("you");
		expect(mapLegend("kitty")[0]?.color).toBe(toHex(PAL.player));
	});

	/*
	 * The key is text in a bordered frame, so a double-width character here shifts
	 * the border on that row and nothing else. Same rule as the map, same check.
	 */
	it("uses only characters that occupy exactly one column", () => {
		for (const mode of ["glyph", "kitty"] as const) {
			for (const entry of mapLegend(mode)) {
				expect(checkGlyph(entry.ch), `${mode}: ${entry.ch}`).toEqual({ ok: true });
				expect(stringWidth(entry.ch), `${mode}: ${entry.ch}`).toBe(1);
			}
		}
	});

	/*
	 * The shape phrases are written down rather than derived — a `Shape` is a
	 * predicate over the unit square and there is no honest way to reduce one to a
	 * word — so this checks the one part of the claim that *is* derivable: whether
	 * there is a shape there at all.
	 *
	 * A wall is a density sprite. It folds its shade into the ground colour and draws
	 * nothing, which is why its entry says "a solid fill" and not an outline. If the
	 * sprite table ever changes which of these are drawn and which are filled, the
	 * phrases stop being true and this says so.
	 */
	it("only calls a thing a solid fill when its sprite really draws nothing", () => {
		const white = rgb("#ffffff");
		const black = rgb("#000000");
		const inked = (spec: { ch: string; terrain?: number; decor?: number }) => {
			const paint = paintFor({ ...spec, fg: white, bg: black });
			for (let y = 0; y < 16; y++) {
				for (let x = 0; x < 16; x++) if (inkAt(paint.shape, x, y, 16)) return true;
			}
			return false;
		};

		expect(inked({ ch: "█", terrain: T.stoneWall }), "a wall now draws a shape").toBe(false);
		for (const [label, spec] of [
			["door", { ch: "+", terrain: T.doorClosed }],
			["chest", { ch: "▣", decor: D.chest }],
			["trees", { ch: "▲", terrain: T.conifer }],
			["water", { ch: "≈", terrain: T.water }],
		] as const) {
			expect(inked(spec), `${label} draws nothing but its key describes a shape`).toBe(true);
		}
	});

	it("gives every entry a colour the renderer could actually produce", () => {
		for (const mode of ["glyph", "kitty"] as const) {
			for (const entry of mapLegend(mode)) {
				expect(entry.color, `${mode}: ${entry.label}`).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});
});
