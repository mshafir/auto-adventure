import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSeed } from "../config.js";
import { type Duration, isDuration } from "../core/world/brief.js";
import { SETTLEMENT_KINDS } from "../core/world/macro.js";
import { LAND_ONLY, worldSeed } from "../core/world/recipe.js";
import { ARTIFACT_VERSION, type ScenarioArtifact } from "../scenario/artifact.js";
import { writeScenarioDir } from "../scenario/dir.js";
import { scenarioPath, scenarioRoot } from "../scenario/repo.js";
import { candidates, surveyWorld } from "../scenario/survey.js";
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
	// Left empty rather than stubbed with a word. `openingCard` uses the era as its subtitle, so a
	// placeholder there is a placeholder on the first screen of the game — the stub used to read
	// "unstated" under the title, which looks like a bug rather than like something unwritten.
	const era = args.str("era", "");
	const tone = args.str("tone", "");
	const pack = args.has("pack") ? args.str("pack") : undefined;
	const tiles = args.has("tiles") ? args.str("tiles") : undefined;
	args.refuseUnknown();

	// Land and nothing else. Every town, ruin and cave in an authored world is put there by an
	// author for a reason — see `LAND_ONLY` for what the rolled ones cost.
	const recipe = LAND_ONLY;
	const survey = surveyWorld(worldSeed(seed, recipe), duration, recipe);
	const artifact: ScenarioArtifact = {
		artifactVersion: ARTIFACT_VERSION,
		id,
		title,
		blurb: premise,
		brief: { title, premise, duration, ...(tone ? { tone } : {}) },
		seed,
		recipe,
		spawn: survey.spawn,
		bounds: survey.bounds,
		// Named from the premise so the world is not anonymous before a single call has been
		// made. An author replaces these; nothing derives anything from them.
		lore: { title, premise, era, tone, factions: [], deities: [] },
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
	out("  land only: nothing is built until you found it");
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
	const survey = surveyWorld(
		worldSeed(seed, workspace.artifact.recipe),
		duration,
		workspace.artifact.recipe,
	);
	workspace.artifact = {
		...workspace.artifact,
		seed,
		spawn: survey.spawn,
		bounds: survey.bounds,
	};
	writeScenarioDir(workspace.artifact, scenarioRoot());

	out(`reseeded "${workspace.id}" to ${seed} ("${word}")`);
	out(
		`  spawn ${survey.spawn.x},${survey.spawn.y}, bounds ${survey.bounds.minX},${survey.bounds.minY} ` +
			`to ${survey.bounds.maxX},${survey.bounds.maxY}`,
	);
}

/** How many cells the survey prints before it says how many more there are. */
const SURVEY_ROWS = 24;

/**
 * What the country will take, cell by cell.
 *
 * The question shopping for a world used to answer was "which towns did this seed give me".
 * Nothing gives you towns any more, so the question is the useful one instead: where will
 * this ground hold a place, how far is it from the start, and what is it like there.
 *
 * Every row is measured by actually laying a settlement out on that cell and counting the
 * plots it finds, which is the only thing that knows. So a row the survey prints is a place
 * `craft found` will accept, and the two cannot disagree.
 */
export function craftSurvey(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "survey"));
	const all = args.bool("all");
	const kind = args.oneOf("kind", SETTLEMENT_KINDS, "village");
	const importance = args.int("importance", 3);
	args.refuseUnknown();

	const artifact = workspace.artifact;
	const bounds = artifact.bounds;
	if (!bounds)
		throw new CraftError(`"${artifact.id}" has no bounds, so it has no ground to survey`);
	const spawn = artifact.spawn;

	out(`"${artifact.id}" — seed ${artifact.seed}, spawn ${spawn.x},${spawn.y}`);
	out(
		`bounds ${bounds.minX},${bounds.minY} to ${bounds.maxX},${bounds.maxY} ` +
			`(${bounds.style}, ${bounds.thickness} tiles of edge)`,
	);

	const founded = Object.values(artifact.sites);
	out("");
	if (founded.length === 0)
		out("nothing founded yet: this world is land only until you put something on it");
	else {
		out(`${founded.length} founded:`);
		for (const spec of founded) {
			out(`  ${spec.siteId}  ${spec.name} — ${spec.settlement.structures.length} building(s)`);
		}
	}

	const { found, refused } = candidates(
		artifact.seed,
		artifact.recipe,
		bounds,
		spawn,
		kind,
		importance,
	);
	out("");
	if (found.length === 0) {
		out(`no cell in this world will hold a ${kind}. Try --kind hamlet, or craft reseed.`);
		return;
	}
	out(
		`${found.length} cell(s) that will hold a ${kind} of importance ${importance}, nearest first:`,
	);
	for (const candidate of found.slice(0, all ? found.length : SURVEY_ROWS)) {
		const { context } = candidate.prospect;
		// Deduplicated because the biome and the elevation band often agree — "shore, shore"
		// reads as the tool repeating itself rather than as two facts.
		const notes = [
			...new Set([
				context.biomeName.toLowerCase(),
				context.terrain,
				...(context.coastal ? ["coast"] : []),
				...(context.nearRiver ? ["river"] : []),
			]),
		];
		out(
			`  --at ${String(`${context.x},${context.y}`).padEnd(11)} ${String(candidate.distanceFromSpawn).padStart(4)} away  ` +
				`room for ${String(candidate.prospect.budget).padStart(2)}  ${notes.join(", ")}`,
		);
	}
	// Said out loud rather than silently truncated: a list that stops without saying so reads
	// as the whole of what is available.
	if (!all && found.length > SURVEY_ROWS) {
		out(`  ... and ${found.length - SURVEY_ROWS} more (--all lists them)`);
	}
	if (refused > 0) {
		out(
			`  ${refused} cell(s) will not hold one — too steep, too wet, or too near the edge. ` +
				"craft found says which, for a cell you name",
		);
	}
	out("");
	out(
		`next: craft found ${artifact.id} --at <x,y> --kind ${kind} --name "..." --description "..."`,
	);
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
