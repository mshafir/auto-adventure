import type { Weather } from "../../core/world/weather.js";
import type { RGB } from "./color.js";

/**
 * What time it is, expressed as a colour.
 *
 * The compositor multiplies this into every cell, so one small table changes
 * the whole mood of the game for about as much code as a loading spinner. The
 * key numbers are the strengths: night is heavily tinted but never black,
 * because a roguelike you cannot read is not atmospheric, it is broken.
 */

export interface Light {
	readonly tint: RGB;
	/** 0 = untouched daylight, 1 = fully tinted. */
	readonly strength: number;
	readonly label: string;
}

interface Keyframe {
	readonly hour: number;
	readonly tint: RGB;
	readonly strength: number;
	readonly label: string;
}

// Interpolated between, so dusk arrives gradually rather than on the hour.
const DAY: readonly Keyframe[] = [
	{ hour: 0, tint: [92, 108, 168], strength: 0.62, label: "night" },
	{ hour: 5, tint: [120, 122, 176], strength: 0.5, label: "before dawn" },
	{ hour: 7, tint: [236, 176, 150], strength: 0.28, label: "dawn" },
	{ hour: 10, tint: [255, 250, 240], strength: 0.04, label: "morning" },
	{ hour: 14, tint: [255, 252, 246], strength: 0, label: "afternoon" },
	{ hour: 18, tint: [248, 186, 138], strength: 0.24, label: "evening" },
	{ hour: 20, tint: [176, 132, 148], strength: 0.42, label: "dusk" },
	{ hour: 22, tint: [104, 116, 172], strength: 0.58, label: "night" },
	{ hour: 24, tint: [92, 108, 168], strength: 0.62, label: "night" },
];

/** Weather pulls the tint towards its own colour and deepens it. */
const SKY: Readonly<Record<Weather["sky"], { tint: RGB; strength: number }>> = {
	clear: { tint: [255, 255, 255], strength: 0 },
	overcast: { tint: [186, 190, 196], strength: 0.2 },
	rain: { tint: [150, 170, 196], strength: 0.32 },
	storm: { tint: [110, 126, 156], strength: 0.46 },
	fog: { tint: [198, 202, 206], strength: 0.38 },
	snow: { tint: [214, 226, 244], strength: 0.3 },
};

/** Indoors the sky is irrelevant; lamplight is not. */
const INTERIOR: Light = { tint: [255, 214, 150], strength: 0.24, label: "lamplit" };

export function lightFor(hour: number, weather?: Weather, inside = false): Light {
	if (inside) return INTERIOR;

	const clock = ((hour % 24) + 24) % 24;
	let previous = DAY[0] as Keyframe;
	let next = DAY[DAY.length - 1] as Keyframe;
	for (let i = 0; i < DAY.length - 1; i++) {
		const a = DAY[i] as Keyframe;
		const b = DAY[i + 1] as Keyframe;
		if (clock >= a.hour && clock <= b.hour) {
			previous = a;
			next = b;
			break;
		}
	}

	const span = next.hour - previous.hour || 1;
	const t = (clock - previous.hour) / span;
	let tint = mix(previous.tint, next.tint, t);
	let strength = previous.strength + (next.strength - previous.strength) * t;
	const label = t < 0.5 ? previous.label : next.label;

	if (weather && weather.sky !== "clear") {
		const sky = SKY[weather.sky];
		const weight = sky.strength * (0.5 + weather.intensity * 0.5);
		tint = mix(tint, sky.tint, weight);
		// Weather never fully overrides the clock; it deepens it.
		strength = Math.min(0.78, strength + weight * 0.6);
	}

	return { tint, strength, label };
}

function mix(a: RGB, b: RGB, t: number): RGB {
	const k = Math.max(0, Math.min(1, t));
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}
