/**
 * The explored world, one cell per chunk, as data.
 *
 * An infinite map needs something that makes the shape of a journey legible; a
 * list of coordinates does not. Only chunks the player has actually walked into
 * are drawn — everything else is blank, so the map fills in as a record of where
 * they have been rather than as a spoiler for where they have not.
 *
 * This is deliberately not a component. The minimap has to appear over the map
 * in both renderers, and Ink cannot lay anything beside a row of kitty
 * placeholders without slicing it (see `ink-astral.test.tsx`), so it is
 * composited into the frame rather than laid out next to it — into the `Cell`
 * grid in glyph mode and into the pixel buffer in kitty mode. Two painters, one
 * source of truth, no React in either path.
 */
import { questChunks } from "../../core/rules/quest-map.js";
import type { GameState } from "../../core/rules/state.js";
import { biomeAt } from "../../core/world/context.js";
import { CHUNK, chunkKey, toChunk } from "../../core/world/coords.js";
import { isSettlement, macroSite } from "../../core/world/macro.js";
import type { RGB } from "./color.js";
import { type Swatch, swatch } from "./swatch.js";

/** One chunk, drawn. */
export interface MiniCell {
	readonly ch: string;
	readonly fg: RGB;
	readonly bold: boolean;
	/**
	 * The glyph shades the whole chunk rather than marking a spot in it.
	 *
	 * Only matters where a chunk is drawn more than one column wide, which it is
	 * in glyph mode — a terminal cell is about twice as tall as it is wide, so one
	 * column per chunk renders the whole minimap squashed 2:1. `scale.ts` makes
	 * the same distinction for the same reason: `▲▲` is two woods where `▲` is
	 * one, but `░░` is the same open ground `░` is, covering twice the area.
	 */
	readonly fill: boolean;
}

/** A themed entry, before its colour is resolved. */
interface Mark {
	readonly ch: string;
	readonly color: Swatch;
	readonly bold?: boolean;
	readonly fill?: boolean;
}

/**
 * What the minimap draws, as a table rather than as code.
 *
 * One character stands for a whole 64-tile chunk, so this is a different
 * alphabet from the map's own and cannot be read out of the tile registry. It is
 * kept declarative and JSON-shaped — plain strings, no imports, no branching —
 * so that it can move into a theme pack beside `assets/content` without being
 * rewritten. Colours name a palette swatch so the minimap stays tied to the map
 * it summarises; a literal `#rrggbb` also works.
 */
const THEME: {
	readonly marks: Readonly<Record<"here" | "errand" | "town" | "village" | "unseen", Mark>>;
	readonly biomes: Readonly<Record<string, Mark>>;
	readonly unknownBiome: Mark;
} = {
	marks: {
		here: { ch: "@", color: "player", bold: true },
		errand: { ch: "!", color: "#e08cd6", bold: true },
		// `▪` would be the obvious village mark and cannot be used: U+25AA carries an
		// emoji presentation, so it renders double-width in some terminals. Harmless
		// in a panel of its own; composited into a map row it shifts every cell after
		// it out of line with the rows above and below.
		town: { ch: "▣", color: "lamplight", bold: true },
		village: { ch: "□", color: "lamplight", bold: true },
		unseen: { ch: " ", color: "ash", fill: true },
	},
	biomes: {
		ocean: { ch: "~", color: "deep", fill: true },
		beach: { ch: ".", color: "sand" },
		marsh: { ch: "~", color: "reed", fill: true },
		grassland: { ch: "░", color: "moss", fill: true },
		meadow: { ch: "░", color: "moss", fill: true },
		shrubland: { ch: "░", color: "mossDark", fill: true },
		forest: { ch: "▲", color: "oak" },
		rainforest: { ch: "▲", color: "leaf" },
		taiga: { ch: "▲", color: "pine" },
		savanna: { ch: "░", color: "wheat", fill: true },
		desert: { ch: ".", color: "sand" },
		badlands: { ch: "░", color: "tile", fill: true },
		moor: { ch: "░", color: "#7a6a8a", fill: true },
		highland: { ch: "^", color: "stone" },
		alpine: { ch: "^", color: "snowShadow" },
		glacier: { ch: "^", color: "ice" },
	},
	unknownBiome: { ch: "░", color: "slate", fill: true },
};

/**
 * Every character the minimap can draw, for the glyph-safety check.
 *
 * Worth checking even though these never reach the tile registry: the minimap is
 * composited into map rows now, so it is held to the same single-width rule as
 * the terrain it is drawn over.
 */
export function minimapGlyphs(): string[] {
	return [
		...Object.values(THEME.marks).map((mark) => mark.ch),
		...Object.values(THEME.biomes).map((mark) => mark.ch),
		THEME.unknownBiome.ch,
	];
}

/** Resolved once: the table is constant, and this runs per chunk per frame. */
const CELLS = new Map<Mark, MiniCell>();

function cellFor(mark: Mark): MiniCell {
	let cell = CELLS.get(mark);
	if (!cell) {
		cell = {
			ch: mark.ch,
			fg: swatch(mark.color),
			bold: mark.bold ?? false,
			fill: mark.fill ?? false,
		};
		CELLS.set(mark, cell);
	}
	return cell;
}

/**
 * Draw the chunks around the player, centred on the one they are standing in.
 *
 * The grid is always odd in both directions — that is what puts the player in
 * the middle rather than half a cell off it — so the result may be one row or
 * column *smaller* than asked for. It is never larger: an overlay that
 * overflowed the frame it is composited into would paint outside the map.
 */
export function minimapCells(state: GameState, width: number, height: number): MiniCell[][] {
	const here = toChunk(state.player.x, state.player.y);
	const seen = new Set(state.discovered);
	const errands = questChunks(state);

	// A row is `2 * half + 1` cells wide, so the half-width has to come off
	// `width - 1`.
	const halfW = Math.max(0, Math.floor((width - 1) / 2));
	const halfH = Math.max(0, Math.floor((height - 1) / 2));

	const rows: MiniCell[][] = [];
	for (let dy = -halfH; dy <= halfH; dy++) {
		const row: MiniCell[] = [];
		for (let dx = -halfW; dx <= halfW; dx++) {
			row.push(cellAt(state, here.cx + dx, here.cy + dy, dx === 0 && dy === 0, seen, errands));
		}
		rows.push(row);
	}
	return rows;
}

function cellAt(
	state: GameState,
	cx: number,
	cy: number,
	isHere: boolean,
	seen: ReadonlySet<string>,
	errands: ReadonlySet<string>,
): MiniCell {
	const { marks } = THEME;
	if (isHere) return cellFor(marks.here);

	const key = chunkKey(cx, cy);
	if (!seen.has(key)) return cellFor(marks.unseen);

	// Drawn over the settlement glyph rather than beside it: which town it is
	// matters less than that something is waiting there.
	if (errands.has(key)) return cellFor(marks.errand);

	const site = macroSite(state.world.seed, cx, cy);
	if (isSettlement(site.kind)) return cellFor(site.kind === "town" ? marks.town : marks.village);

	// Biome is recomputed rather than stored: it is a pure function of the seed
	// and the position, so remembering it would only be a way to get it wrong
	// after a schema change.
	const biome = biomeAt(state.world.seed, cx * CHUNK + CHUNK / 2, cy * CHUNK + CHUNK / 2);
	return cellFor(THEME.biomes[biome] ?? THEME.unknownBiome);
}
