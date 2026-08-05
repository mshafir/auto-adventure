import { domainWarp2, fbm2, unit } from "../rand/noise.js";
import { type WorldRules, type WorldSeed, zoneInfluence } from "./recipe.js";

/**
 * Continuous scalar fields sampled at world coordinates.
 *
 * These are the bottom of the whole system. Every one is `f(world, x, y)` with no
 * state, no caching keyed on a chunk, and no per-chunk parameters — which is
 * precisely why biome boundaries, coastlines and mountain ranges run across chunk
 * borders without any stitching code existing anywhere.
 *
 * `world` carries the seed and the scenario's recipe together. The recipe is
 * world-constant and its zones are smooth radial fields, so it changes what the
 * function computes without giving it a notion of a chunk — the property that
 * matters is preserved. Nothing that varies per chunk may ever reach this layer:
 * that would put a hard discontinuity at a chunk edge no amount of blending can
 * hide.
 */

/** Distinct offsets so the five fields are not correlated versions of each other. */
const SEED_ELEVATION = 0x1a2b;
const SEED_MOISTURE = 0x3c4d;
const SEED_TEMPERATURE = 0x5e6f;
const SEED_ROUGHNESS = 0x7081;
const SEED_CIVILIZATION = 0x92a3;

/**
 * The unconfigured thresholds, for code that reasons about elevation without a
 * world in hand — a doc string, a test fixture, a default in a tool. Anything
 * generating terrain reads `world.rules.climate` instead, because a scenario is
 * allowed to move the sea.
 */
export const SEA_LEVEL = 0.42;
export const SHORE_LEVEL = 0.46;
export const UPLAND_LEVEL = 0.66;
export const ALPINE_LEVEL = 0.8;

/**
 * Height in `[0, 1]`. Domain-warped: without the warp, fbm coastlines are
 * recognisably circular blobs, and a world of round islands reads as generated.
 */
export function elevationAt(world: WorldSeed, x: number, y: number): number {
	// One warp octave and four terrain octaves. The warp is low-frequency by
	// construction, so extra octaves in it cost two noise evaluations per sample
	// for a difference nobody can see; elevation is sampled ~4400 times per
	// chunk, so those evaluations are the chunk budget.
	const seed = world.seed;
	const [wx, wy] = domainWarp2(seed ^ SEED_ELEVATION, x, y, 50, {
		octaves: 1,
		scale: 200,
	});
	const base = fbm2(seed ^ SEED_ELEVATION, wx, wy, {
		octaves: 4,
		scale: world.rules.climate.elevationScale,
	});
	// Bias slightly upward so the default world is more land than ocean.
	return unit(base + world.rules.climate.elevationBias);
}

export function moistureAt(world: WorldSeed, x: number, y: number): number {
	const { climate } = world.rules;
	const base = unit(
		fbm2(world.seed ^ SEED_MOISTURE, x, y, { octaves: 3, scale: climate.moistureScale }),
	);
	return clamp01(base + climate.moistureBias + zoneMoisture(world.rules, x, y));
}

/**
 * Temperature in `[0, 1]`, falling with both altitude and latitude.
 *
 * The latitude band is very wide (8192 tiles by default) so the player experiences
 * it as "the north is colder" over a long journey rather than as stripes.
 *
 * `elevation` may be passed in when the caller already sampled it. Doing so is
 * a pure optimisation — the value must be `elevationAt(world, x, y)` — but it
 * removes an entire warped fbm stack from the inner generation loop.
 */
export function temperatureAt(world: WorldSeed, x: number, y: number, elevation?: number): number {
	const { climate } = world.rules;
	const base = fbm2(world.seed ^ SEED_TEMPERATURE, x, y, {
		octaves: 2,
		scale: climate.temperatureScale,
	});
	const latitude = Math.cos((y / climate.latitudeBand) * Math.PI) * 0.25;
	const altitude = (elevation ?? elevationAt(world, x, y)) * 0.4;
	const value = unit(base + latitude * 2 - altitude);
	return clamp01(value + climate.temperatureBias + zoneTemperature(world.rules, x, y));
}

/** Local ruggedness; drives scatter density and cliff frequency. */
export function roughnessAt(world: WorldSeed, x: number, y: number): number {
	return unit(
		fbm2(world.seed ^ SEED_ROUGHNESS, x, y, {
			octaves: 2,
			scale: world.rules.climate.roughnessScale,
		}),
	);
}

/**
 * How habitable a place is. Gates where settlements may appear, so towns land
 * on gentle, watered, temperate ground instead of on a cliff face.
 */
export function civilizationAt(world: WorldSeed, x: number, y: number): number {
	const base = unit(fbm2(world.seed ^ SEED_CIVILIZATION, x, y, { octaves: 2, scale: 700 }));
	const elevation = elevationAt(world, x, y);
	if (elevation < world.rules.climate.seaLevel) return 0;
	const habitability = 1 - Math.abs(elevation - 0.54) * 2.4;
	return Math.max(0, base * Math.max(0, habitability));
}

export interface FieldSample {
	readonly elevation: number;
	readonly moisture: number;
	readonly temperature: number;
	readonly roughness: number;
}

export function sampleFields(world: WorldSeed, x: number, y: number): FieldSample {
	return {
		elevation: elevationAt(world, x, y),
		moisture: moistureAt(world, x, y),
		temperature: temperatureAt(world, x, y),
		roughness: roughnessAt(world, x, y),
	};
}

export type ElevationBand = "ocean" | "shore" | "lowland" | "upland" | "alpine";

export function elevationBand(elevation: number, rules: WorldRules): ElevationBand {
	const { seaLevel, shoreLevel, uplandLevel, alpineLevel } = rules.climate;
	if (elevation < seaLevel) return "ocean";
	if (elevation < shoreLevel) return "shore";
	if (elevation < uplandLevel) return "lowland";
	if (elevation < alpineLevel) return "upland";
	return "alpine";
}

/** Steepest elevation difference to a 4-neighbour; used for cliffs and roads. */
export function slopeAt(world: WorldSeed, x: number, y: number): number {
	const here = elevationAt(world, x, y);
	return Math.max(
		Math.abs(here - elevationAt(world, x + 1, y)),
		Math.abs(here - elevationAt(world, x - 1, y)),
		Math.abs(here - elevationAt(world, x, y + 1)),
		Math.abs(here - elevationAt(world, x, y - 1)),
	);
}

/**
 * Zone contributions, skipped entirely when there are none.
 *
 * These two are called once per tile per field, so the empty case has to cost a
 * single length check rather than a function call that allocates a result object —
 * which is what the unconditional form did, at 8700 allocations per chunk in a
 * world with no zones at all.
 */
function zoneMoisture(rules: WorldRules, x: number, y: number): number {
	if (rules.flatFields) return 0;
	return zoneInfluence(rules, x, y).moisture;
}

function zoneTemperature(rules: WorldRules, x: number, y: number): number {
	if (rules.flatFields) return 0;
	return zoneInfluence(rules, x, y).temperature;
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value;
}
