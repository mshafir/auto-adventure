import { z } from "zod";
import { AUTOTILE_SETS } from "./autotile.js";
import type { GlyphDraft } from "./glyphs.js";
import { decodePng } from "./png.js";
import type { Shape, Sprite } from "./sprite.js";
import type { TilePackContent } from "./theme.js";

/**
 * A tile pack, as it arrives from disk.
 *
 * ```
 * .packs/tiles/<name>/tiles.json    the manifest below
 * .packs/tiles/<name>/atlas.png     full-colour tiles, one grid cell each
 * ```
 *
 * A directory rather than one file, and the art as a PNG rather than base64 inside
 * JSON, because a full-colour 16×16 atlas of sixty tiles is a quarter of a megabyte
 * and JSON is a bad container for a quarter of a megabyte of pixels. It is also the
 * format art actually arrives in, so a pack can be opened in an image editor.
 *
 * Everything is optional. A pack that supplies only a palette recolours the whole game
 * in eleven lines; a pack that supplies only an atlas keeps the built-in colours and
 * draws its own tiles. The glyph layer is the floor and cannot be skipped in effect —
 * a pack that ships no glyphs simply inherits the built-in ones, because glyph mode is
 * what runs when the terminal cannot do graphics.
 */

const hexColour = z
	.string()
	.regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "expected a hex colour like #4a9a3a");

/** A palette key, or a hex colour written out. */
const colourRef = z.string().min(1).max(40);

/** Autotile sets by their own `key`, so a pack names one the way the code does. */
const AUTOTILE_BY_KEY = new Map(AUTOTILE_SETS.map((set) => [set.key, set]));

const autotileName = z.enum([...AUTOTILE_BY_KEY.keys()] as [string, ...string[]]);

const GlyphDraftSchema = z
	.object({
		ch: z.union([z.string().min(1).max(8), z.array(z.string().min(1).max(8)).min(1).max(16)]),
		fg: colourRef,
		bg: colourRef.optional(),
		bold: z.boolean().optional(),
		dim: z.boolean().optional(),
		/** Named rather than inline: an autotile set is sixteen glyphs and a match rule. */
		autotile: autotileName.optional(),
	})
	.strict();

// --- the shape DSL ----------------------------------------------------------

/**
 * A sprite written as geometry, over the same primitives `sprite.ts` composes.
 *
 * The form to reach for first: it stays resolution-independent, so a pack's conifer is
 * a crisp triangle at eight pixels and at forty-eight, and the tile size stays a number
 * rather than a redraw.
 */
type ShapeNode =
	| { readonly box: readonly [number, number, number, number] }
	| { readonly disc: readonly [number, number, number] }
	| { readonly ring: readonly [number, number, number, number] }
	| { readonly cone: readonly [number, number, number, number] }
	| { readonly wave: readonly [number, number, number, number] }
	| { readonly any: readonly ShapeNode[] }
	| { readonly all: readonly ShapeNode[] }
	| { readonly not: ShapeNode };

const unit = z.number().min(-2).max(3);
const quad = z.tuple([unit, unit, unit, unit]);

const ShapeNodeSchema: z.ZodType<ShapeNode> = z.lazy(() =>
	z.union([
		z.object({ box: quad }).strict(),
		z.object({ disc: z.tuple([unit, unit, unit]) }).strict(),
		z.object({ ring: quad }).strict(),
		z.object({ cone: quad }).strict(),
		z.object({ wave: quad }).strict(),
		z.object({ any: z.array(ShapeNodeSchema).min(1).max(12) }).strict(),
		z.object({ all: z.array(ShapeNodeSchema).min(1).max(12) }).strict(),
		z.object({ not: ShapeNodeSchema }).strict(),
	]),
);

export function compileShape(node: ShapeNode): Shape {
	if ("box" in node) {
		const [x0, y0, x1, y1] = node.box;
		return (u, v) => u >= x0 && u < x1 && v >= y0 && v < y1;
	}
	if ("disc" in node) {
		const [cx, cy, r] = node.disc;
		return (u, v) => (u - cx) ** 2 + (v - cy) ** 2 < r * r;
	}
	if ("ring" in node) {
		const [cx, cy, r, thickness] = node.ring;
		const inner = r - thickness;
		return (u, v) => {
			const d = (u - cx) ** 2 + (v - cy) ** 2;
			return d < r * r && d >= inner * inner;
		};
	}
	if ("cone" in node) {
		const [cx, apexY, base, halfWidth] = node.cone;
		return (u, v) => {
			if (v < apexY || v > base) return false;
			return Math.abs(u - cx) < halfWidth * ((v - apexY) / (base - apexY));
		};
	}
	if ("wave" in node) {
		const [centre, amplitude, periods, thickness] = node.wave;
		return (u, v) =>
			Math.abs(v - (centre + amplitude * Math.sin(u * Math.PI * 2 * periods))) < thickness;
	}
	if ("any" in node) {
		const parts = node.any.map(compileShape);
		return (u, v) => parts.some((part) => part(u, v));
	}
	if ("all" in node) {
		const parts = node.all.map(compileShape);
		return (u, v) => parts.every((part) => part(u, v));
	}
	const inner = compileShape(node.not);
	return (u, v) => !inner(u, v);
}

// --- sprites ----------------------------------------------------------------

const SpriteDraftSchema = z.union([
	z.object({ shape: ShapeNodeSchema }).strict(),
	/** A shade between the tile's two colours: `{ "density": 0.25 }`. */
	z
		.object({ density: z.number().min(0).max(1) })
		.strict(),
	/**
	 * An N×N ink mask, one string per row, `#` for ink and anything else for ground.
	 * Rows must be square and all the same length, which is checked below rather than
	 * left to produce a tile that is subtly sheared.
	 */
	z
		.object({ mask: z.array(z.string().min(1).max(64)).min(1).max(64) })
		.strict()
		.refine((m) => m.mask.every((row) => row.length === m.mask.length), {
			message: "a mask must be square: as many rows as each row has characters",
		}),
	/** A cell of `atlas.png`, as `[column, row]`. */
	z
		.object({ atlas: z.tuple([z.number().int().min(0), z.number().int().min(0)]) })
		.strict(),
]);

export const TilePackSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[a-z0-9][a-z0-9-]*$/, "lower-case letters, digits and dashes only"),
		/** Pixels per side the atlas was drawn at. Required if there is an atlas. */
		tilePx: z.number().int().min(4).max(128).optional(),
		palette: z.record(z.string().min(1).max(40), hexColour).optional(),
		player: z.string().min(1).max(8).optional(),
		glyphs: z
			.object({
				terrain: z.record(z.string(), GlyphDraftSchema).optional(),
				decor: z.record(z.string(), GlyphDraftSchema).optional(),
			})
			.strict()
			.optional(),
		sprites: z
			.object({
				terrain: z.record(z.string(), SpriteDraftSchema).optional(),
				decor: z.record(z.string(), SpriteDraftSchema).optional(),
				glyph: z.record(z.string(), SpriteDraftSchema).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type TilePackManifest = z.infer<typeof TilePackSchema>;
type SpriteDraft = z.infer<typeof SpriteDraftSchema>;

/**
 * Turn a validated manifest and an optional atlas into something the renderer reads.
 *
 * The atlas is sliced here, once, into one `Uint8Array` per referenced cell — rather
 * than kept whole and indexed at draw time — because the rasteriser caches tiles by
 * the *identity* of the pixel array it was handed. One shared slice per atlas cell is
 * what lets that cache work at all.
 */
export function compilePack(
	manifest: TilePackManifest,
	atlas: Uint8Array | undefined,
): TilePackContent {
	const size = manifest.tilePx ?? 16;
	const image = atlas ? decodePng(atlas) : undefined;
	const cells = new Map<string, Uint8Array>();

	const cut = (col: number, row: number): Uint8Array | undefined => {
		if (!image) return undefined;
		const key = `${col},${row}`;
		const found = cells.get(key);
		if (found) return found;
		const x0 = col * size;
		const y0 = row * size;
		if (x0 + size > image.width || y0 + size > image.height) return undefined;
		const out = new Uint8Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			const from = ((y0 + y) * image.width + x0) * 4;
			out.set(image.rgba.subarray(from, from + size * 4), y * size * 4);
		}
		cells.set(key, out);
		return out;
	};

	const compile = (draft: SpriteDraft): Sprite | undefined => {
		if ("shape" in draft) return { kind: "shape", shape: compileShape(draft.shape) };
		if ("density" in draft) return { kind: "density", level: draft.density };
		if ("mask" in draft) {
			const n = draft.mask.length;
			const bits = new Uint8Array(n * n);
			for (let y = 0; y < n; y++) {
				const row = draft.mask[y] as string;
				for (let x = 0; x < n; x++) bits[y * n + x] = row[x] === "#" ? 1 : 0;
			}
			return { kind: "mask", size: n, bits };
		}
		const rgba = cut(draft.atlas[0], draft.atlas[1]);
		// A reference to a cell the atlas does not contain is dropped rather than
		// throwing: the tile falls back to the built-in sprite, which is visible and
		// wrong-looking rather than a game that will not start.
		return rgba ? { kind: "bitmap", size, rgba } : undefined;
	};

	const compileTable = (table: Readonly<Record<string, SpriteDraft>> | undefined) => {
		if (!table) return undefined;
		const out: Record<string, Sprite> = {};
		for (const [key, draft] of Object.entries(table)) {
			const sprite = compile(draft);
			if (sprite) out[key] = sprite;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	};

	const glyphs = {
		...(manifest.glyphs?.terrain ? { terrain: compileGlyphs(manifest.glyphs.terrain) } : {}),
		...(manifest.glyphs?.decor ? { decor: compileGlyphs(manifest.glyphs.decor) } : {}),
	};

	const sprites = {
		...(compileTable(manifest.sprites?.terrain)
			? { terrain: compileTable(manifest.sprites?.terrain) }
			: {}),
		...(compileTable(manifest.sprites?.decor)
			? { decor: compileTable(manifest.sprites?.decor) }
			: {}),
		...(compileTable(manifest.sprites?.glyph)
			? { glyph: compileTable(manifest.sprites?.glyph) }
			: {}),
	};

	return {
		name: manifest.name,
		...(manifest.palette ? { palette: manifest.palette } : {}),
		...(manifest.player ? { player: manifest.player } : {}),
		...(Object.keys(glyphs).length > 0 ? { glyphs } : {}),
		...(Object.keys(sprites).length > 0 ? { sprites } : {}),
	};
}

function compileGlyphs(
	table: Readonly<Record<string, z.infer<typeof GlyphDraftSchema>>>,
): Record<string, GlyphDraft> {
	const out: Record<string, GlyphDraft> = {};
	for (const [key, draft] of Object.entries(table)) {
		out[key] = {
			ch: draft.ch,
			fg: draft.fg,
			...(draft.bg ? { bg: draft.bg } : {}),
			...(draft.bold ? { bold: true } : {}),
			...(draft.dim ? { dim: true } : {}),
			...(draft.autotile ? { autotile: AUTOTILE_BY_KEY.get(draft.autotile) } : {}),
		};
	}
	return out;
}
