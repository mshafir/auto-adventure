/**
 * Every glyph the renderer emits must occupy exactly one terminal column.
 * A single double-width glyph shifts the whole rest of its row relative to the
 * rows above and below, which is what made the old tileset's `⚘` (U+2698) tear
 * the map apart.
 *
 * U+2698 is *not* East-Asian Wide — it is `EAW=Neutral`. It renders double-wide
 * because it lives in Miscellaneous Symbols, a block where terminals and fonts
 * routinely apply emoji presentation. So a width check alone is not enough:
 * whether a code point is drawn as an emoji depends on the font, and a glyph
 * that measures 1 here can measure 2 on the player's machine.
 *
 * The rule is therefore an allowlist of blocks known to be safe in monospace
 * terminals, plus a denylist of blocks known to attract emoji presentation.
 */

export interface CodepointRange {
	readonly start: number;
	readonly end: number;
	readonly name: string;
}

/** Blocks whose members are drawn single-width in every terminal we target. */
export const ALLOWED_RANGES: readonly CodepointRange[] = [
	{ start: 0x20, end: 0x7e, name: "ASCII printable" },
	{ start: 0x00a1, end: 0x00ff, name: "Latin-1 punctuation and letters" },
	{ start: 0x2010, end: 0x205e, name: "General Punctuation" },
	{ start: 0x2190, end: 0x21ff, name: "Arrows" },
	{ start: 0x2200, end: 0x22ff, name: "Mathematical Operators" },
	{ start: 0x2500, end: 0x257f, name: "Box Drawing" },
	{ start: 0x2580, end: 0x259f, name: "Block Elements" },
	{ start: 0x25a0, end: 0x25ff, name: "Geometric Shapes" },
];

/**
 * Blocks that are banned outright even where they overlap an allowed range.
 * These attract emoji presentation, a `FE0F` variation selector, or both.
 */
export const BANNED_RANGES: readonly CodepointRange[] = [
	{ start: 0x2600, end: 0x26ff, name: "Miscellaneous Symbols" },
	{ start: 0x2700, end: 0x27bf, name: "Dingbats" },
	{ start: 0x2b00, end: 0x2bff, name: "Miscellaneous Symbols and Arrows" },
	{ start: 0x1f000, end: 0x1ffff, name: "Symbols and Pictographs" },
	{ start: 0xfe00, end: 0xfe0f, name: "Variation Selectors" },
];

/**
 * Individual code points inside otherwise-allowed blocks that carry a default
 * or commonly-applied emoji presentation.
 */
export const BANNED_CODEPOINTS: ReadonlySet<number> = new Set([
	0x203c, // ‼ double exclamation
	0x2049, // ⁉ exclamation question
	0x2122, // ™
	0x2139, // ℹ
	0x2194,
	0x2195,
	0x2196,
	0x2197,
	0x2198,
	0x2199, // ↔↕↖↗↘↙ emoji-presenting arrows
	0x21a9,
	0x21aa, // ↩↪
	0x25aa,
	0x25ab, // ▪▫ small squares carry FE0F emoji forms
	0x25b6,
	0x25c0, // ▶◀ emoji-presenting triangles
	0x25fb,
	0x25fc,
	0x25fd,
	0x25fe, // ◻◼◽◾
]);

function inRanges(cp: number, ranges: readonly CodepointRange[]): CodepointRange | undefined {
	return ranges.find((r) => cp >= r.start && cp <= r.end);
}

export type GlyphRejection =
	| { readonly ok: false; readonly reason: "empty" }
	| { readonly ok: false; readonly reason: "multiple-codepoints"; readonly count: number }
	| { readonly ok: false; readonly reason: "banned-block"; readonly block: string }
	| { readonly ok: false; readonly reason: "banned-codepoint" }
	| { readonly ok: false; readonly reason: "not-allowlisted" };

export type GlyphCheck = { readonly ok: true } | GlyphRejection;

/** Validate a single glyph. Used by the registry at load time and by tests. */
export function checkGlyph(ch: string): GlyphCheck {
	const points = [...ch];
	if (points.length === 0) return { ok: false, reason: "empty" };
	if (points.length > 1) {
		return { ok: false, reason: "multiple-codepoints", count: points.length };
	}
	const cp = ch.codePointAt(0);
	if (cp === undefined) return { ok: false, reason: "empty" };

	const banned = inRanges(cp, BANNED_RANGES);
	if (banned) return { ok: false, reason: "banned-block", block: banned.name };
	if (BANNED_CODEPOINTS.has(cp)) return { ok: false, reason: "banned-codepoint" };
	if (!inRanges(cp, ALLOWED_RANGES)) return { ok: false, reason: "not-allowlisted" };

	return { ok: true };
}

export function describeRejection(ch: string, check: GlyphRejection): string {
	const cp = ch.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0") ?? "????";
	switch (check.reason) {
		case "empty":
			return "glyph is empty";
		case "multiple-codepoints":
			return `glyph "${ch}" is ${check.count} code points; glyphs must be exactly one`;
		case "banned-block":
			return `glyph "${ch}" (U+${cp}) is in ${check.block}, which terminals commonly render double-width as emoji`;
		case "banned-codepoint":
			return `glyph "${ch}" (U+${cp}) has a common emoji presentation and may render double-width`;
		case "not-allowlisted":
			return `glyph "${ch}" (U+${cp}) is outside the allowed blocks; add its block to ALLOWED_RANGES only if it is single-width everywhere`;
	}
}

/** Throws on the first unsafe glyph. Call once per registry, at module load. */
export function assertSafeGlyphs(glyphs: Iterable<string>, context: string): void {
	for (const ch of glyphs) {
		const check = checkGlyph(ch);
		if (!check.ok) {
			throw new Error(`${context}: ${describeRejection(ch, check)}`);
		}
	}
}
