import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { DialogueTree } from "../ai/dialogue/tree.js";
import type { Scene } from "../core/rules/scene.js";
import { sceneEffectProblems } from "../core/rules/scene-check.js";
import { writeFileAtomic } from "../persist/save-repo.js";
import { logger } from "../utils/log.js";
import type { ScenarioArtifact } from "./artifact.js";
import { type Phase, phaseProblems } from "./phase.js";
import { ScenarioArtifactSchema } from "./schema.js";

/**
 * A scenario as a directory of small files.
 *
 * One file was fine while a scenario was written by a pipeline and read by a program. It is
 * the wrong shape for something an agent edits: every change was a rewrite of a
 * several-hundred-kilobyte blob, so a diff showed one enormous line and a review could not
 * tell a corrected sentence from a rebuilt world.
 *
 * Filenames are ids. `scenes/the-messenger-arrives.json` *is* the scene called
 * `the-messenger-arrives`, and a file whose contents disagree with its name is refused —
 * the same rule `verifyArtifact` already applies to site keys, and for the same reason: two
 * names for one thing is two things to keep in step by hand.
 */

/** Where each part of an artifact lives, relative to the scenario directory. */
const FILES = {
	scenario: "scenario.json",
	story: "story.md",
	sites: "world/sites.json",
	placements: "world/placements.json",
	terraform: "world/terraform.json",
} as const;

const DIRS = { phases: "phases", scenes: "scenes", trees: "trees" } as const;

export function readScenarioDir(dir: string): ScenarioArtifact | undefined {
	const head = readJson(join(dir, FILES.scenario));
	if (!head) return undefined;
	if (typeof head !== "object") {
		logger.warn(`scenario ${dir}: ${FILES.scenario} is not an object`);
		return undefined;
	}

	const sites = readJson(join(dir, FILES.sites)) ?? {};
	const placements = (readJson(join(dir, FILES.placements)) ?? {}) as Record<string, unknown>;
	const terraform = readJson(join(dir, FILES.terraform)) ?? [];

	const phases = readNamed<Phase>(dir, DIRS.phases);
	const scenes = readKeyed<Scene>(dir, DIRS.scenes);
	const trees = readKeyed<DialogueTree>(dir, DIRS.trees);
	if (!phases || !scenes || !trees) return undefined;

	const assembled = {
		...(head as Record<string, unknown>),
		sites,
		...placements,
		...(terraform && Array.isArray(terraform) && terraform.length > 0 ? { terraform } : {}),
		...(phases.length > 0 ? { phases } : {}),
		...(Object.keys(scenes).length > 0 ? { scenes } : {}),
		...(Object.keys(trees).length > 0 ? { trees } : {}),
	};

	const parsed = ScenarioArtifactSchema.safeParse(assembled);
	if (!parsed.success) {
		logger.warn(`scenario ${dir} failed validation: ${parsed.error.issues[0]?.message ?? "?"}`);
		return undefined;
	}
	const artifact = parsed.data as ScenarioArtifact;

	const problems = dirProblems(artifact, scenes, trees);
	if (problems.length > 0) {
		logger.warn(`scenario ${artifact.id} is inconsistent: ${problems.slice(0, 6).join("; ")}`);
		return undefined;
	}
	return artifact;
}

/**
 * What is wrong with a directory that parsed.
 *
 * Everything here is a silent failure at play time rather than a crash, which is why it is
 * checked at load: a scene that cannot be reached is a chapter that never turns, and a
 * phase diff over something nothing adds is a door that stays shut with nobody to blame.
 * `verifyArtifact`'s checks run alongside these — see `repo.ts`.
 */
export function dirProblems(
	artifact: ScenarioArtifact,
	scenes: Readonly<Record<string, Scene>>,
	trees: Readonly<Record<string, DialogueTree>>,
): string[] {
	const problems: string[] = [];

	for (const [name, scene] of Object.entries(scenes)) {
		if (scene.id !== name) problems.push(`scene file ${name} carries id "${scene.id}"`);
		problems.push(...sceneEffectProblems(scene));
	}
	for (const [name, tree] of Object.entries(trees)) {
		if (tree.npcId !== name) problems.push(`tree file ${name} carries npcId "${tree.npcId}"`);
	}

	for (const phase of artifact.phases ?? []) {
		// A later chapter with no condition would be in force from the first frame, which makes
		// it the base chapter written in the wrong place — and the world would open in it.
		if (!phase.when) problems.push(`phase ${phase.id} has no "when", so it is never not in force`);
	}

	// Scenes named by anything that could play one, checked against what is actually there.
	// A trigger pointing at a missing scene is the failure this whole rule exists to catch.
	const known = new Set(Object.keys(scenes));
	for (const phase of artifact.phases ?? []) {
		for (const [name, scene] of Object.entries(phase.scenes ?? {})) {
			if (scene) known.add(name);
		}
	}
	for (const [where, triggers] of triggerSources(artifact)) {
		for (const trigger of triggers) {
			for (const effect of trigger.effects) {
				if (effect.t !== "PlayScene") continue;
				if (!known.has(effect.id))
					problems.push(
						`${where} trigger "${trigger.id}" plays scene "${effect.id}", which is not here`,
					);
			}
		}
	}

	problems.push(...phaseProblems(baseContent(artifact), artifact.phases ?? []));
	return problems;
}

/** Every list of triggers in the artifact, with somewhere to point when one is wrong. */
function triggerSources(
	artifact: ScenarioArtifact,
): [string, readonly NonNullable<ScenarioArtifact["triggers"]>[number][]][] {
	const sources: [string, readonly NonNullable<ScenarioArtifact["triggers"]>[number][]][] = [
		["world", artifact.triggers ?? []],
	];
	for (const phase of artifact.phases ?? []) {
		sources.push([
			`phase ${phase.id}`,
			[...(phase.triggers?.add ?? []), ...(phase.triggers?.replace ?? [])],
		]);
	}
	return sources;
}

/** The base chapter, in the shape `phaseProblems` and `composeScenario` want it. */
export function baseContent(artifact: ScenarioArtifact) {
	return {
		sites: artifact.sites,
		placements: artifact.placements ?? [],
		signs: artifact.signs ?? [],
		barriers: artifact.barriers ?? [],
		triggers: artifact.triggers ?? [],
		terraform: artifact.terraform ?? [],
		trees: artifact.trees ?? {},
		scenes: artifact.scenes ?? {},
		...(artifact.arc ? { arc: artifact.arc } : {}),
	};
}

/**
 * Write an artifact out as a directory.
 *
 * The inverse of {@link readScenarioDir}, and tested as a round trip rather than against
 * expected file contents — what matters is that what goes out comes back, not which line a
 * field lands on.
 *
 * Files that would be empty are not written at all, and stale ones are removed: a scenario
 * whose second chapter has been deleted must not keep playing it because the file is still
 * on disk.
 */
export function writeScenarioDir(artifact: ScenarioArtifact, root: string): string {
	const dir = join(root, artifact.id);
	mkdirSync(join(dir, "world"), { recursive: true });

	const { sites, placements, signs, barriers, terraform, phases, scenes, trees, ...head } =
		artifact;

	writeJson(join(dir, FILES.scenario), head);
	writeJson(join(dir, FILES.sites), sites);
	writeJson(join(dir, FILES.placements), {
		...(placements?.length ? { placements } : {}),
		...(signs?.length ? { signs } : {}),
		...(barriers?.length ? { barriers } : {}),
	});
	writeJson(join(dir, FILES.terraform), terraform ?? []);

	// Numbered so the directory listing reads in story order, which is also the order they
	// compose in — `readScenarioDir` sorts by filename and the number is what makes that sort
	// mean something.
	writeDir(
		dir,
		DIRS.phases,
		(phases ?? []).map((phase, index) => [`${index + 2}-${phase.id}`, phase] as const),
	);
	writeDir(dir, DIRS.scenes, Object.entries(scenes ?? {}));
	writeDir(dir, DIRS.trees, Object.entries(trees ?? {}));

	return dir;
}

/** Every scenario directory under a root, by name. */
export function listScenarioDirs(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		logger.warn(`${path} is not valid JSON`, error);
		return undefined;
	}
}

/**
 * Read a directory of files keyed by their own basename.
 *
 * Returns undefined when a file is unreadable, rather than skipping it. A scenario missing
 * one conversation is a scenario with a character who has nothing to say, and starting it
 * anyway hands the player a fault that looks like bad writing.
 */
function readKeyed<T>(dir: string, sub: string): Record<string, T> | undefined {
	const out: Record<string, T> = {};
	for (const file of jsonFiles(join(dir, sub))) {
		const value = readJson(join(dir, sub, file));
		if (value === undefined) return undefined;
		out[basename(file, ".json")] = value as T;
	}
	return out;
}

/** Read a directory of files whose order matters, sorted by filename. */
function readNamed<T>(dir: string, sub: string): T[] | undefined {
	const out: T[] = [];
	for (const file of jsonFiles(join(dir, sub))) {
		const value = readJson(join(dir, sub, file));
		if (value === undefined) return undefined;
		out.push(value as T);
	}
	return out;
}

/**
 * The json files in a directory, in filename order.
 *
 * Sorted numerically where a name starts with digits, so `10-` comes after `9-` rather than
 * before it — phases compose in this order and a tenth chapter is not unthinkable.
 */
function jsonFiles(path: string): string[] {
	if (!existsSync(path)) return [];
	return readdirSync(path)
		.filter((name) => name.endsWith(".json"))
		.sort((a, b) => {
			const na = Number.parseInt(a, 10);
			const nb = Number.parseInt(b, 10);
			if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
			return na - nb || a.localeCompare(b);
		});
}

function writeJson(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function writeDir(
	dir: string,
	sub: string,
	entries: readonly (readonly [string, unknown])[],
): void {
	const path = join(dir, sub);
	// Removed and rebuilt rather than overwritten in place, so a phase or a conversation that
	// has been taken out of the artifact stops being played.
	rmSync(path, { recursive: true, force: true });
	if (entries.length === 0) return;
	mkdirSync(path, { recursive: true });
	for (const [name, value] of entries) writeJson(join(path, `${name}.json`), value);
}
