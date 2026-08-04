import { domainWarp2, fbm2, unit } from "../rand/noise.js";

/**
 * Continuous scalar fields sampled at world coordinates.
 *
 * These are the bottom of the whole system. Every one is `f(seed, x, y)` with
 * no state, no caching keyed on a chunk, and no per-chunk parameters — which is
 * precisely why biome boundaries, coastlines and mountain ranges run across
 * chunk borders without any stitching code existing anywhere.
 *
 * Nothing the LLM produces may reach this layer. Per-chunk influence here would
 * put a hard discontinuity at a chunk edge no amount of blending can hide.
 */

/** Distinct offsets so the five fields are not correlated versions of each other. */
const SEED_ELEVATION = 0x1a2b;
const SEED_MOISTURE = 0x3c4d;
const SEED_TEMPERATURE = 0x5e6f;
const SEED_ROUGHNESS = 0x7081;
const SEED_CIVILIZATION = 0x92a3;

export const SEA_LEVEL = 0.42;
export const SHORE_LEVEL = 0.46;
export const UPLAND_LEVEL = 0.66;
export const ALPINE_LEVEL = 0.8;

/**
 * Height in `[0, 1]`. Domain-warped: without the warp, fbm coastlines are
 * recognisably circular blobs, and a world of round islands reads as generated.
 */
export function elevationAt(seed: number, x: number, y: number): number {
	// One warp octave and four terrain octaves. The warp is low-frequency by
	// construction, so extra octaves in it cost two noise evaluations per sample
	// for a difference nobody can see; elevation is sampled ~4400 times per
	// chunk, so those evaluations are the chunk budget.
	const [wx, wy] = domainWarp2(seed ^ SEED_ELEVATION, x, y, 50, {
		octaves: 1,
		scale: 200,
	});
	const base = fbm2(seed ^ SEED_ELEVATION, wx, wy, { octaves: 4, scale: 240 });
	// Bias slightly upward so the default world is more land than ocean.
	return unit(base + 0.12);
}

export function moistureAt(seed: number, x: number, y: number): number {
	return unit(fbm2(seed ^ SEED_MOISTURE, x, y, { octaves: 3, scale: 170 }));
}

/**
 * Temperature in `[0, 1]`, falling with both altitude and latitude.
 *
 * The latitude band is very wide (8192 tiles) so the player experiences it as
 * "the north is colder" over a long journey rather than as stripes.
 *
 * `elevation` may be passed in when the caller already sampled it. Doing so is
 * a pure optimisation — the value must be `elevationAt(seed, x, y)` — but it
 * removes an entire warped fbm stack from the inner generation loop.
 */
export function temperatureAt(seed: number, x: number, y: number, elevation?: number): number {
	const base = fbm2(seed ^ SEED_TEMPERATURE, x, y, { octaves: 2, scale: 400 });
	const latitude = Math.cos((y / 8192) * Math.PI) * 0.25;
	const altitude = (elevation ?? elevationAt(seed, x, y)) * 0.4;
	return unit(base + latitude * 2 - altitude);
}

/** Local ruggedness; drives scatter density and cliff frequency. */
export function roughnessAt(seed: number, x: number, y: number): number {
	return unit(fbm2(seed ^ SEED_ROUGHNESS, x, y, { octaves: 2, scale: 40 }));
}

/**
 * How habitable a place is. Gates where settlements may appear, so towns land
 * on gentle, watered, temperate ground instead of on a cliff face.
 */
export function civilizationAt(seed: number, x: number, y: number): number {
	const base = unit(fbm2(seed ^ SEED_CIVILIZATION, x, y, { octaves: 2, scale: 700 }));
	const elevation = elevationAt(seed, x, y);
	if (elevation < SEA_LEVEL) return 0;
	const habitability = 1 - Math.abs(elevation - 0.54) * 2.4;
	return Math.max(0, base * Math.max(0, habitability));
}

export interface FieldSample {
	readonly elevation: number;
	readonly moisture: number;
	readonly temperature: number;
	readonly roughness: number;
}

export function sampleFields(seed: number, x: number, y: number): FieldSample {
	return {
		elevation: elevationAt(seed, x, y),
		moisture: moistureAt(seed, x, y),
		temperature: temperatureAt(seed, x, y),
		roughness: roughnessAt(seed, x, y),
	};
}

export type ElevationBand = "ocean" | "shore" | "lowland" | "upland" | "alpine";

export function elevationBand(elevation: number): ElevationBand {
	if (elevation < SEA_LEVEL) return "ocean";
	if (elevation < SHORE_LEVEL) return "shore";
	if (elevation < UPLAND_LEVEL) return "lowland";
	if (elevation < ALPINE_LEVEL) return "upland";
	return "alpine";
}

/** Steepest elevation difference to a 4-neighbour; used for cliffs and roads. */
export function slopeAt(seed: number, x: number, y: number): number {
	const here = elevationAt(seed, x, y);
	return Math.max(
		Math.abs(here - elevationAt(seed, x + 1, y)),
		Math.abs(here - elevationAt(seed, x - 1, y)),
		Math.abs(here - elevationAt(seed, x, y + 1)),
		Math.abs(here - elevationAt(seed, x, y - 1)),
	);
}
