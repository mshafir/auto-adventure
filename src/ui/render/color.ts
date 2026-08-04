export type RGB = readonly [number, number, number];

export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";

export function rgb(hex: string): RGB {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	const n = Number.parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
	const k = t < 0 ? 0 : t > 1 ? 1 : t;
	return [
		Math.round(a[0] + (b[0] - a[0]) * k),
		Math.round(a[1] + (b[1] - a[1]) * k),
		Math.round(a[2] + (b[2] - a[2]) * k),
	];
}

export function scale(c: RGB, k: number): RGB {
	const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
	return [clamp(c[0] * k), clamp(c[1] * k), clamp(c[2] * k)];
}

export function sameColor(a: RGB | null, b: RGB | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Detect what the terminal can actually render. `FORCE_COLOR`/`NO_COLOR` are
 * honoured because the golden tests and the `preview` CLI both need to pin a
 * depth regardless of where they run.
 */
export function detectColorDepth(env: NodeJS.ProcessEnv = process.env): ColorDepth {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
	const forced = env.FORCE_COLOR;
	if (forced === "0") return "none";
	if (forced === "1") return "ansi16";
	if (forced === "2") return "ansi256";
	if (forced === "3" || forced === "true") return "truecolor";

	const colorterm = env.COLORTERM?.toLowerCase() ?? "";
	if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";

	const term = env.TERM?.toLowerCase() ?? "";
	if (term === "dumb" || term === "") return "none";
	if (/-truecolor|-direct/.test(term)) return "truecolor";
	if (/-256(color)?/.test(term)) return "ansi256";
	return "ansi16";
}

/** Nearest xterm-256 index: the 6x6x6 colour cube plus the 24-step grey ramp. */
export function toAnsi256(c: RGB): number {
	const [r, g, b] = c;
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return 232 + Math.round(((r - 8) / 247) * 23);
	}
	// The cube has 6 levels per channel; `round((v - 35) / 40)` reaches 6 at the
	// top of the range, so it must be clamped or the index overflows past 255.
	const q = (v: number) => {
		if (v < 48) return 0;
		if (v < 114) return 1;
		return Math.min(5, Math.round((v - 35) / 40));
	};
	return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/**
 * Reduce to one of the 16 base colours.
 *
 * This deliberately thresholds each channel and picks the bright variant by
 * overall value, rather than taking the nearest neighbour in RGB space. Nearest
 * neighbour is metrically defensible but reads wrong: pure `#ff0000` is closer
 * to the dark red `#aa0000` than to the bright red `#ff5555`, so a vivid palette
 * would come out uniformly muddy. Terminals and the wider ecosystem use the
 * threshold form, so a 16-colour fallback matches what players expect elsewhere.
 */
export function toAnsi16(c: RGB): number {
	const [r, g, b] = c;
	const value = Math.round((Math.max(r, g, b) / 255) * 100);
	const level = Math.round(value / 50);
	if (level === 0) return 0;
	const index = (Math.round(b / 255) << 2) | (Math.round(g / 255) << 1) | Math.round(r / 255);
	return level === 2 ? index + 8 : index;
}

export const SGR_RESET = "\u001B[0m";

export function fgSequence(c: RGB, depth: ColorDepth): string {
	switch (depth) {
		case "truecolor":
			return `\u001B[38;2;${c[0]};${c[1]};${c[2]}m`;
		case "ansi256":
			return `\u001B[38;5;${toAnsi256(c)}m`;
		case "ansi16": {
			const i = toAnsi16(c);
			return `\u001B[${i < 8 ? 30 + i : 90 + (i - 8)}m`;
		}
		default:
			return "";
	}
}

export function bgSequence(c: RGB, depth: ColorDepth): string {
	switch (depth) {
		case "truecolor":
			return `\u001B[48;2;${c[0]};${c[1]};${c[2]}m`;
		case "ansi256":
			return `\u001B[48;5;${toAnsi256(c)}m`;
		case "ansi16": {
			const i = toAnsi16(c);
			return `\u001B[${i < 8 ? 40 + i : 100 + (i - 8)}m`;
		}
		default:
			return "";
	}
}
