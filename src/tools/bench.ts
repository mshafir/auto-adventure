import { clearSettlementCache } from "../core/gen/features/settlement.js";
import { generateChunk } from "../core/gen/pipeline.js";
import { hashString } from "../core/rand/hash.js";
import { isSettlement, macroSite } from "../core/world/macro.js";
import { clearRiverCache } from "../core/world/rivers.js";
import { clearRoadCache } from "../core/world/roads.js";

const SEED = hashString("bench");
generateChunk({ seed: SEED }, { cx: 0, cy: 0 });

function timeIt(label: string, fn: () => number) {
	const t0 = performance.now();
	const n = fn();
	const dt = performance.now() - t0;
	console.log(
		`${label.padEnd(34)} ${n} chunks ${dt.toFixed(0)}ms => ${(dt / n).toFixed(2)}ms/chunk`,
	);
}

timeIt("warm, mixed chunks", () => {
	let n = 0;
	for (let cy = -2; cy <= 2; cy++)
		for (let cx = -2; cx <= 2; cx++) {
			generateChunk({ seed: SEED }, { cx, cy });
			n++;
		}
	return n;
});

// Settlement chunks specifically: the expensive case.
const settled: { cx: number; cy: number }[] = [];
for (let my = -6; my <= 6; my++)
	for (let mx = -6; mx <= 6; mx++)
		if (isSettlement(macroSite(SEED, mx, my).kind)) settled.push({ cx: mx, cy: my });

clearSettlementCache();
timeIt(`cold settlement chunks`, () => {
	for (const cc of settled.slice(0, 10)) generateChunk({ seed: SEED }, cc);
	return Math.min(10, settled.length);
});

timeIt("warm settlement chunks (cached)", () => {
	for (const cc of settled.slice(0, 10)) generateChunk({ seed: SEED }, cc);
	return Math.min(10, settled.length);
});

clearRoadCache();
clearRiverCache();
clearSettlementCache();
timeIt("fully cold pass", () => {
	let n = 0;
	for (let cy = -2; cy <= 2; cy++)
		for (let cx = -2; cx <= 2; cx++) {
			generateChunk({ seed: SEED }, { cx, cy });
			n++;
		}
	return n;
});
