import type { DecorId } from "../../core/tiles/decor.js";
import { T, TERRAIN, type TerrainId } from "../../core/tiles/terrain.js";
import { autotileGlyph, neighborMask } from "./autotile.js";
import type { RGB } from "./color.js";
import { decorGlyphSource, type GlyphSource, terrainGlyphSource } from "./glyphs.js";
import { PAL } from "./palette.js";

/** A single resolved terminal cell, ready for {@link encodeRow}. */
export interface Cell {
	ch: string;
	fg: RGB;
	bg: RGB;
	bold: boolean;
	dim: boolean;
	/**
	 * The glyph came from the entity or overlay layer — a person, the player, a
	 * cursor — rather than from terrain.
	 *
	 * Only horizontal scaling cares: static world texture may be placed in either
	 * half of a widened tile to avoid pinstripes, but something that *moves* has
	 * to sit in the same half every frame or it appears to wobble as it walks.
	 */
	entity?: boolean;
	/**
	 * What this cell was drawn from, before it became a glyph.
	 *
	 * The glyph renderer has no use for these, but a pixel renderer does: the
	 * glyph vocabulary is lossy in a way that only shows up once a tile is more
	 * than one character. `▒` is the shingle on a roof *and* a bush, and `░` is
	 * grass, sand, gravel, ice and rubble — distinctions the eye does not need
	 * at one glyph per tile and very much does at sixteen pixels.
	 *
	 * Optional because the compositor is not the only thing that builds cells;
	 * tests and the panels make them by hand, and a sprite layer falls back to
	 * the glyph when the id is absent.
	 */
	terrain?: TerrainId;
	decor?: DecorId;
}

/** Drawn above decor: the player, NPCs, creatures. */
export interface EntityGlyph {
	readonly ch: string;
	readonly fg: RGB;
	readonly bold?: boolean;
}

/** Drawn above everything: cursors, path previews, targeting, damage flashes. */
export interface OverlayGlyph {
	readonly ch?: string;
	readonly fg?: RGB;
	readonly bg?: RGB;
	readonly bold?: boolean;
	readonly dim?: boolean;
}

/**
 * Everything the compositor needs to draw a region, in *world* coordinates.
 *
 * Phase 1 satisfies this from the legacy string map; the chunked world view
 * satisfies it by stitching across chunk boundaries. Because reads are by world
 * coordinate and may run one tile outside the visible rectangle (for autotile
 * neighbours), implementations must answer for any coordinate — returning
 * `T.void` for genuinely absent tiles.
 */
export interface TileSource {
	terrainAt(x: number, y: number): TerrainId;
	decorAt(x: number, y: number): DecorId;
	/** Stable per-position index used to pick between glyph variants. */
	variantAt(x: number, y: number): number;
	/** Quantised height 0..255, or a negative value where it is unknown. */
	elevationAt?(x: number, y: number): number;
	entityAt(x: number, y: number): EntityGlyph | undefined;
	overlayAt?(x: number, y: number): OverlayGlyph | undefined;
}

export interface Camera {
	/** World coordinate drawn at the top-left of the viewport. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface ComposeOptions {
	/** Multiplied into every colour. Drives day/night and interior lighting. */
	readonly tint?: RGB;
	/** 0 = untouched, 1 = fully tinted. */
	readonly tintStrength?: number;
	/**
	 * Per-cell brightness, 0..1. Drives field of view: 0 draws nothing at all,
	 * so a wall the player cannot see round is simply absent rather than dimmed.
	 */
	readonly lightAt?: (x: number, y: number) => number;
	/**
	 * Darken ground lying south or east of anything tall. Cheap contact shadows:
	 * they cost three extra terrain reads per cell and are most of what makes
	 * buildings and treelines sit *on* the map rather than float above it.
	 */
	readonly shadows?: boolean;
	/**
	 * Shade ground by which way its slope faces. Needs `elevationAt` on the
	 * source; without it this is a no-op rather than an error.
	 */
	readonly relief?: boolean;
}

const VOID_BG = PAL.ash;

/**
 * Terrain tall enough to throw a shadow.
 *
 * An explicit list rather than `TFlag.BlocksSight`, which also covers tall
 * grass, reeds and bushes. Those block sight without being *tall*, and outlining
 * every grass patch would put back the high-frequency noise the generator was
 * deliberately changed to avoid. Windows and closed doors are included because
 * they sit in the wall plane, so a wall with a door in it still casts an
 * unbroken shadow.
 */
const SHADOW_CASTER_KEYS: ReadonlySet<string> = new Set([
	"conifer",
	"broadleaf",
	"deadTree",
	"rock",
	"cliff",
	"mountain",
	"stoneWall",
	"woodWall",
	"roof",
	"window",
	"doorClosed",
]);

/** Dense lookup by id, so the render loop never touches a Set or a string. */
const CASTS_SHADOW: readonly boolean[] = TERRAIN.map((def) => SHADOW_CASTER_KEYS.has(def.key));

/**
 * How much a shadowed cell darkens. The sun sits in the north-west, so shadows
 * fall to the south and east; a diagonal-only neighbour casts a softer one,
 * which is what rounds a building's corner instead of stepping it.
 */
const SHADOW_CARDINAL = 0.26;
const SHADOW_DIAGONAL = 0.13;

/**
 * How hard the slope shading bites. A slope facing the sun brightens by up to
 * this fraction and one facing away darkens by it, so flat ground is untouched
 * and the map keeps its authored colours where there is no relief.
 */
const RELIEF_GAIN = 0.34;

/**
 * Height difference across a two-tile span that counts as a full-strength slope.
 *
 * Elevation spans 0..255 across the whole world but one chunk usually covers a
 * small part of that, so shading against the full range would be invisible.
 */
const RELIEF_SPAN = 14;

/** Sun in the north-west, as the horizontal direction its light travels. */
const SUN_X = Math.SQRT1_2;
const SUN_Y = Math.SQRT1_2;

/**
 * Number of shading steps either side of level.
 *
 * Quantising is not a cosmetic choice, it is what makes slope shading affordable.
 * A continuous factor gives almost every cell its own colour: measured over two
 * viewports it took the distinct-style count from 12 to 183, churn from 15% to
 * 62%, and the frame from 22KB to 81KB — worse than before any of this work, and
 * frame size is precisely what is left driving flicker over a slow link. Banding
 * to a few levels lets neighbours on one hillside share a style so the row
 * encoder can collapse them again, and reads as contour shading rather than as
 * noise.
 */
const RELIEF_STEPS = 3;

/**
 * Shade a cell by which way its ground faces.
 *
 * A central-difference gradient dotted with a north-west sun. This is the one
 * trick that makes noise-generated terrain read as landscape rather than as
 * flat colour regions, because it gives the eye the shading cue it uses for
 * shape everywhere else.
 *
 * Returns a multiplier around 1. Neighbours outside the resident chunks fall
 * back to the centre height, which flattens the shading there rather than
 * inventing a cliff at the load frontier.
 */
function reliefAt(source: TileSource, wx: number, wy: number): number {
	const at = source.elevationAt;
	if (!at) return 1;
	const centre = at(wx, wy);
	if (centre < 0) return 1;
	const sample = (x: number, y: number) => {
		const h = at(x, y);
		return h < 0 ? centre : h;
	};

	// Positive means the ground rises toward east / south respectively.
	const dx = sample(wx + 1, wy) - sample(wx - 1, wy);
	const dy = sample(wx, wy + 1) - sample(wx, wy - 1);

	// The normal of a heightfield is (-dh/dx, -dh/dy, 1), so ground rising to
	// the south-east *faces* north-west and catches a north-west sun. Dotting
	// the normal against the light therefore leaves the gradient un-negated.
	const lit = (dx * SUN_X + dy * SUN_Y) / RELIEF_SPAN;
	const banded = Math.round(Math.max(-1, Math.min(1, lit)) * RELIEF_STEPS) / RELIEF_STEPS;
	return 1 + RELIEF_GAIN * banded;
}

function resolve(source: GlyphSource, variant: number, mask: number) {
	switch (source.kind) {
		case "static":
			return source.glyph;
		case "variants": {
			const glyphs = source.glyphs;
			return glyphs[variant % glyphs.length] ?? glyphs[0];
		}
		case "autotile":
			return { ...source.base, ch: autotileGlyph(source.set, mask) };
	}
}

/** Dim a colour towards black, for field-of-view falloff. */
function scaleColor(c: RGB, factor: number): RGB {
	return [Math.round(c[0] * factor), Math.round(c[1] * factor), Math.round(c[2] * factor)];
}

function applyTint(c: RGB, tint: RGB, strength: number): RGB {
	if (strength <= 0) return c;
	return [
		Math.round(c[0] * (1 - strength) + ((c[0] * tint[0]) / 255) * strength),
		Math.round(c[1] * (1 - strength) + ((c[1] * tint[1]) / 255) * strength),
		Math.round(c[2] * (1 - strength) + ((c[2] * tint[2]) / 255) * strength),
	];
}

/**
 * Composite `terrain -> decor -> entity -> overlay` into a grid of cells.
 * The topmost layer that supplies a glyph wins; background is inherited from
 * the topmost layer that declares one, so a signpost keeps the road under it.
 */
export function composeScene(
	source: TileSource,
	camera: Camera,
	options: ComposeOptions = {},
): Cell[][] {
	const { width, height } = camera;
	const tint = options.tint;
	const strength = tint ? (options.tintStrength ?? 1) : 0;
	const shadows = options.shadows ?? false;
	const relief = (options.relief ?? false) && source.elevationAt !== undefined;
	const rows: Cell[][] = new Array(height);

	for (let row = 0; row < height; row++) {
		const wy = camera.y + row;
		const cells: Cell[] = new Array(width);

		for (let col = 0; col < width; col++) {
			const wx = camera.x + col;

			// Unlit is not dim: a tile outside the field of view is not drawn at
			// all, so a corridor reads as a corridor rather than as a dark room.
			const light = options.lightAt?.(wx, wy) ?? 1;
			if (light <= 0) {
				cells[col] = { ch: " ", fg: VOID_BG, bg: VOID_BG, bold: false, dim: false };
				continue;
			}

			const terrain = source.terrainAt(wx, wy);

			let mask = 0;
			const terrainSource = terrainGlyphSource(terrain);
			if (terrainSource.kind === "autotile") {
				mask = neighborMask(
					terrainSource.set,
					terrain,
					source.terrainAt(wx, wy - 1),
					source.terrainAt(wx + 1, wy),
					source.terrainAt(wx, wy + 1),
					source.terrainAt(wx - 1, wy),
				);
			}

			const variant = source.variantAt(wx, wy);
			const base = resolve(terrainSource, variant, mask);
			let ch = base?.ch ?? " ";
			let fg = base?.fg ?? PAL.bone;
			let bg = base?.bg ?? (terrain === T.void ? VOID_BG : PAL.ash);
			let bold = base?.bold ?? false;
			let dim = base?.dim ?? false;

			const decor = source.decorAt(wx, wy);
			if (decor !== 0) {
				const glyph = resolve(decorGlyphSource(decor), variant, 0);
				if (glyph) {
					ch = glyph.ch;
					fg = glyph.fg;
					if (glyph.bg) bg = glyph.bg;
					bold = glyph.bold ?? false;
					dim = glyph.dim ?? false;
				}
			}

			// Ground lighting, applied before entities so that walking across a
			// hillside never changes how bright the player's own glyph is. The
			// background still carries the shading under them, which is what keeps
			// them standing on the terrain rather than in a hole punched through it.
			if (relief || shadows) {
				let factor = relief ? reliefAt(source, wx, wy) : 1;
				if (shadows && !CASTS_SHADOW[terrain]) {
					const cardinal =
						CASTS_SHADOW[source.terrainAt(wx, wy - 1)] ||
						CASTS_SHADOW[source.terrainAt(wx - 1, wy)];
					const drop = cardinal
						? SHADOW_CARDINAL
						: CASTS_SHADOW[source.terrainAt(wx - 1, wy - 1)]
							? SHADOW_DIAGONAL
							: 0;
					factor *= 1 - drop;
				}
				if (factor !== 1) {
					fg = scaleColor(fg, factor);
					bg = scaleColor(bg, factor);
				}
			}

			let moving = false;

			const entity = source.entityAt(wx, wy);
			if (entity) {
				ch = entity.ch;
				fg = entity.fg;
				bold = entity.bold ?? true;
				dim = false;
				moving = true;
			}

			const overlay = source.overlayAt?.(wx, wy);
			if (overlay) {
				if (overlay.ch !== undefined) {
					ch = overlay.ch;
					moving = true;
				}
				if (overlay.fg) fg = overlay.fg;
				if (overlay.bg) bg = overlay.bg;
				if (overlay.bold !== undefined) bold = overlay.bold;
				if (overlay.dim !== undefined) dim = overlay.dim;
			}

			if (tint && strength > 0) {
				fg = applyTint(fg, tint, strength);
				bg = applyTint(bg, tint, strength);
			}
			if (light < 1) {
				fg = scaleColor(fg, light);
				bg = scaleColor(bg, light);
			}

			cells[col] = moving
				? { ch, fg, bg, bold, dim, entity: true, terrain, decor }
				: { ch, fg, bg, bold, dim, terrain, decor };
		}

		rows[row] = cells;
	}

	return rows;
}
