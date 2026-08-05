/**
 * How one tile is drawn, at whatever pixel size the renderer is working in.
 *
 * Sprites are **procedures, not bitmaps**. A tile is drawn by asking, for a
 * point in the unit square, whether that point is ink — so the same conifer is
 * a crisp triangle at 8 pixels and at 24, and changing the tile size is a
 * number rather than a re-draw of sixty sprites. Upscaling a fixed 4x4 mask to
 * 16x16 would just be a blocky 4x4, which is the whole reason the earlier
 * quadrant experiment was not worth keeping.
 *
 * Colour is not a sprite's business. A sprite answers ink or ground, and the
 * two colours come from the `Cell` the compositor already produced — so every
 * sprite inherits lighting, tint, relief, shadow and field of view for free,
 * because all of those are folded into `cell.fg` / `cell.bg` upstream.
 *
 * Coordinates are the unit square, `u` and `v` in `[0, 1)`, with `v` running
 * downward. Unit coordinates rather than pixels because that is what makes a
 * sprite resolution-independent; a shape written against pixel indices is a
 * shape that only works at one size.
 */
import { decorDef } from "../../core/tiles/decor.js";
import { terrainDef } from "../../core/tiles/terrain.js";
import { AUTOTILE_SETS } from "./autotile.js";
import { mix, type RGB } from "./color.js";

/**
 * Pixels along one edge of a tile.
 *
 * Sixteen is a real tileset's worth of detail and about what a pair of terminal
 * cells can show without the terminal having to scale the image. `TILE_PX`
 * overrides it for experiments; the sprites do not care.
 */
export const TILE_PX = (() => {
	const raw = Number(process.env.TILE_PX);
	return Number.isFinite(raw) && raw >= 4 ? Math.trunc(raw) : 16;
})();

/** Is the point `(u, v)` of this tile ink? */
export type Shape = (u: number, v: number) => boolean;

export type Sprite =
	| { readonly kind: "shape"; readonly shape: Shape }
	/**
	 * A shade between the tile's two colours, 0 = all ground, 1 = all ink.
	 *
	 * Blended flat rather than dithered, and that decision was expensive to
	 * learn. A `░` glyph reads as a uniform 25% tint at one glyph per tile; the
	 * same glyph rasterised as a 25% ordered dither is a field of separate dots,
	 * and a viewport of grass became visual static — exactly the high-frequency
	 * noise that `compose.ts` records the generator being changed to avoid.
	 *
	 * So sub-tile texture stays sub-tile: it becomes a value, and the visible
	 * texture comes from the drawn specks instead. That is the balance
	 * `glyphs.ts` already strikes, where grass is half `░` and half a mark.
	 */
	| { readonly kind: "density"; readonly level: number };

function shape(fn: Shape): Sprite {
	return { kind: "shape", shape: fn };
}

function density(level: number): Sprite {
	return { kind: "density", level };
}

// --- shape primitives ------------------------------------------------------
// Everything below composes these, so a sprite reads as a description of the
// thing it draws rather than as arithmetic.

/** An axis-aligned box, in unit coordinates. */
const box =
	(x0: number, y0: number, x1: number, y1: number): Shape =>
	(u, v) =>
		u >= x0 && u < x1 && v >= y0 && v < y1;

const disc =
	(cx: number, cy: number, r: number): Shape =>
	(u, v) =>
		(u - cx) ** 2 + (v - cy) ** 2 < r * r;

/** A triangle with its apex at `(cx, apexY)`, widening to `base`. */
const cone =
	(cx: number, apexY: number, base: number, halfWidth: number): Shape =>
	(u, v) => {
		if (v < apexY || v > base) return false;
		const t = (v - apexY) / (base - apexY);
		return Math.abs(u - cx) < halfWidth * t;
	};

const any =
	(...parts: readonly Shape[]): Shape =>
	(u, v) =>
		parts.some((p) => p(u, v));

const not =
	(inner: Shape): Shape =>
	(u, v) =>
		!inner(u, v);

const both =
	(a: Shape, b: Shape): Shape =>
	(u, v) =>
		a(u, v) && b(u, v);

/** A ring: a disc with a smaller one taken out of it. */
const ring = (cx: number, cy: number, r: number, thickness: number): Shape =>
	both(disc(cx, cy, r), not(disc(cx, cy, r - thickness)));

/** A sine band, for water. */
const wave =
	(centre: number, amplitude: number, periods: number, thickness: number): Shape =>
	(u, v) =>
		Math.abs(v - (centre + amplitude * Math.sin(u * Math.PI * 2 * periods))) < thickness;

const NOTHING: Shape = () => false;

// --- box drawing -----------------------------------------------------------

/**
 * How wide a line is drawn, as a fraction of the tile, per weight.
 *
 * These are the three weights the autotile tables already distinguish, and
 * keeping them apart is the point: a fence must not read as a wall.
 */
const WEIGHTS: Readonly<Record<string, number>> = {
	light: 0.14,
	heavy: 0.3,
	double: 0.36,
};

/**
 * Build a box-drawing shape from its arm directions.
 *
 * Arms run from the tile edge to the centre band, so a glyph's arms always meet
 * its neighbours' and a run of wall is unbroken. A double line is drawn as two
 * rails with a gap, which is what tells a bridge from a thick wall.
 */
function boxShape(mask: number, weight: string): Shape {
	const w = WEIGHTS[weight] ?? 0.3;
	const lo = 0.5 - w / 2;
	const hi = 0.5 + w / 2;
	const rail = w / 3;

	// A horizontal arm splits into two rails along v; a vertical one along u.
	const across = (x0: number, x1: number): Shape =>
		weight === "double"
			? any(box(x0, lo, x1, lo + rail), box(x0, hi - rail, x1, hi))
			: box(x0, lo, x1, hi);
	const down = (y0: number, y1: number): Shape =>
		weight === "double"
			? any(box(lo, y0, lo + rail, y1), box(hi - rail, y0, hi, y1))
			: box(lo, y0, hi, y1);

	const parts: Shape[] = [];
	if (mask & 1) parts.push(down(0, hi)); // N
	if (mask & 2) parts.push(across(lo, 1)); // E
	if (mask & 4) parts.push(down(lo, 1)); // S
	if (mask & 8) parts.push(across(0, hi)); // W
	// The centre is always drawn, so a glyph with no arms is a pillar or a post
	// rather than an empty tile.
	if (parts.length === 0) parts.push(box(lo, lo, hi, hi));
	return any(...parts);
}

/** Which line weight each autotile set draws in. Density sets are not box art. */
const SET_WEIGHT: Readonly<Record<string, string>> = {
	heavyWall: "heavy",
	lightFence: "light",
	doubleSpan: "double",
};

/**
 * Derive every box-drawing sprite from the autotile tables themselves.
 *
 * Deriving rather than listing 48 glyphs keeps the two in step: a table that
 * gains a glyph gains its sprite in the same commit, and a table reordered by
 * mistake produces visibly wrong walls in both renderers rather than only one.
 */
function derivedBoxSprites(): Map<string, Sprite> {
	const out = new Map<string, Sprite>();
	for (const set of AUTOTILE_SETS) {
		const weight = SET_WEIGHT[set.key];
		if (!weight) continue;
		set.table.forEach((ch, mask) => {
			if (!out.has(ch)) out.set(ch, shape(boxShape(mask, weight)));
		});
	}
	return out;
}

/**
 * Everything that walks, drawn as a head and shoulders.
 *
 * NPC glyphs are letters — `npc-directory.ts` uppercases the role's initial —
 * and a letter is not legible at tile size. So the entity layer stops being
 * typographic here: a person is a person-shape, and *which* person is carried
 * by the colour, which `dispositionColor` already varies.
 *
 * The cost is worth stating plainly: the glyph renderer tells a merchant from a
 * guard at a glance and this does not. Disposition survives, identity does not,
 * so pixel mode leans harder on the side panel to say who is on screen.
 */
const FIGURE: Shape = any(
	disc(0.5, 0.22, 0.15),
	cone(0.5, 0.36, 0.76, 0.26),
	box(0.36, 0.74, 0.46, 0.96),
	box(0.54, 0.74, 0.64, 0.96),
);

/**
 * Hand-drawn sprites, for everything that is not a box-drawing line.
 *
 * Specks stay deliberately small. A speck's job is to break up a flat colour,
 * not to be identified, and ground texture that reads clearly on its own tile
 * reads as clutter across a whole viewport.
 */
const AUTHORED: Readonly<Record<string, Sprite>> = {
	" ": shape(NOTHING),
	"@": shape(FIGURE),

	// --- density fills -----------------------------------------------------
	"░": density(0.25),
	"▒": density(0.5),
	"▓": density(0.75),
	"█": density(1),

	// --- water -------------------------------------------------------------
	"~": shape(wave(0.5, 0.12, 1, 0.08)),
	"≈": shape(any(wave(0.3, 0.1, 1, 0.07), wave(0.75, 0.1, 1, 0.07))),

	// --- scenery -----------------------------------------------------------
	"▲": shape(any(cone(0.5, 0.06, 0.8, 0.4), box(0.44, 0.76, 0.56, 0.98))),
	// High ground. A bare peak with no trunk, so it does not read as a tree.
	"^": shape(cone(0.5, 0.18, 0.86, 0.44)),
	"●": shape(disc(0.5, 0.55, 0.34)),
	"†": shape(any(box(0.44, 0.1, 0.56, 0.98), box(0.24, 0.28, 0.76, 0.4))),
	o: shape(ring(0.5, 0.6, 0.28, 0.1)),

	// --- ground specks -----------------------------------------------------
	",": shape(disc(0.36, 0.62, 0.1)),
	".": shape(disc(0.56, 0.68, 0.09)),
	"'": shape(disc(0.42, 0.34, 0.09)),
	":": shape(any(disc(0.4, 0.36, 0.08), disc(0.4, 0.66, 0.08))),
	"·": shape(disc(0.5, 0.5, 0.08)),
	"*": shape(any(disc(0.36, 0.4, 0.11), disc(0.66, 0.66, 0.09))),
	'"': shape(any(disc(0.34, 0.32, 0.08), disc(0.6, 0.32, 0.08))),
	"!": shape(box(0.46, 0.2, 0.56, 0.62)),
	"|": shape(box(0.46, 0.05, 0.56, 0.95)),
	"=": shape(any(box(0.15, 0.36, 0.85, 0.46), box(0.15, 0.62, 0.85, 0.72))),
	"-": shape(box(0.15, 0.46, 0.85, 0.56)),
	"≡": shape(
		any(box(0.15, 0.2, 0.85, 0.3), box(0.15, 0.45, 0.85, 0.55), box(0.15, 0.7, 0.85, 0.8)),
	),

	// --- built -------------------------------------------------------------
	"▤": shape(any(box(0.1, 0.12, 0.9, 0.24), box(0.1, 0.44, 0.9, 0.56), box(0.1, 0.76, 0.9, 0.88))),
	"▨": shape(both(box(0.1, 0.1, 0.9, 0.9), (u, v) => Math.abs(u - v) < 0.18)),
	"▣": shape(any(ring(0.5, 0.5, 0.42, 0.1), disc(0.5, 0.5, 0.16))),
	"▩": shape(both(box(0.08, 0.08, 0.92, 0.92), (u, v) => ((u * 4) | 0) % 2 === ((v * 4) | 0) % 2)),
	"▢": shape(ring(0.5, 0.5, 0.42, 0.1)),
	// A smaller hollow square than `▢`, so a village reads as the lesser of the
	// two settlement marks beside a town's `▣`.
	"□": shape(ring(0.5, 0.5, 0.3, 0.1)),
	"▭": shape(box(0.08, 0.34, 0.92, 0.7)),
	"▬": shape(box(0.06, 0.36, 0.94, 0.62)),
	"≣": shape(any(box(0.1, 0.16, 0.9, 0.28), box(0.1, 0.44, 0.9, 0.56), box(0.1, 0.72, 0.9, 0.84))),
	"◍": shape(any(ring(0.5, 0.5, 0.4, 0.1), box(0.12, 0.44, 0.88, 0.56))),
	"∩": shape(
		any(
			both(ring(0.5, 0.5, 0.4, 0.12), box(0, 0, 1, 0.5)),
			box(0.1, 0.5, 0.22, 1),
			box(0.78, 0.5, 0.9, 1),
		),
	),
	"⊓": shape(
		any(box(0.18, 0.24, 0.82, 0.36), box(0.22, 0.36, 0.34, 0.9), box(0.66, 0.36, 0.78, 0.9)),
	),
	"╤": shape(any(box(0.06, 0.18, 0.94, 0.3), box(0.44, 0.3, 0.56, 0.98))),
	"╪": shape(any(box(0.06, 0.34, 0.94, 0.46), box(0.44, 0.05, 0.56, 0.98))),
	"╫": shape(
		any(box(0.06, 0.3, 0.94, 0.42), box(0.3, 0.05, 0.42, 0.98), box(0.58, 0.05, 0.7, 0.98)),
	),
	"§": shape(
		any(
			both(ring(0.5, 0.3, 0.22, 0.09), box(0, 0, 1, 0.34)),
			both(ring(0.5, 0.7, 0.22, 0.09), box(0, 0.66, 1, 1)),
		),
	),
	"※": shape(
		any(
			disc(0.5, 0.5, 0.12),
			disc(0.24, 0.28, 0.08),
			disc(0.76, 0.28, 0.08),
			disc(0.24, 0.74, 0.08),
			disc(0.76, 0.74, 0.08),
		),
	),
	"¡": shape(any(box(0.44, 0.12, 0.56, 0.2), box(0.44, 0.32, 0.56, 0.88))),
	"+": shape(any(box(0.42, 0.12, 0.58, 0.92), box(0.16, 0.4, 0.84, 0.56))),
	"/": shape((u, v) => Math.abs(u - (1 - v)) < 0.13),
	">": shape((u, v) => Math.abs(u - (0.3 + (0.5 - Math.abs(v - 0.5)))) < 0.14),
	"<": shape((u, v) => Math.abs(1 - u - (0.3 + (0.5 - Math.abs(v - 0.5)))) < 0.14),
	"■": shape(box(0.24, 0.16, 0.76, 0.94)),
	"○": shape(ring(0.5, 0.55, 0.24, 0.09)),
	// The anvil. Its glyph is a quadrant block only by coincidence.
	"▟": shape(
		any(box(0.18, 0.3, 0.86, 0.5), box(0.36, 0.5, 0.64, 0.72), box(0.22, 0.72, 0.78, 0.88)),
	),
};

const BOX = derivedBoxSprites();

/**
 * Scattered blobs, for vegetation.
 *
 * `count` clumps at fixed offsets rather than random ones: a sprite is drawn
 * fresh for every tile on every frame, so anything random would boil. Fixed
 * offsets give one tile of foliage that tiles against itself without a seam.
 */
function foliage(count: number, radius: number): Shape {
	const seeds: readonly (readonly [number, number])[] = [
		[0.28, 0.34],
		[0.68, 0.28],
		[0.5, 0.58],
		[0.22, 0.72],
		[0.78, 0.68],
		[0.44, 0.86],
	];
	return any(...seeds.slice(0, count).map(([x, y]) => disc(x, y, radius)));
}

/** Rows of overlapping scallops, for roof shingle and scale-like texture. */
const shingle: Shape = (u, v) => {
	const row = Math.floor(v * 4);
	const offset = row % 2 === 0 ? 0 : 0.5;
	const x = (u + offset) % 0.5;
	// A dark line at the top of each course and a notch between scallops.
	return v * 4 - row < 0.22 || Math.abs(x - 0.25) < 0.06;
};

/**
 * Sprites chosen by what a tile *is* rather than by the glyph it was reduced to.
 *
 * This exists because the glyph vocabulary is ambiguous in ways that only
 * matter once a tile has real pixels. `▒` is both a roof and a bush; drawing
 * both as the same flat 50% shade gives a town full of green squares where the
 * hedges should be. Keyed by `TerrainDef.key` rather than by numeric id so the
 * table survives ids being appended, which the registry explicitly allows.
 *
 * Deliberately a short list. Most terrain is served fine by its glyph, and an
 * entry here is a claim that this particular tile is worth drawing properly.
 */
const BY_TERRAIN: Readonly<Record<string, Sprite>> = {
	// Grass is the commonest tile on the map, so its texture has to survive being
	// seen thousands of times at once: a few thin blades, close in value to the
	// ground. Anything bolder is the dither problem again at a larger scale.
	grass: shape(
		any(box(0.22, 0.52, 0.28, 0.78), box(0.54, 0.4, 0.6, 0.72), box(0.78, 0.6, 0.84, 0.84)),
	),
	forestFloor: shape(any(disc(0.32, 0.44, 0.07), disc(0.7, 0.66, 0.06), disc(0.5, 0.82, 0.05))),
	bush: shape(foliage(4, 0.19)),
	tallGrass: shape(foliage(6, 0.1)),
	reeds: shape(any(box(0.24, 0.2, 0.32, 1), box(0.48, 0.1, 0.56, 1), box(0.7, 0.3, 0.78, 1))),
	crops: shape(any(box(0.2, 0.3, 0.3, 1), box(0.45, 0.22, 0.55, 1), box(0.7, 0.3, 0.8, 1))),
	roof: shape(shingle),
	broadleaf: shape(foliage(5, 0.22)),
	conifer: shape(any(cone(0.5, 0.06, 0.8, 0.4), box(0.44, 0.76, 0.56, 0.98))),
	rubble: shape(any(disc(0.3, 0.4, 0.13), disc(0.66, 0.6, 0.11), disc(0.44, 0.76, 0.09))),
	gravel: shape(any(disc(0.3, 0.4, 0.07), disc(0.68, 0.62, 0.06))),
	flowers: shape(any(disc(0.34, 0.38, 0.11), disc(0.66, 0.64, 0.09))),
	ice: shape((u, v) => Math.abs(u * 0.6 + v - 0.7) < 0.05),
};

const BY_DECOR: Readonly<Record<string, Sprite>> = {
	bed: shape(any(box(0.1, 0.28, 0.9, 0.92), box(0.16, 0.34, 0.5, 0.54))),
	barrel: shape(
		any(ring(0.5, 0.5, 0.36, 0.09), box(0.16, 0.34, 0.84, 0.42), box(0.16, 0.6, 0.84, 0.68)),
	),
	hearth: shape(any(box(0.1, 0.2, 0.9, 0.32), cone(0.5, 0.44, 0.9, 0.3))),
	campfire: shape(any(cone(0.5, 0.24, 0.82, 0.28), box(0.16, 0.82, 0.84, 0.9))),
	statue: shape(
		any(disc(0.5, 0.24, 0.14), cone(0.5, 0.36, 0.86, 0.26), box(0.24, 0.86, 0.76, 0.96)),
	),
	well: shape(
		any(ring(0.5, 0.62, 0.34, 0.1), box(0.14, 0.16, 0.86, 0.26), box(0.46, 0.16, 0.54, 0.5)),
	),
};

/**
 * Drawn for any glyph with no sprite of its own: a hollow lozenge, visible
 * enough that a missing sprite shows up on the map rather than quietly erasing
 * whatever it was meant to be. `spriteCoverage` reports which glyphs land here.
 */
const FALLBACK: Sprite = shape(ring(0.5, 0.5, 0.3, 0.1));

export function spriteFor(ch: string): Sprite {
	return AUTHORED[ch] ?? BOX.get(ch) ?? FALLBACK;
}

export function hasSprite(ch: string): boolean {
	return AUTHORED[ch] !== undefined || BOX.has(ch);
}

/**
 * One tile ready to rasterise: a shape and the two colours it is drawn in.
 *
 * A density sprite folds its shade into the ground colour and draws nothing, so
 * it costs one flat fill — which is most of the map, most of the time.
 */
export interface TilePaint {
	readonly shape: Shape;
	readonly fg: RGB;
	readonly bg: RGB;
}

/**
 * Resolve one cell to a shape and two colours.
 *
 * Order matters: an entity beats everything, then decor, then terrain, then the
 * glyph. That is the compositor's own layering (`terrain -> decor -> entity`),
 * and following it means a signpost on a road draws the signpost — whereas
 * keying off the glyph alone would draw whichever of the two won the character.
 */
export function paintFor(cell: PaintInput): TilePaint {
	const { fg, bg } = cell;
	if (cell.entity) return { shape: FIGURE, fg, bg };

	const byDecor = cell.decor !== undefined ? BY_DECOR[decorDef(cell.decor).key] : undefined;
	const byTerrain =
		byDecor === undefined && cell.terrain !== undefined
			? BY_TERRAIN[terrainDef(cell.terrain).key]
			: undefined;
	// A decor override only applies where decor is actually present; `none` is
	// id 0 and must not shadow the terrain under it.
	const chosen =
		(cell.decor ? byDecor : undefined) ??
		(cell.decor ? undefined : byTerrain) ??
		spriteFor(cell.ch);

	if (chosen.kind === "density") {
		return { shape: NOTHING, fg, bg: mix(bg, fg, chosen.level) };
	}
	return { shape: chosen.shape, fg, bg };
}

/** What {@link paintFor} needs. A `Cell` satisfies it; tests can pass less. */
export interface PaintInput {
	readonly ch: string;
	readonly fg: RGB;
	readonly bg: RGB;
	readonly entity?: boolean;
	readonly terrain?: number;
	readonly decor?: number;
}

/**
 * Is pixel `(px, py)` of a `size`-pixel tile ink?
 *
 * Sampled at the pixel's centre rather than its corner. A corner sample shifts
 * every shape half a pixel up and to the left, which at this size is visible as
 * a lopsided tree and a wall that meets its neighbour unevenly.
 */
export function inkAt(shape: Shape, px: number, py: number, size = TILE_PX): boolean {
	return shape((px + 0.5) / size, (py + 0.5) / size);
}

/** Which glyphs have a sprite and which fall back. For tests and the tools. */
export function spriteCoverage(glyphs: Iterable<string>): {
	covered: string[];
	missing: string[];
} {
	const covered = new Set<string>();
	const missing = new Set<string>();
	for (const ch of glyphs) (hasSprite(ch) ? covered : missing).add(ch);
	return { covered: [...covered].sort(), missing: [...missing].sort() };
}
