import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioArtifact } from "../scenario/artifact.js";
import { dirProblems, readScenarioDir } from "../scenario/dir.js";
import type { Diff, Phase } from "../scenario/phase.js";
import { scenarioPath, scenarioRoot, verifyArtifact, writeScenario } from "../scenario/repo.js";
import { ScenarioArtifactSchema } from "../scenario/schema.js";
import { CraftError } from "./args.js";

/**
 * A scenario open for editing.
 *
 * The whole point of this type is the order of operations in {@link commit}: mutate in
 * memory, check, and only then write. A CLI whose failed call left a half-edited directory
 * behind would make every subsequent command's failure ambiguous — is the scenario broken
 * because of this call or the last one? — and an agent cannot bisect its own history.
 *
 * So a refused command is a no-op on disk, always, and the scenario in `.scenarios/` is
 * loadable at every moment between commands.
 */
export interface Workspace {
	readonly id: string;
	readonly dir: string;
	/** The artifact as it currently stands, including edits not yet written. */
	artifact: ScenarioArtifact;
}

export function openWorkspace(id: string): Workspace {
	const dir = scenarioPath(id);
	if (!existsSync(dir)) {
		throw new CraftError(
			`there is no scenario called "${id}" in ${scenarioRoot()} — "craft new ${id}" makes one`,
			2,
		);
	}
	const artifact = readScenarioDir(dir);
	if (!artifact) {
		throw new CraftError(
			`"${id}" could not be read; the warnings above say why. Fix the files or start again.`,
			2,
		);
	}
	return { id, dir, artifact };
}

/**
 * Write the edit, or refuse it and change nothing.
 *
 * The checks here are the *structural* ones — the schema, the files hanging together, the
 * content matching the world the seed generates. Deliberately not the whole of `craft check`:
 * a scenario mid-authoring is legitimately incomplete, with a beat whose conversation has yet
 * to be written and a town with nobody in it, and a CLI that refused every intermediate state
 * would make it impossible to build one a step at a time.
 *
 * The line is: refuse what could never be right, allow what is merely not finished.
 */
export function commit(workspace: Workspace, what: string): void {
	const problems = structuralProblems(workspace.artifact);
	if (problems.length > 0) {
		throw new CraftError(
			[
				`${what} would leave "${workspace.id}" broken, so nothing was written:`,
				...problems.map((problem) => `  ${problem}`),
			].join("\n"),
		);
	}
	writeScenario(workspace.artifact);
}

/**
 * What could never be right, whatever else is still to be written.
 *
 * `verifyArtifact` is the one that earns its keep here: a site id the seed does not produce
 * is a town that never gets its name, and nothing at runtime reports it. Catching that at the
 * call means the author finds out while they still remember what they asked for.
 */
export function structuralProblems(artifact: ScenarioArtifact): string[] {
	const parsed = ScenarioArtifactSchema.safeParse(artifact);
	if (!parsed.success) {
		return parsed.error.issues
			.slice(0, 6)
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
	}
	return [
		...verifyArtifact(artifact),
		...dirProblems(artifact, artifact.scenes ?? {}, artifact.trees ?? {}),
	];
}

/** Where a file for this scenario goes, for the commands that scaffold prose. */
export function filePath(workspace: Workspace, ...parts: string[]): string {
	return join(workspace.dir, ...parts);
}

/**
 * The chapter an edit belongs to, or undefined for the world as the player finds it.
 *
 * Every mutating verb takes `--phase`, and that one idea is what keeps this vocabulary from
 * doubling: there is no `craft phase place`, only `craft place --phase after-the-flood`.
 */
export function phaseOf(workspace: Workspace, id: string | undefined): Phase | undefined {
	if (id === undefined) return undefined;
	const phase = (workspace.artifact.phases ?? []).find((candidate) => candidate.id === id);
	if (!phase) {
		const known = (workspace.artifact.phases ?? []).map((candidate) => candidate.id);
		throw new CraftError(
			known.length > 0
				? `"${workspace.id}" has no chapter called "${id}" — it has ${known.join(", ")}`
				: `"${workspace.id}" has no chapters yet; "craft phase add" makes one`,
		);
	}
	return phase;
}

/** Replace a chapter in place, keeping its position, since chapters compose in order. */
export function replacePhase(workspace: Workspace, phase: Phase): void {
	workspace.artifact = {
		...workspace.artifact,
		phases: (workspace.artifact.phases ?? []).map((candidate) =>
			candidate.id === phase.id ? phase : candidate,
		),
	};
}

/**
 * Add something to the base world or to a chapter's `add` list, whichever was asked for.
 *
 * One helper rather than a branch in every verb, because the branch is identical each time
 * and getting it wrong in one place would put an item in the base world that the author
 * meant to appear only after the flood.
 */
export function addTo<K extends "placements" | "signs" | "barriers" | "triggers" | "terraform">(
	workspace: Workspace,
	phase: Phase | undefined,
	key: K,
	item: NonNullable<ScenarioArtifact[K]>[number],
): void {
	if (!phase) {
		const existing = (workspace.artifact[key] ?? []) as readonly unknown[];
		workspace.artifact = { ...workspace.artifact, [key]: [...existing, item] };
		return;
	}
	const diff: Diff<unknown> = phase[key] ?? {};
	replacePhase(workspace, {
		...phase,
		[key]: { ...diff, add: [...(diff.add ?? []), item] },
	} as Phase);
}

/** Whether an id is already taken in the base world or in any chapter. */
export function idTaken(
	artifact: ScenarioArtifact,
	key: "placements" | "signs" | "barriers" | "triggers" | "terraform",
	id: string,
): boolean {
	const base = (artifact[key] ?? []) as readonly { readonly id: string }[];
	if (base.some((item) => item.id === id)) return true;
	for (const phase of artifact.phases ?? []) {
		const added = (phase[key]?.add ?? []) as readonly { readonly id: string }[];
		if (added.some((item) => item.id === id)) return true;
	}
	return false;
}
