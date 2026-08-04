import { fbm2 } from "../rand/noise.js";
import { moistureAt, temperatureAt } from "./fields.js";

/**
 * Sky and season, as a pure function of time and place.
 *
 * Weather is noise sampled with the clock as a third axis, so it is continuous
 * — it rolls in and out rather than flipping between states — and it is
 * reproducible: the same tick at the same place always looks the same, on any
 * machine, after any reload. Nothing about it is stored.
 */

export type Sky = "clear" | "overcast" | "rain" | "storm" | "fog" | "snow";

export interface Weather {
	readonly sky: Sky;
	/** 0..1. How committed the sky is to what it is doing. */
	readonly intensity: number;
	readonly description: string;
}

/** How many ticks a weather front takes to cross. */
const FRONT_PERIOD = 900;

export function weatherAt(seed: number, tick: number, x: number, y: number): Weather {
	// Sampling position on a coarse grid and time on its own axis means the
	// weather is regional rather than per-tile, and changes as you travel.
	const t = tick / FRONT_PERIOD;
	// fbm2 returns roughly [-1, 1]; shift it into [0, 1] so it composes with the
	// moisture field, which is already unit-range.
	const front = fbm2(seed ^ 0x57ea, x / 900 + t, y / 900 - t * 0.6, { octaves: 3 }) * 0.5 + 0.5;
	const moisture = moistureAt(seed, x, y);
	const temperature = temperatureAt(seed, x, y);

	// Wet country gets wet weather; the front decides how much.
	const wetness = front * 0.6 + moisture * 0.4;

	if (temperature < 0.28 && wetness > 0.52) {
		return {
			sky: "snow",
			intensity: clamp01((wetness - 0.52) * 4),
			description: "Snow is falling.",
		};
	}
	if (wetness > 0.74) {
		return {
			sky: "storm",
			intensity: clamp01((wetness - 0.74) * 6),
			description: "A storm is over you.",
		};
	}
	if (wetness > 0.6) {
		return { sky: "rain", intensity: clamp01((wetness - 0.6) * 7), description: "It is raining." };
	}
	if (wetness > 0.53 && moisture > 0.55) {
		return {
			sky: "fog",
			intensity: clamp01((wetness - 0.53) * 8),
			description: "Fog lies across the ground.",
		};
	}
	if (wetness > 0.46) {
		return {
			sky: "overcast",
			intensity: clamp01((wetness - 0.46) * 8),
			description: "The sky is grey.",
		};
	}
	return {
		sky: "clear",
		intensity: clamp01((0.46 - wetness) * 3),
		description: "The sky is clear.",
	};
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** The part of the day, for schedules and for prose. */
export type TimeOfDay = "night" | "dawn" | "morning" | "afternoon" | "dusk" | "evening";

export function timeOfDay(hour: number): TimeOfDay {
	if (hour < 5) return "night";
	if (hour < 7) return "dawn";
	if (hour < 12) return "morning";
	if (hour < 17) return "afternoon";
	if (hour < 20) return "dusk";
	if (hour < 23) return "evening";
	return "night";
}
