/**
 * Sample a large area and report what the world is actually made of.
 *
 * Terrain tuning by eye on a single 64-tile chunk is misleading: at large field
 * scales every chunk looks uniform and it is impossible to tell whether the
 * world is varied or the sample is too small. This measures instead.
 */
import { hashString } from "../core/rand/hash.js";
import { classifyBiome } from "../core/world/biome.js";
import {
	civilizationAt,
	elevationAt,
	elevationBand,
	moistureAt,
	temperatureAt,
} from "../core/world/fields.js";
import { macroSite } from "../core/world/macro.js";

const seedArg = process.argv[2] ?? "alpha";
const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : hashString(seedArg);
const span = Number(process.argv[3] ?? 1024);
const step = 4;

const biomes = new Map<string, number>();
const bands = new Map<string, number>();
let samples = 0;
let elevMin = 1;
let elevMax = 0;
let civSum = 0;

for (let y = -span; y < span; y += step) {
	for (let x = -span; x < span; x += step) {
		const e = elevationAt(seed, x, y);
		const t = temperatureAt(seed, x, y, e);
		const m = moistureAt(seed, x, y);
		const biome = classifyBiome(e, t, m);
		biomes.set(biome, (biomes.get(biome) ?? 0) + 1);
		const band = elevationBand(e);
		bands.set(band, (bands.get(band) ?? 0) + 1);
		elevMin = Math.min(elevMin, e);
		elevMax = Math.max(elevMax, e);
		civSum += civilizationAt(seed, x, y);
		samples++;
	}
}

const pct = (n: number) => `${((n / samples) * 100).toFixed(1)}%`;

console.log(`seed ${seedArg}  area ${span * 2}x${span * 2} tiles  ${samples} samples`);
console.log(
	`elevation ${elevMin.toFixed(2)}..${elevMax.toFixed(2)}  mean civilization ${(civSum / samples).toFixed(3)}`,
);
console.log("\nbands:");
for (const [band, n] of [...bands].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${band.padEnd(10)} ${pct(n)}`);
}
console.log("\nbiomes:");
for (const [biome, n] of [...biomes].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${biome.padEnd(12)} ${pct(n)}`);
}

const kinds = new Map<string, number>();
const macroSpan = Math.floor(span / 64);
for (let my = -macroSpan; my < macroSpan; my++) {
	for (let mx = -macroSpan; mx < macroSpan; mx++) {
		const kind = macroSite(seed, mx, my).kind;
		kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
	}
}
const cells = macroSpan * macroSpan * 4;
console.log(`\nsites over ${cells} macro cells:`);
for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${kind.padEnd(10)} ${n} (${((n / cells) * 100).toFixed(1)}%)`);
}
