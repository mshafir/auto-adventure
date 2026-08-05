/**
 * Print the world a scenario would be authored into.
 *
 * ```
 * npm run survey -- --seed drowned-archipelago --duration short
 * npm run survey -- --recipe .scenarios/thornwick-recipe.json
 * ```
 *
 * Costs nothing and calls no model: the generator is pure, so every settlement, its
 * size, its building capacity, the ground it stands on and its distance from the
 * start are all knowable before a word is written. Authoring against this output is
 * what stops a scenario describing a town that is not there.
 */

import { PLACEMENTS, STRUCTURE_KINDS } from "../ai/director/schemas.js";
import { resolveSeed } from "../config.js";
import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import { invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { isDuration } from "../core/world/brief.js";
import type { WorldSeed } from "../core/world/recipe.js";
import { planFor, surveyWorld } from "../scenario/survey.js";
import { worldFromArgs } from "./recipe-arg.js";

function parseArgs(argv: readonly string[]): Map<string, string> {
	const args = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token?.startsWith("--")) continue;
		const [key, inline] = token.slice(2).split("=", 2);
		if (!key) continue;
		if (inline !== undefined) {
			args.set(key, inline);
			continue;
		}
		const next = argv[i + 1];
		if (next && !next.startsWith("--")) {
			args.set(key, next);
			i++;
		} else args.set(key, "true");
	}
	return args;
}

/**
 * Which anchors a town is likely to lay down.
 *
 * Measured from the deterministic roster, so it is a strong hint rather than a
 * promise — the real layout depends on the roster that ends up being authored. It is
 * here because placing somebody at an anchor the settlement never builds leaves a
 * named character standing nowhere, and that is invisible until validation.
 */
function likelyAnchors(world: WorldSeed, site: Parameters<typeof generateSettlement>[1]): string[] {
	invalidateFeature(world, site.id);
	const built = generateSettlement(world, site, fallbackSettlementSpec(world.seed, site));
	const kinds = [...new Set(built.anchors.map((anchor) => anchor.kind))].sort();
	// Leave no cached patch behind: the next thing to generate this site should be
	// measuring the authored roster, not this probe.
	invalidateFeature(world, site.id);
	return kinds.filter((kind) => (PLACEMENTS as readonly string[]).includes(kind));
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const duration = args.get("duration") ?? "medium";
	if (!isDuration(duration)) {
		process.stderr.write(`--duration must be short, medium or long, not "${duration}"\n`);
		process.exit(2);
	}
	const seedArg = args.get("seed") ?? "auto-adventure";
	const seed = resolveSeed(seedArg);
	const world = worldFromArgs(seed, args.get("recipe"));
	const survey = surveyWorld(world, duration);
	const plan = planFor(duration);

	const output = {
		seed,
		seedInput: seedArg,
		duration,
		plan: { beats: plan.beats, radiusChunks: plan.radiusChunks },
		spawn: survey.spawn,
		bounds: survey.bounds,
		boundaryAdjustment: survey.boundaryAdjustment,
		allowedStructureKinds: STRUCTURE_KINDS,
		allowedPlacements: PLACEMENTS,
		regions: survey.regions.map((region) => ({
			regionId: region.regionId,
			dominantBiome: region.biomeName,
			biomes: region.biomes,
			settlementKinds: region.settlementKinds,
		})),
		sites: survey.sites.map((entry) => ({
			siteId: entry.site.id,
			kind: entry.site.kind,
			settlement: entry.settlement,
			importance: entry.site.importance,
			at: { x: entry.site.site.x, y: entry.site.site.y },
			distanceFromSpawn: entry.distanceFromSpawn,
			regionId: entry.site.regionId,
			biome: entry.context.biomeName,
			terrain: entry.context.terrain,
			coastal: entry.context.coastal,
			nearRiver: entry.context.nearRiver,
			roadCount: entry.context.roadCount,
			/** Author at most this many structures; the rest will not fit. */
			buildingBudget: entry.context.buildingBudget,
			neighbours: entry.context.neighbours,
			...(entry.settlement ? { likelyAnchors: likelyAnchors(world, entry.site) } : {}),
		})),
	};

	process.stdout.write(`${JSON.stringify(output, null, "\t")}\n`);
}

main();
