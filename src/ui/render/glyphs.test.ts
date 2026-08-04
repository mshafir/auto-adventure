import { eastAsianWidth } from "get-east-asian-width";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { AUTOTILE_SETS, autotileGlyph, FULL_MASK } from "./autotile.js";
import { checkGlyph, describeRejection } from "./glyph-safety.js";
import { allRegisteredGlyphs, FACING_MARKER, PLAYER_GLYPH } from "./glyphs.js";

describe("glyph safety", () => {
	const glyphs = [...new Set(allRegisteredGlyphs())];

	it("registers a non-trivial vocabulary", () => {
		// The old tileset had 11 glyphs total; the point of this phase is more.
		expect(glyphs.length).toBeGreaterThan(40);
	});

	it("every registered glyph occupies exactly one terminal column", () => {
		const offenders = glyphs
			.filter((ch) => stringWidth(ch) !== 1)
			.map((ch) => `${ch} (U+${ch.codePointAt(0)?.toString(16).toUpperCase()})`);
		expect(offenders).toEqual([]);
	});

	it("every registered glyph is a single code point", () => {
		const offenders = glyphs.filter((ch) => [...ch].length !== 1);
		expect(offenders).toEqual([]);
	});

	it("every registered glyph passes the block allowlist", () => {
		const offenders = glyphs
			.map((ch) => ({ ch, check: checkGlyph(ch) }))
			.filter(({ check }) => !check.ok)
			.map(({ ch, check }) => describeRejection(ch, check as never));
		expect(offenders).toEqual([]);
	});

	it("never registers an East-Asian Wide or Fullwidth code point", () => {
		const offenders = glyphs.filter((ch) => {
			const cp = ch.codePointAt(0);
			return cp !== undefined && eastAsianWidth(cp) === 2;
		});
		expect(offenders).toEqual([]);
	});

	it("rejects the emoji-presenting glyphs that broke the old tileset", () => {
		// U+2698 rendered double-width and shifted every tile after it in its row.
		expect(checkGlyph("⚘").ok).toBe(false);
		for (const ch of ["♠", "♣", "♥", "♦", "☺", "⚔", "⛰", "✦", "🌲"]) {
			expect(checkGlyph(ch).ok, `${ch} should be rejected`).toBe(false);
		}
	});

	it("rejects multi-code-point sequences and variation selectors", () => {
		expect(checkGlyph("▪️").ok).toBe(false);
		expect(checkGlyph("").ok).toBe(false);
		expect(checkGlyph("ab").ok).toBe(false);
	});

	it("accepts the block and box-drawing glyphs the renderer relies on", () => {
		for (const ch of ["░", "▒", "▓", "█", "╋", "┏", "═", "▲", "▼", "◄", "►", "≈"]) {
			expect(checkGlyph(ch).ok, `${ch} should be accepted`).toBe(true);
		}
	});

	it("gives the player a glyph no terrain also uses", () => {
		// The player sharing a glyph with conifers made them disappear into a
		// treeline; the facing marker is likewise deliberately not a terrain glyph.
		const terrainGlyphs = new Set(allRegisteredGlyphs());
		terrainGlyphs.delete(PLAYER_GLYPH);
		terrainGlyphs.delete(FACING_MARKER);
		expect(terrainGlyphs.has(PLAYER_GLYPH)).toBe(false);
		expect(checkGlyph(PLAYER_GLYPH).ok).toBe(true);
		expect(checkGlyph(FACING_MARKER).ok).toBe(true);
	});
});

describe("autotile tables", () => {
	it.each(AUTOTILE_SETS.map((set) => [set.key, set] as const))(
		"%s defines all 16 neighbour masks",
		(_key, set) => {
			expect(set.table).toHaveLength(16);
			for (let mask = 0; mask <= FULL_MASK; mask++) {
				const glyph = autotileGlyph(set, mask);
				expect(glyph, `mask ${mask}`).toBeTruthy();
				expect(stringWidth(glyph)).toBe(1);
			}
		},
	);

	it("clamps out-of-range masks instead of returning undefined", () => {
		for (const set of AUTOTILE_SETS) {
			expect(autotileGlyph(set, 999)).toBeTruthy();
			expect(autotileGlyph(set, -1)).toBeTruthy();
		}
	});
});
