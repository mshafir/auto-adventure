import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MACRO, macroSite } from "../core/world/macro.js";
import { saveRoot, writeFileAtomic } from "../persist/save-repo.js";
import { logger } from "../utils/log.js";
import type { ScenarioArtifact } from "./artifact.js";
import { ScenarioArtifactSchema } from "./schema.js";

export function scenarioRoot(): string {
	return join(saveRoot(), "scenarios");
}

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
 * missing, unparseable, a shape from a future build, or internally inconsistent.
 * A bad scenario must not stop the launcher from listing the good ones.
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
	return artifact;
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
			const site = macroSite(artifact.seed, mx, my);
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

	// Report a handful rather than a wall: if the seed is wrong every site is
	// wrong, and the first few say so just as well.
	return problems.slice(0, 6);
}
