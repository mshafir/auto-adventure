/**
 * A 4x4 pixel sprite per glyph, for the quadrant renderer.
 *
 * The key economy here is that a sprite is a *bitmask*, not a bitmap. It says
 * which of a tile's 16 pixels are "ink" and which are "ground"; the two colours
 * come from the `Cell` the compositor already produced. So every sprite
 * inherits lighting, tint, relief, shadow and field-of-view for free, because
 * all of those have already been folded into `cell.fg` / `cell.bg` by the time
 * we get here.
 *
 * It also means a tile is two-coloured by construction, which is what makes the
 * quadrant encoder lossless — see `quadrant.ts`. A general RGB bitmap would put
 * up to four colours in a 2x2 cell and force a quantisation step that this
 * design does not need at all.
 *
 * Sprites are addressed by offset *within* a tile, never by world position, so
 * a tile draws the same wherever the camera happens to be. That is worth saying
 * because `scale.ts` has to work for the same property: it scatters specks by
 * absolute position, and keying that to a viewport index instead makes the whole
 * ground shimmer on every footfall. Here it falls out of the design.
 */
import { AUTOTILE_SETS } from "./autotile.js";
import { mix, type RGB } from "./color.js";

/** Pixels along one edge of a tile. Must be even: the quadrant encoder pairs them. */
export const TILE_PX = 4;

/** 16 bits, bit `y * 4 + x`, set meaning "draw the foreground colour". */
export interface MaskSprite {
	readonly kind: "mask";
	readonly mask: number;
}

export type Sprite =
	| MaskSprite
	/**
	 * A shade between the tile's two colours, 0 = all background, 1 = all ink.
	 *
	 * Blended flat rather than dithered, and that is the single most important
	 * decision in this file. A `░` glyph at one-glyph-per-tile reads as a
	 * uniform 25% tint; the *same* glyph rasterised as a 25% ordered dither is
	 * four separate visible dots, and a field of grass becomes static. Rendered
	 * out, it put back exactly the high-frequency noise that `compose.ts`
	 * records the generator being changed to avoid — a whole viewport of it.
	 *
	 * So sub-tile texture stays sub-tile: it becomes a value, and the visible
	 * texture comes from the authored specks instead. That is the balance
	 * `glyphs.ts` already strikes, where grass is half `░` and half a single
	 * mark — this keeps it rather than amplifying the `░` half fourfold.
	 */
	| { readonly kind: "density"; readonly level: number };

/**
 * Read a 4x4 sprite from four strings, `#` for ink.
 *
 * Literal art rather than computed masks because these are *shapes* and the
 * whole point is being able to see them in the source.
 */
function art(...rows: readonly [string, string, string, string]): MaskSprite {
	let mask = 0;
	rows.forEach((row, y) => {
		for (let x = 0; x < TILE_PX; x++) {
			if (row[x] === "#") mask |= 1 << (y * TILE_PX + x);
		}
	});
	return { kind: "mask", mask };
}

function density(level: number): Sprite {
	return { kind: "density", level };
}

/**
 * Which pixel tracks a line occupies, by weight.
 *
 * A 4-pixel tile cannot centre an odd-width line, so `light` sits one pixel off
 * centre. At this resolution that is invisible next to the thing it buys, which
 * is that light, heavy and double walls stay visibly different weights.
 */
const TRACKS: Readonly<Record<string, readonly number[]>> = {
	light: [1],
	heavy: [1, 2],
	// Two rails with a gap. Anchored at 0 so the rails meet across tile edges
	// and a bridge reads as one continuous span rather than a dashed line.
	double: [0, 2],
};

/**
 * Build a box-drawing sprite from its arm directions.
 *
 * Arms run from the tile edge to the centre band, so a glyph's arms always
 * reach its neighbours' and walls join without a seam.
 */
function boxSprite(mask: number, weight: string): MaskSprite {
	const tracks = TRACKS[weight] ?? TRACKS.heavy;
	if (!tracks) throw new Error(`unknown box weight ${weight}`);
	const lo = Math.min(...tracks);
	const hi = Math.max(...tracks);
	let bits = 0;
	const set = (x: number, y: number) => {
		bits |= 1 << (y * TILE_PX + x);
	};

	// The centre band is always drawn, so a glyph with no arms is a pillar or a
	// post rather than an empty tile.
	for (const y of tracks) for (const x of tracks) set(x, y);

	if (mask & 1) for (let y = 0; y <= hi; y++) for (const x of tracks) set(x, y); // N
	if (mask & 2) for (let x = lo; x < TILE_PX; x++) for (const y of tracks) set(x, y); // E
	if (mask & 4) for (let y = lo; y < TILE_PX; y++) for (const x of tracks) set(x, y); // S
	if (mask & 8) for (let x = 0; x <= hi; x++) for (const y of tracks) set(x, y); // W

	return { kind: "mask", mask: bits };
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
 * Deriving rather than listing 48 glyphs by hand keeps the two in step: an
 * autotile table that gains a glyph gains its sprite in the same commit, and a
 * table reordered by mistake produces visibly wrong walls in both renderers
 * rather than only in one.
 */
function derivedBoxSprites(): Map<string, Sprite> {
	const out = new Map<string, Sprite>();
	for (const set of AUTOTILE_SETS) {
		const weight = SET_WEIGHT[set.key];
		if (!weight) continue;
		set.table.forEach((ch, mask) => {
			const existing = out.get(ch);
			const sprite = boxSprite(mask, weight);
			// Two sets sharing a glyph would silently give one of them the other's
			// shape, so say so instead.
			if (existing && existing.kind === "mask" && existing.mask !== sprite.mask) {
				throw new Error(`glyph "${ch}" is claimed by two autotile sets with different shapes`);
			}
			out.set(ch, sprite);
		});
	}
	return out;
}

/**
 * Everything that walks, drawn as a head and shoulders.
 *
 * NPC glyphs are letters (`npc-directory.ts` uppercases the role's initial), and
 * a letter is simply not legible in sixteen pixels. So the entity layer stops
 * being typographic here: a person is a person-shape, and *which* person is
 * carried by the colour, which `dispositionColor` already varies.
 *
 * The cost is real and worth stating: the glyph renderer distinguishes a
 * merchant from a guard at a glance and this does not. Disposition survives,
 * identity does not — so pixel mode leans harder on the side panel to say who
 * is on screen.
 */
const ENTITY: MaskSprite = art(".##.", "####", ".##.", ".##.");

/**
 * Hand-authored sprites, for everything that is not a box-drawing line.
 *
 * Density glyphs map to a coverage fraction rather than a fixed pattern; the
 * rest are drawn. Specks stay deliberately sparse — one or two pixels — because
 * a speck's job is to break up a flat colour, and at 16 pixels a tile it takes
 * very little to read as texture.
 */
const AUTHORED: Readonly<Record<string, Sprite>> = {
	" ": { kind: "mask", mask: 0 },
	// The player is always drawn through the entity path, but map it anyway so
	// no glyph the registry can emit depends on the fallback.
	"@": ENTITY,

	// --- density fills -----------------------------------------------------
	"░": density(0.25),
	"▒": density(0.5),
	"▓": density(0.75),
	"█": density(1),

	// --- water -------------------------------------------------------------
	"~": art("....", "##..", "..##", "...."),
	"≈": art("##..", "..##", "##..", "..##"),

	// --- scenery -----------------------------------------------------------
	"▲": art("..#.", ".###", "####", "..#."),
	"●": art(".##.", "####", "####", ".##."),
	"†": art("..#.", ".###", "..#.", "..#."),
	o: art("....", ".##.", ".##.", "...."),

	// --- ground specks -----------------------------------------------------
	",": art("....", "....", ".#..", "...."),
	".": art("....", "....", "..#.", "...."),
	"'": art("....", ".#..", "....", "...."),
	":": art("....", ".#..", ".#..", "...."),
	"·": art("....", "..#.", "....", "...."),
	"*": art("....", ".#..", "...#", "...."),
	'"': art("....", "#.#.", "....", "...."),
	"!": art(".#..", ".#..", "....", "...."),
	"|": art(".#..", ".#..", ".#..", ".#.."),
	"=": art("....", "###.", "....", "###."),
	"-": art("....", "###.", "....", "...."),
	"≡": art("###.", "....", "###.", "...."),

	// --- built -------------------------------------------------------------
	"▤": art("####", "#.#.", "####", "#.#."),
	"▨": art("#..#", ".##.", ".##.", "#..#"),
	"▣": art("####", "#..#", "#..#", "####"),
	"▩": art("#.#.", ".#.#", "#.#.", ".#.#"),
	"▢": art("####", "#..#", "#..#", "####"),
	"▭": art("....", "####", "####", "...."),
	"▬": art("####", "....", "####", "...."),
	"≣": art("####", "....", "####", "...."),
	"◍": art(".##.", "####", "####", ".##."),
	// The anvil. Its glyph happens to be a quadrant block, which is only a
	// coincidence — here it is a horn, a face and a waist.
	"▟": art("..##", ".###", "..#.", ".###"),
	"∩": art(".##.", "#..#", "#..#", "#..#"),
	"⊓": art("####", ".#.#", ".#.#", "...."),
	"╤": art("####", "..#.", "..#.", "..#."),
	"╪": art("..#.", "####", "..#.", "..#."),
	"╫": art(".#.#", "####", ".#.#", ".#.#"),
	"§": art(".##.", ".#..", "..#.", ".##."),
	"※": art("#.#.", ".#..", "#.#.", "...."),
	"¡": art("..#.", "....", "..#.", "..#."),
	"+": art("..#.", "####", "..#.", "..#."),
	"/": art("...#", "..#.", ".#..", "#..."),
	">": art(".#..", "..#.", "..#.", ".#.."),
	"<": art("..#.", ".#..", ".#..", "..#."),
	"■": art(".##.", ".##.", ".##.", ".##."),
	"○": art("....", ".#..", ".#..", "...."),
};

const BOX = derivedBoxSprites();

/**
 * Drawn for any glyph with no sprite of its own.
 *
 * A visible lozenge rather than a blank, so a missing sprite shows up on the
 * map instead of quietly erasing whatever it was meant to be. `spriteCoverage`
 * reports which glyphs land here.
 */
const FALLBACK: MaskSprite = art("....", ".##.", ".##.", "....");

export function spriteFor(ch: string): Sprite {
	return AUTHORED[ch] ?? BOX.get(ch) ?? FALLBACK;
}

export function hasSprite(ch: string): boolean {
	return AUTHORED[ch] !== undefined || BOX.has(ch);
}

/**
 * One tile ready to rasterise: a bitmask and the two colours it is painted in.
 *
 * Resolving to exactly two colours is what makes the quadrant encoder lossless
 * — a cell is two pixels square and so never straddles a tile, which means it
 * never sees a third colour and never needs to quantise. A density sprite folds
 * its shade into the background and clears the mask, so it is a *one*-colour
 * tile and cheaper still.
 */
export interface TilePaint {
	readonly mask: number;
	readonly fg: RGB;
	readonly bg: RGB;
}

export function paintFor(ch: string, fg: RGB, bg: RGB, entity = false): TilePaint {
	if (entity) return { mask: ENTITY.mask, fg, bg };
	const sprite = spriteFor(ch);
	if (sprite.kind === "density") {
		return { mask: 0, fg, bg: mix(bg, fg, sprite.level) };
	}
	return { mask: sprite.mask, fg, bg };
}

/**
 * Is this world pixel ink?
 *
 * `px`/`py` are **world** pixel coordinates. Only the low two bits are read,
 * which is the within-tile offset for any tile origin (a multiple of 4) and
 * works unchanged for negative coordinates — so a sprite is anchored to the
 * ground rather than to the viewport, and does not slide as the camera moves.
 */
export function inkAt(mask: number, px: number, py: number): boolean {
	const x = px & (TILE_PX - 1);
	const y = py & (TILE_PX - 1);
	return (mask & (1 << (y * TILE_PX + x))) !== 0;
}

/** Which glyphs have a sprite and which fall back. For tests and the preview tool. */
export function spriteCoverage(glyphs: Iterable<string>): {
	covered: string[];
	missing: string[];
} {
	const covered = new Set<string>();
	const missing = new Set<string>();
	for (const ch of glyphs) (hasSprite(ch) ? covered : missing).add(ch);
	return { covered: [...covered].sort(), missing: [...missing].sort() };
}
