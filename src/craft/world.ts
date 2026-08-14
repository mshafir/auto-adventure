import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSeed } from "../config.js";
import { fallbackSettlementSpec } from "../core/gen/features/fallback-spec.js";
import { invalidateFeature } from "../core/gen/features/registry.js";
import { generateSettlement } from "../core/gen/features/settlement.js";
import { type Duration, isDuration } from "../core/world/brief.js";
import { worldSeed } from "../core/world/recipe.js";
import { ARTIFACT_VERSION, artifactWorld, type ScenarioArtifact } from "../scenario/artifact.js";
import { writeScenarioDir } from "../scenario/dir.js";
import { scenarioPath, scenarioRoot } from "../scenario/repo.js";
import { type Survey, surveyWorld } from "../scenario/survey.js";
import { type Args, CraftError } from "./args.js";
import { openWorkspace } from "./workspace.js";

/**
 * Commands about the ground: making a world, shopping for a different one, and looking.
 *
 * `survey` is where authoring starts and it is the reason this whole approach works. The
 * generator is pure, so every settlement, its building capacity, the ground it stands on and
 * its distance from the spawn are knowable before a word is written. A story written against
 * that cannot describe a town that is not there.
 */

const DURATIONS = ["tiny", "short", "medium", "long"] as const;

/** The slug rules, which are also the directory-name rules. */
const ID = /^[a-z0-9][a-z0-9-]*$/;

export function craftNew(args: Args, out: (line: string) => void): void {
	const id = args.words[1];
	if (!id)
		throw new CraftError('craft new wants an id: "craft new the-drowned-abbey --premise ..."');
	if (!ID.test(id))
		throw new CraftError(`"${id}" is not a usable id: lower-case letters, digits and dashes`);
	if (existsSync(scenarioPath(id))) throw new CraftError(`"${id}" already exists`);

	const premise = args.str("premise");
	const title = args.str("title", titleFrom(id));
	const duration = args.oneOf("duration", DURATIONS, "short");
	// From the id when nobody names a seed, so the same name always makes the same country —
	// which is what lets an author say "that one" and get it back.
	const seed = resolveSeed(args.str("seed", id));
	const pack = args.has("pack") ? args.str("pack") : undefined;
	const tiles = args.has("tiles") ? args.str("tiles") : undefined;
	args.refuseUnknown();

	const survey = surveyWorld(worldSeed(seed), duration, undefined);
	const artifact: ScenarioArtifact = {
		artifactVersion: ARTIFACT_VERSION,
		id,
		title,
		blurb: premise,
		brief: { title, premise, duration },
		seed,
		spawn: survey.spawn,
		bounds: survey.bounds,
		// Named from the premise so the world is not anonymous before a single call has been
		// made. An author replaces these; nothing derives anything from them.
		lore: {
			title,
			premise,
			era: "unstated",
			tone: "unstated",
			factions: [],
			deities: [],
		},
		regions: {},
		sites: {},
		...(pack ? { pack } : {}),
		...(tiles ? { tiles } : {}),
		authoredWith: { models: {}, calls: 0, at: new Date().toISOString() },
	};

	writeScenarioDir(artifact, scenarioRoot());
	writeStory(scenarioPath(id), title, premise);

	out(`made "${id}" in ${scenarioPath(id)}`);
	out(`  seed ${seed}, ${duration}, spawn ${survey.spawn.x},${survey.spawn.y}`);
	out(
		`  bounds ${survey.bounds.minX},${survey.bounds.minY} to ${survey.bounds.maxX},${survey.bounds.maxY}`,
	);
	out(`  ${survey.sites.filter((site) => site.settlement).length} settlement(s) to claim`);
	out(`next: craft survey ${id}`);
}

/**
 * A different world, same story.
 *
 * The cheapest of the three ways to get a map that suits a story, and the one the skill tells
 * an agent to reach for first: reseeding is free, and terraforming is a debt. Refused once
 * anything is claimed, because a site spec is keyed to a site id and site ids are a function
 * of the seed — a reseeded scenario would carry correctly-named towns standing nowhere.
 */
export function craftReseed(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "reseed"));
	const claimed = Object.keys(workspace.artifact.sites);
	if (claimed.length > 0) {
		throw new CraftError(
			`"${workspace.id}" has already claimed ${claimed.length} site(s), and site ids come from the seed — ` +
				"so reseeding would leave them naming towns that do not exist. Start a new scenario instead.",
		);
	}

	const word = args.str("seed", `${workspace.id}-${Date.now()}`);
	const duration = workspace.artifact.brief.duration;
	args.refuseUnknown();

	const seed = resolveSeed(word);
	const survey = surveyWorld(worldSeed(seed), duration, workspace.artifact.recipe);
	workspace.artifact = {
		...workspace.artifact,
		seed,
		spawn: survey.spawn,
		bounds: survey.bounds,
	};
	writeScenarioDir(workspace.artifact, scenarioRoot());

	out(`reseeded "${workspace.id}" to ${seed} ("${word}")`);
	out(
		`  spawn ${survey.spawn.x},${survey.spawn.y}, ${survey.sites.filter((s) => s.settlement).length} settlement(s)`,
	);
}

export function craftSurvey(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "survey"));
	const all = args.bool("all");
	args.refuseUnknown();

	const artifact = workspace.artifact;
	const world = artifactWorld(artifact);
	const survey = surveyWorld(world, artifact.brief.duration, artifact.recipe);

	out(`"${artifact.id}" — seed ${artifact.seed}, spawn ${survey.spawn.x},${survey.spawn.y}`);
	out(
		`bounds ${survey.bounds.minX},${survey.bounds.minY} to ${survey.bounds.maxX},${survey.bounds.maxY} (${survey.bounds.style})`,
	);
	out("");

	const sites = all ? survey.sites : survey.sites.filter((site) => site.settlement);
	if (sites.length === 0) {
		out("nothing to claim in this world. Try craft reseed.");
		return;
	}
	out(`${sites.length} place(s), nearest first:`);
	for (const site of [...sites].sort((a, b) => a.distanceFromSpawn - b.distanceFromSpawn)) {
		const claimed = artifact.sites[String(site.site.id)];
		const mark = claimed ? `claimed as "${claimed.name}"` : "unclaimed";
		out(
			`  ${site.site.id}  ${site.site.kind.padEnd(9)} at ${site.site.site.x},${site.site.site.y}  ` +
				`${site.distanceFromSpawn} away  ${site.context.biome}  room for ${site.context.buildingBudget}  ${mark}`,
		);
		if (site.settlement && !claimed)
			out(`      anchors: ${anchorsOf(survey, site.site.id).join(" ")}`);
	}
	out("");
	out(`next: craft claim ${artifact.id} --site <id> --name "..." --description "..."`);
}

/**
 * Which anchors a settlement is likely to lay down.
 *
 * Measured from the deterministic roster, so it is a strong hint rather than a promise — the
 * real layout depends on the roster that ends up being authored. It is here because putting
 * somebody at an anchor the settlement never builds leaves a named character standing
 * nowhere, and that is invisible until validation.
 */
function anchorsOf(survey: Survey, siteId: number): string[] {
	const found = survey.sites.find((candidate) => candidate.site.id === siteId);
	if (!found) return [];
	invalidateFeature(survey.world, siteId);
	const built = generateSettlement(
		survey.world,
		found.site,
		fallbackSettlementSpec(survey.world, found.site),
	);
	const kinds = [
		...new Set(built.anchors.filter((a) => a.building === undefined).map((a) => a.kind)),
	];
	// Leave no cached patch behind: the next thing to generate this site should be measuring
	// the authored roster, not this probe.
	invalidateFeature(survey.world, siteId);
	return kinds.sort();
}

function writeStory(dir: string, title: string, premise: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "story.md"),
		`# ${title}

${premise}

## The beginning

## The middle

## The end

## Who is in it

## What each place is for
`,
	);
}

/** A title from an id, for a scenario nobody has named yet. */
function titleFrom(id: string): string {
	return id
		.split("-")
		.map((word) => (word.length > 3 ? word[0]?.toUpperCase() + word.slice(1) : word))
		.join(" ")
		.replace(/^./, (first) => first.toUpperCase());
}

export function requireId(args: Args, verb: string): string {
	return args.target(verb);
}

export function durationOf(artifact: ScenarioArtifact): Duration {
	const asked = artifact.brief.duration;
	return asked && isDuration(asked) ? asked : "short";
}
