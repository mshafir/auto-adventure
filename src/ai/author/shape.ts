import type { WorldRecipe } from "../../core/world/recipe.js";
import type { WorldShapeResponse } from "./schemas.js";

/**
 * Turn five coarse settings into a recipe.
 *
 * The model is never handed the recipe itself, and this table is why. A `WorldRecipe`
 * has `seaLevel` in it, and a model asked for a drowned archipelago will write `0.9` —
 * which is not an archipelago, it is an empty ocean with the player standing on the one
 * remaining rock. The numbers below were arrived at by generating worlds and looking at
 * them, which is a thing a person can do once and a model cannot do at all.
 *
 * Everything not named here is left at its default, so a shape of all-`ordinary`
 * produces exactly the world the generator has always produced.
 */
export function recipeFor(shape: WorldShapeResponse): WorldRecipe | undefined {
	const climate: Record<string, number> = {};
	const biomes: Record<string, { scatterDensity: number }> = {};
	const weights: Record<string, number> = {};

	// Sea level moves in small steps and always brings the shore band with it: raising
	// one without the other empties the beaches, and a coast with no beach reads as a
	// rendering fault rather than as a setting.
	switch (shape.sea) {
		case "drowned":
			climate.seaLevel = 0.52;
			climate.shoreLevel = 0.56;
			break;
		case "coastal":
			climate.seaLevel = 0.47;
			climate.shoreLevel = 0.51;
			break;
		case "landlocked":
			climate.seaLevel = 0.3;
			climate.shoreLevel = 0.34;
			break;
		default:
			break;
	}

	switch (shape.climate) {
		case "frozen":
			climate.temperatureBias = -0.28;
			break;
		case "cold":
			climate.temperatureBias = -0.14;
			break;
		case "hot":
			climate.temperatureBias = 0.14;
			break;
		case "scorched":
			climate.temperatureBias = 0.28;
			break;
		default:
			break;
	}

	switch (shape.wet) {
		case "arid":
			climate.moistureBias = -0.24;
			break;
		case "dry":
			climate.moistureBias = -0.12;
			break;
		case "lush":
			climate.moistureBias = 0.12;
			break;
		case "rain-drowned":
			climate.moistureBias = 0.24;
			break;
		default:
			break;
	}

	// Scaled from the defaults rather than replaced, so "thin" is the same woodland
	// with fewer trees in it and not a different kind of forest.
	const woods: Record<string, number> = {
		bare: 0.25,
		thin: 0.6,
		ordinary: 1,
		thick: 1.4,
		overgrown: 1.8,
	};
	const factor = woods[shape.woods] ?? 1;
	if (factor !== 1) {
		biomes.forest = { scatterDensity: clamp(0.62 * factor) };
		biomes.rainforest = { scatterDensity: clamp(0.76 * factor) };
		biomes.taiga = { scatterDensity: clamp(0.58 * factor) };
	}

	// The defaults total 18% of habitable cells. These scale that whole and keep the
	// mix, because a world with the same towns and half the hamlets is a different
	// thing from a world with half of everything.
	const settled: Record<string, number> = { empty: 0.35, sparse: 0.6, ordinary: 1, crowded: 1.6 };
	const density = settled[shape.settled] ?? 1;
	if (density !== 1) {
		const base = {
			town: 1.5,
			village: 2.5,
			fort: 1.5,
			hamlet: 4.5,
			camp: 3,
			ruins: 2.5,
			landmark: 2.5,
		};
		for (const [kind, percent] of Object.entries(base)) {
			weights[kind] = Math.round(percent * density * 10) / 10;
		}
	}

	// Castles, caves and docks, which the default world has none of. Left out of the
	// `density` scaling above on purpose: these are landmarks rather than places people
	// live, so "a crowded world" should mean more hamlets, not more castles.
	//
	// The numbers are small because the roll is per *macro cell* and the map has a great
	// many of them — 1.2% of habitable cells is already a couple of castles in a short
	// world, which is the most a story can actually use. They also decline rather than
	// compromise on unsuitable ground, so the number asked for is an upper bound and the
	// number that appears is usually lower.
	const landmark: Record<string, number> = { none: 0, few: 0.4, some: 1.2 };
	for (const [kind, level] of [
		["castle", shape.strongholds],
		["cave", shape.caves],
		["docks", shape.harbours],
	] as const) {
		const percent = landmark[level] ?? 0;
		if (percent > 0) weights[kind] = percent;
	}

	// Caves are the one of the three that belongs on wild ground as much as settled: a
	// cave mouth on a steep hillside nobody lives near is the normal case, and leaving it
	// out of the wild ladder is what would make caves appear only beside farmland.
	const wildWeights: Record<string, number> = {};
	if ((landmark[shape.caves] ?? 0) > 0) wildWeights.cave = landmark[shape.caves] as number;

	const recipe: WorldRecipe = {
		...(Object.keys(climate).length > 0 ? { climate } : {}),
		...(Object.keys(biomes).length > 0 ? { biomes } : {}),
		...(Object.keys(weights).length > 0 || Object.keys(wildWeights).length > 0
			? {
					sites: {
						...(Object.keys(weights).length > 0 ? { weights } : {}),
						...(Object.keys(wildWeights).length > 0 ? { wildWeights } : {}),
					},
				}
			: {}),
	};
	return Object.keys(recipe).length > 0 ? recipe : undefined;
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}
