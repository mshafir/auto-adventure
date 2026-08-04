import { CHUNK, type ChunkCoord } from "../world/coords.js";
import { elevationAt, moistureAt, roughnessAt, temperatureAt } from "../world/fields.js";

/** One tile of margin, so slope and autotile-adjacent logic can look outward. */
export const FIELD_MARGIN = 1;
export const FIELD_SIZE = CHUNK + FIELD_MARGIN * 2;

/**
 * Field samples for a chunk plus a one-tile margin.
 *
 * Sampling once into typed arrays rather than calling the field functions per
 * use is the difference between a playable chunk budget and an unplayable one.
 * `slopeAt` re-derives `elevationAt` for five positions, and `temperatureAt`
 * derives it again, so the naive form evaluates the elevation noise stack
 * roughly seven times for every tile — about 70 noise evaluations per tile
 * before anything else happens.
 *
 * This changes nothing about determinism: the buffer holds exactly the values
 * the pure functions would have returned, just computed once.
 */
export interface FieldBuffer {
	readonly originX: number;
	readonly originY: number;
	readonly elevation: Float32Array;
	readonly moisture: Float32Array;
	readonly temperature: Float32Array;
	readonly roughness: Float32Array;
}

function index(localX: number, localY: number): number {
	return (localY + FIELD_MARGIN) * FIELD_SIZE + (localX + FIELD_MARGIN);
}

export function sampleFieldBuffer(seed: number, cc: ChunkCoord): FieldBuffer {
	const originX = cc.cx * CHUNK;
	const originY = cc.cy * CHUNK;
	const size = FIELD_SIZE * FIELD_SIZE;

	const elevation = new Float32Array(size);
	const moisture = new Float32Array(size);
	const temperature = new Float32Array(size);
	const roughness = new Float32Array(size);

	for (let y = -FIELD_MARGIN; y < CHUNK + FIELD_MARGIN; y++) {
		const wy = originY + y;
		for (let x = -FIELD_MARGIN; x < CHUNK + FIELD_MARGIN; x++) {
			const wx = originX + x;
			const i = index(x, y);
			elevation[i] = elevationAt(seed, wx, wy);
			moisture[i] = moistureAt(seed, wx, wy);
			// Temperature depends on elevation; pass the value we already have
			// rather than letting it recompute the whole warped stack.
			temperature[i] = temperatureFromElevation(seed, wx, wy, elevation[i] as number);
			roughness[i] = roughnessAt(seed, wx, wy);
		}
	}

	return { originX, originY, elevation, moisture, temperature, roughness };
}

/** Mirrors `temperatureAt`, reusing an elevation the caller already sampled. */
function temperatureFromElevation(seed: number, x: number, y: number, elevation: number): number {
	return temperatureAt(seed, x, y, elevation);
}

export function fieldAt(buffer: Float32Array, localX: number, localY: number): number {
	if (
		localX < -FIELD_MARGIN ||
		localY < -FIELD_MARGIN ||
		localX >= CHUNK + FIELD_MARGIN ||
		localY >= CHUNK + FIELD_MARGIN
	) {
		return 0;
	}
	return buffer[index(localX, localY)] ?? 0;
}

/**
 * Steepest elevation difference to a 4-neighbour, read straight out of the
 * buffer. This is the call that made the naive pipeline four times too slow.
 */
export function slopeFromBuffer(fields: FieldBuffer, localX: number, localY: number): number {
	const here = fieldAt(fields.elevation, localX, localY);
	return Math.max(
		Math.abs(here - fieldAt(fields.elevation, localX + 1, localY)),
		Math.abs(here - fieldAt(fields.elevation, localX - 1, localY)),
		Math.abs(here - fieldAt(fields.elevation, localX, localY + 1)),
		Math.abs(here - fieldAt(fields.elevation, localX, localY - 1)),
	);
}
