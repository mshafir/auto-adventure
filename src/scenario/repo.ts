import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { danglingTargets } from "../ai/dialogue/tree.js";
import { resolveOverride } from "../content/load.js";
import { mergeOverride } from "../core/content/pack.js";
import { asCondition, evaluate, flagsRead } from "../core/rules/condition.js";
import { createInitialState, type GameState } from "../core/rules/state.js";
import { MACRO, macroSite } from "../core/world/macro.js";
import { npcId } from "../core/world/spec.js";
import { scenarioRoot } from "../paths.js";
import { writeFileAtomic } from "../persist/save-repo.js";
import { logger } from "../utils/log.js";
import { artifactWorld, type ScenarioArtifact } from "./artifact.js";
import { flagsWritten, unsatisfiableFlags } from "./flag-sources.js";
import { ScenarioArtifactSchema } from "./schema.js";

export { scenarioRoot };

export function scenarioPath(id: string): string {
	return join(scenarioRoot(), `${id}.json`);
}

export interface ScenarioSummary {
	readonly id: string;
	readonly title: string;
	readonly blurb: string;
	readonly path: string;
	readonly siteCount: number;
}

/**
 * Read and validate one scenario file.
 *
 * Returns undefined rather than throwing for every way a file can be wrong —
 * missing, unparseable, a shape from a future build, internally inconsistent, or
 * naming a pack that is not there. A bad scenario must not stop the launcher from
 * listing the good ones.
 */
export function readScenarioFile(path: string): ScenarioArtifact | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		logger.warn(`scenario ${path} is not valid JSON`, error);
		return undefined;
	}

	const parsed = ScenarioArtifactSchema.safeParse(raw);
	if (!parsed.success) {
		logger.warn(`scenario ${path} failed validation: ${parsed.error.issues[0]?.message ?? "?"}`);
		return undefined;
	}

	const artifact = parsed.data as ScenarioArtifact;
	const problems = verifyArtifact(artifact);
	if (problems.length > 0) {
		logger.warn(`scenario ${artifact.id} is inconsistent: ${problems.join("; ")}`);
		return undefined;
	}
	return resolvePack(artifact);
}

/**
 * Fold the named pack into the scenario's own tables.
 *
 * Done here, at the edge, so that everything downstream sees one `content`
 * override and nothing else has to know a reference existed. That is what keeps
 * the *save* self-contained: `buildSession` persists whatever `content` it is
 * given, so by resolving before it is handed over, a world already in progress
 * survives the pack file being renamed or deleted — the same rule that makes a
 * save carry its own pack rather than a pointer to one.
 *
 * A named pack that cannot be read fails the whole scenario. Starting the world
 * anyway would hand the player a place whose people are named out of the default
 * tables, which reads as a scenario that was written badly rather than one that
 * did not fully load.
 */
function resolvePack(artifact: ScenarioArtifact): ScenarioArtifact | undefined {
	if (!artifact.pack) return artifact;

	const named = resolveOverride(artifact.pack);
	if (!named) {
		logger.warn(`scenario ${artifact.id} names pack "${artifact.pack}", which could not be read`);
		return undefined;
	}

	const content = mergeOverride(named, artifact.content);
	return content ? { ...artifact, content } : artifact;
}

export function loadScenario(id: string): ScenarioArtifact | undefined {
	return readScenarioFile(scenarioPath(id));
}

export function listScenarios(): ScenarioSummary[] {
	const root = scenarioRoot();
	if (!existsSync(root)) return [];
	const summaries: ScenarioSummary[] = [];
	for (const entry of readdirSync(root)) {
		if (!entry.endsWith(".json")) continue;
		const artifact = readScenarioFile(join(root, entry));
		if (!artifact) continue;
		summaries.push({
			id: artifact.id,
			title: artifact.title,
			blurb: artifact.blurb,
			path: join(root, entry),
			siteCount: Object.keys(artifact.sites).length,
		});
	}
	summaries.sort((a, b) => a.title.localeCompare(b.title));
	return summaries;
}

export function writeScenario(artifact: ScenarioArtifact): string {
	const path = scenarioPath(artifact.id);
	writeFileAtomic(path, `${JSON.stringify(artifact, null, "\t")}\n`);
	return path;
}

/**
 * Check an artifact against the world its seed actually generates.
 *
 * This is the invariant that ruins everything silently if it breaks. Site ids are
 * derived from `(seed, macroCoordinate)`, so a spec keyed to an id no cell
 * produces is unreachable content: the town it describes never gets its name, and
 * nothing anywhere reports an error. Cheap to check — a few hundred `macroSite`
 * calls over the bounded footprint — so it is checked on every load rather than
 * trusted from authoring time.
 */
export function verifyArtifact(artifact: ScenarioArtifact): string[] {
	const problems: string[] = [];

	if (artifact.bounds.minX >= artifact.bounds.maxX || artifact.bounds.minY >= artifact.bounds.maxY)
		problems.push("bounds are inverted or empty");

	// One macro cell per chunk. A halo of one covers sites just outside the
	// rectangle whose footprint still reaches inside it.
	const real = new Set<number>();
	const minMx = Math.floor(artifact.bounds.minX / MACRO) - 1;
	const maxMx = Math.floor(artifact.bounds.maxX / MACRO) + 1;
	const minMy = Math.floor(artifact.bounds.minY / MACRO) - 1;
	const maxMy = Math.floor(artifact.bounds.maxY / MACRO) + 1;
	for (let my = minMy; my <= maxMy; my++) {
		for (let mx = minMx; mx <= maxMx; mx++) {
			const site = macroSite(artifactWorld(artifact), mx, my);
			if (site.kind !== "none") real.add(site.id);
		}
	}

	for (const [key, spec] of Object.entries(artifact.sites)) {
		const id = Number(key);
		if (!Number.isInteger(id)) {
			problems.push(`site key ${key} is not an id`);
			continue;
		}
		if (spec.siteId !== id) problems.push(`site ${key} carries siteId ${spec.siteId}`);
		if (!real.has(id)) problems.push(`site ${key} is not a site of seed ${artifact.seed}`);
		// Slots are the other half of every NPC id, so a duplicate or a gap would
		// give two people the same identity in the save.
		const slots = spec.npcs.map((npc) => npc.slot);
		if (new Set(slots).size !== slots.length) problems.push(`site ${key} repeats an npc slot`);
	}

	for (const [key, region] of Object.entries(artifact.regions)) {
		if (region.id !== key) problems.push(`region ${key} carries id ${region.id}`);
	}

	problems.push(...arcProblems(artifact));
	problems.push(...treeProblems(artifact));

	// Report a handful rather than a wall: if the seed is wrong every site is
	// wrong, and the first few say so just as well.
	return problems.slice(0, 6);
}

/**
 * Whether the authored conversations can actually be held.
 *
 * A dangling `goto` is the one that matters: at runtime it ends the conversation,
 * so a renamed node turns a branch of dialogue into an abrupt goodbye that looks
 * like the character has nothing more to say. Trees keyed to nobody are the other
 * half — the file is carrying words no one will ever speak.
 */
function treeProblems(artifact: ScenarioArtifact): string[] {
	const trees = artifact.trees;
	if (!trees) return [];
	const problems: string[] = [];

	const people = new Set<string>();
	for (const spec of Object.values(artifact.sites)) {
		for (const npc of spec.npcs) people.add(npcId(spec.siteId, npc.slot));
	}

	for (const [key, tree] of Object.entries(trees)) {
		if (tree.npcId !== key) problems.push(`tree ${key} carries npcId ${tree.npcId}`);
		if (!people.has(key)) problems.push(`tree ${key} belongs to nobody in this world`);

		const dangling = danglingTargets(tree);
		if (dangling.length > 0)
			problems.push(`tree ${key} points at missing node(s) ${dangling.slice(0, 3).join(", ")}`);

		// A conversation with no way out would trap the panel open. ESC always works,
		// but a tree should not rely on the player knowing that.
		const closes = Object.values(tree.nodes).some(
			(node) => node.choices.length === 0 || node.choices.some((choice) => choice.goto === null),
		);
		if (Object.keys(tree.nodes).length > 0 && !closes)
			problems.push(`tree ${key} has no way to end`);
	}

	return problems;
}

/**
 * Whether the story can actually be told.
 *
 * Every one of these is a silent failure at runtime rather than a crash: a beat
 * anchored to somebody who does not exist simply never opens, and because later
 * beats gate on its flag, the story stops there with nothing to show the player
 * why. Checked here so a broken arc is a file that will not load, not a
 * playthrough that quietly dead-ends four hours in.
 */
function arcProblems(artifact: ScenarioArtifact): string[] {
	const arc = artifact.arc;
	if (!arc) return [];
	const problems: string[] = [];

	const ids = new Set<string>();
	for (const beat of arc.beats) {
		if (ids.has(beat.id)) problems.push(`beat ${beat.id} is defined twice`);
		ids.add(beat.id);
	}

	// Beats are no longer the only thing that sets a flag — a trigger, a written
	// conversation and a card all do — so the list of writers is assembled across the
	// whole artifact rather than from the arc alone. A beat gated on a flag only a
	// trigger sets is perfectly good content, and reporting it would refuse it.
	const written = flagsWritten(artifact);

	for (const beat of arc.beats) {
		const site = artifact.sites[String(beat.siteId)];
		if (!site) {
			problems.push(`beat ${beat.id} is anchored to unauthored site ${beat.siteId}`);
			continue;
		}
		if (!site.npcs.some((npc) => npc.slot === beat.npcSlot))
			problems.push(
				`beat ${beat.id} is anchored to slot ${beat.npcSlot}, who is not in ${site.name}`,
			);

		// A requirement nothing can ever provide can never be satisfied, so the beat is
		// unreachable and so is everything gated behind it.
		for (const flag of unsatisfiableFlags(beat.requires, written)) {
			problems.push(`beat ${beat.id} waits on "${flag}", which nothing sets`);
		}
		if (flagsRead(asCondition(beat.requires)).has(beat.setsFlag))
			problems.push(`beat ${beat.id} waits on its own flag`);
	}

	// The first beat has to be openable with nothing done yet, or the story has no
	// way in at all. Asked by evaluating against a pristine world rather than by
	// looking for an empty requirement, because a condition can be satisfiable from
	// the start without being empty — `{ not: { flag: "x" } }` is true immediately,
	// and a check that only counted empty lists would refuse a perfectly playable arc.
	const opening = pristineState(artifact);
	if (
		arc.beats.length > 0 &&
		!arc.beats.some((beat) => evaluate(asCondition(beat.requires), opening))
	)
		problems.push("no beat can open first; every one waits on another");

	return problems;
}

/**
 * A world in which nothing has happened yet.
 *
 * Only used to ask whether a beat could open at the very start, so it needs nothing
 * from the artifact but its shape. Built through `createInitialState` rather than
 * by hand so that whatever a new world starts with — the twelve gold, the hour of
 * the morning — is what the question is asked against.
 */
function pristineState(artifact: ScenarioArtifact): GameState {
	return createInitialState(
		{ id: artifact.id, name: artifact.title, seed: artifact.seed, createdAt: "" },
		artifact.spawn,
	);
}
