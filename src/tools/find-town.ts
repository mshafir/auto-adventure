import { hashString } from "../core/rand/hash.js";
import { isSettlement, macroSite } from "../core/world/macro.js";
import { worldSeed } from "../core/world/recipe.js";

const seedArg = process.argv[2] ?? "alpha";
const seed = /^-?\d+$/.test(seedArg) ? Number(seedArg) : hashString(seedArg);
const world = worldSeed(seed);
for (let my = -4; my <= 4; my++) {
	for (let mx = -4; mx <= 4; mx++) {
		const s = macroSite(world, mx, my);
		if (isSettlement(s.kind))
			console.log(`${mx},${my}  ${s.kind} importance ${s.importance} radius ${s.radius}`);
	}
}
