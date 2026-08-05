import type { BiomeDef, BiomeId } from "./biome-table.js";
import { type ElevationBand, elevationBand } from "./fields.js";
import type { WorldRules } from "./recipe.js";

export { ALL_BIOMES, type BiomeDef, type BiomeId, DEFAULT_BIOME_TABLE } from "./biome-table.js";

/**
 * Whittaker-style classification: temperature and moisture pick the biome
 * within an elevation band.
 *
 * Because the three inputs are continuous and the bands are thresholds on those
 * inputs, biome borders are automatically continuous across chunk boundaries —
 * there is nothing to reconcile.
 */
export function classifyBiome(
	elevation: number,
	temperature: number,
	moisture: number,
	rules: WorldRules,
): BiomeId {
	const band: ElevationBand = elevationBand(elevation, rules);

	switch (band) {
		case "ocean":
			return "ocean";
		case "shore":
			return moisture > 0.72 ? "marsh" : "beach";
		case "alpine":
			return temperature < 0.28 ? "glacier" : "alpine";
		case "upland":
			if (temperature < 0.3) return "taiga";
			if (moisture < 0.3) return "badlands";
			return "highland";
		case "lowland": {
			if (temperature < 0.26) return moisture > 0.45 ? "taiga" : "moor";
			if (temperature > 0.72) {
				if (moisture < 0.25) return "desert";
				if (moisture < 0.5) return "savanna";
				return "rainforest";
			}
			if (moisture < 0.28) return "shrubland";
			if (moisture < 0.48) return "grassland";
			if (moisture < 0.62) return "meadow";
			if (moisture < 0.82) return "forest";
			return "marsh";
		}
	}
}

/** What a biome is in *this* world, after the recipe's overrides. */
export function biomeDef(id: BiomeId, rules: WorldRules): BiomeDef {
	return rules.biomes[id];
}
