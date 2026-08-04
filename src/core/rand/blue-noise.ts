import { hash3, hash4, mix32 } from "./hash.js";
import { streamId, valueFor } from "./rng.js";

export interface ScatterPoint {
	readonly x: number;
	readonly y: number;
	/** Uniform `[0, 1)` roll for choosing what to place here. */
	readonly roll: number;
}

/**
 * Jittered-grid blue noise: one candidate point per grid cell, offset inside
 * that cell by a hash of the cell coordinate.
 *
 * **Do not replace this with Bridson's algorithm or dart throwing.** Those are
 * sequential — each accepted sample depends on the samples accepted before it,
 * so the result depends on iteration order, and iteration order depends on
 * which chunk is being generated. That silently breaks the order-independence
 * invariant the whole world rests on, and it breaks it in the worst way: the
 * seams appear only where two chunks happen to be generated in a particular
 * order, so it reproduces intermittently.
 *
 * Jittered grid gives up the guaranteed minimum-distance property in exchange
 * for being pointwise pure. Visually the difference is slight; structurally it
 * is the difference between correct and not.
 */
export function scatterPoint(
	seed: number,
	stream: string,
	cellX: number,
	cellY: number,
	cellSize: number,
	jitter = 0.8,
): ScatterPoint {
	const offsetX = valueFor(seed, `${stream}:jx`, cellX, cellY);
	const offsetY = valueFor(seed, `${stream}:jy`, cellX, cellY);
	const roll = valueFor(seed, `${stream}:roll`, cellX, cellY);

	// Centre the jitter box so points stay clear of cell edges, which is what
	// keeps neighbouring points from clumping across a cell boundary.
	const margin = (1 - jitter) * 0.5;
	return {
		x: (cellX + margin + offsetX * jitter) * cellSize,
		y: (cellY + margin + offsetY * jitter) * cellSize,
		roll,
	};
}

/**
 * Every scatter point that could fall within `[x0, x1) x [y0, y1)`.
 *
 * Iterates one cell beyond the rectangle on each side, because a point jittered
 * within its own cell can land inside the rectangle while its cell origin does
 * not. Missing that halo is the classic source of objects that vanish exactly
 * at a chunk boundary.
 */
export function scatterInRect(
	seed: number,
	stream: string,
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	cellSize: number,
	jitter = 0.8,
): ScatterPoint[] {
	const startX = Math.floor(x0 / cellSize) - 1;
	const startY = Math.floor(y0 / cellSize) - 1;
	const endX = Math.floor((x1 - 1) / cellSize) + 1;
	const endY = Math.floor((y1 - 1) / cellSize) + 1;

	const points: ScatterPoint[] = [];
	for (let cy = startY; cy <= endY; cy++) {
		for (let cx = startX; cx <= endX; cx++) {
			const point = scatterPoint(seed, stream, cx, cy, cellSize, jitter);
			const px = Math.floor(point.x);
			const py = Math.floor(point.y);
			if (px >= x0 && px < x1 && py >= y0 && py < y1) {
				points.push({ x: px, y: py, roll: point.roll });
			}
		}
	}
	return points;
}

/**
 * Whether a single tile carries a scatter feature, without materialising the
 * point list. Cheaper than {@link scatterInRect} when the caller is already
 * looping over tiles.
 */
export function scatterAt(
	seed: number,
	stream: string,
	x: number,
	y: number,
	cellSize: number,
	jitter = 0.8,
): ScatterPoint | undefined {
	const cx = Math.floor(x / cellSize);
	const cy = Math.floor(y / cellSize);
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const point = scatterPoint(seed, stream, cx + dx, cy + dy, cellSize, jitter);
			if (Math.floor(point.x) === x && Math.floor(point.y) === y) {
				return { x, y, roll: point.roll };
			}
		}
	}
	return undefined;
}

/** Stable per-tile variant index for glyph texture. */
export function variantAt(seed: number, x: number, y: number): number {
	return hash4(seed, 0x7a11, x, y) & 0xff;
}

/**
 * Rasterise every scatter candidate in a rectangle into a roll grid.
 *
 * `-1` means no candidate landed on that tile; otherwise the value is the
 * candidate's `[0, 1)` roll, which the caller compares against a per-biome
 * density.
 *
 * This exists because the per-tile form has to probe the nine surrounding cells
 * to find out whether any of them jittered onto this tile — nine cells times
 * three hashes for every tile in the chunk. Stamping the candidates once costs
 * one pass over the cells instead, roughly two orders of magnitude less work,
 * and produces exactly the same placements.
 */
export function scatterField(
	seed: number,
	stream: string,
	x0: number,
	y0: number,
	width: number,
	height: number,
	cellSize: number,
	jitter = 0.8,
): Float32Array {
	const field = new Float32Array(width * height).fill(-1);
	const jxStream = streamId(`${stream}:jx`);
	const jyStream = streamId(`${stream}:jy`);
	const rollStream = streamId(`${stream}:roll`);

	const startX = Math.floor(x0 / cellSize) - 1;
	const startY = Math.floor(y0 / cellSize) - 1;
	const endX = Math.floor((x0 + width - 1) / cellSize) + 1;
	const endY = Math.floor((y0 + height - 1) / cellSize) + 1;
	const margin = (1 - jitter) * 0.5;

	for (let cy = startY; cy <= endY; cy++) {
		for (let cx = startX; cx <= endX; cx++) {
			const ox = mix32(hash4(seed, jxStream, cx, cy)) / 4294967296;
			const oy = mix32(hash4(seed, jyStream, cx, cy)) / 4294967296;
			const px = Math.floor((cx + margin + ox * jitter) * cellSize);
			const py = Math.floor((cy + margin + oy * jitter) * cellSize);
			const lx = px - x0;
			const ly = py - y0;
			if (lx < 0 || ly < 0 || lx >= width || ly >= height) continue;
			field[ly * width + lx] = mix32(hash4(seed, rollStream, cx, cy)) / 4294967296;
		}
	}

	return field;
}

/** Pre-resolved-stream variant of the per-tile roll, for hot loops. */
export function rollAt(seed: number, stream: number, x: number, y: number): number {
	return mix32(hash3(seed ^ stream, x, y)) / 4294967296;
}
