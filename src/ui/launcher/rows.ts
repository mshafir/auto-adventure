import { hashString } from "../../core/rand/hash.js";
import type { ScenarioBrief } from "../../core/world/brief.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { Flavour, LaunchChoice } from "../../scenario/scenario.js";

/**
 * The launcher's list, as data.
 *
 * Built and tested apart from the rendering, because the interesting parts —
 * which rows exist, what choosing one means, how a new world gets a slot that is
 * not already taken — are decisions rather than layout.
 */

export type LauncherRow =
	| { readonly kind: "header"; readonly label: string }
	| {
			readonly kind: "save";
			readonly label: string;
			readonly detail: string;
			readonly save: SaveSummary;
	  }
	| {
			readonly kind: "scenario";
			readonly label: string;
			readonly detail: string;
			readonly scenario: ScenarioSummary;
	  }
	| {
			readonly kind: "new";
			readonly label: string;
			readonly detail: string;
			readonly flavour: Flavour;
			/** Ask for a brief before launching. */
			readonly wantsBrief?: boolean;
	  };

export function isSelectable(row: LauncherRow): boolean {
	return row.kind !== "header";
}

export interface BuildRowsInput {
	readonly saves: readonly SaveSummary[];
	readonly scenarios: readonly ScenarioSummary[];
	/** Whether a model is available at all. Without one, `live` is not on offer. */
	readonly canUseModel: boolean;
}

export function buildRows(input: BuildRowsInput): LauncherRow[] {
	const rows: LauncherRow[] = [];

	if (input.saves.length > 0) {
		rows.push({ kind: "header", label: "Continue" });
		for (const save of input.saves) {
			rows.push({
				kind: "save",
				label: save.name,
				detail: save.scenarioId
					? `day ${save.day} · ${save.scenarioId}`
					: `day ${save.day} · ${save.at.x},${save.at.y}`,
				save,
			});
		}
	}

	if (input.scenarios.length > 0) {
		rows.push({ kind: "header", label: "Scenarios" });
		for (const scenario of input.scenarios) {
			rows.push({
				kind: "scenario",
				label: scenario.title,
				detail: scenario.blurb || `${scenario.siteCount} places`,
				scenario,
			});
		}
	}

	rows.push({ kind: "header", label: "New world" });
	if (input.canUseModel) {
		rows.push({
			kind: "new",
			label: "Briefed",
			detail: "say what it should be about",
			flavour: "live",
			wantsBrief: true,
		});
		rows.push({
			kind: "new",
			label: "Unguided",
			detail: "let the model invent a premise",
			flavour: "live",
		});
	}
	rows.push({
		kind: "new",
		label: "Without a model",
		detail: "procedural names and dialogue trees",
		flavour: "procedural",
	});

	return rows;
}

/** The first selectable row, or -1 if somehow there is none. */
export function firstSelectable(rows: readonly LauncherRow[]): number {
	return rows.findIndex(isSelectable);
}

/** Move the cursor, skipping headers and stopping at the ends. */
export function moveCursor(rows: readonly LauncherRow[], from: number, delta: -1 | 1): number {
	for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
		const row = rows[i];
		if (row && isSelectable(row)) return i;
	}
	return from;
}

/**
 * A save slot nobody is using.
 *
 * A new world must never land on top of an existing one. The launcher offers no
 * way to type a name, so the name is derived and then made unique — silently
 * overwriting somebody's world would be the single worst thing this screen could
 * do.
 */
export function freeWorldId(base: string, taken: readonly string[]): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const candidate = `${base}-${n}`;
		if (!used.has(candidate)) return candidate;
	}
	// A thousand worlds of the same name is not a case worth handling gracefully,
	// but it must still not collide.
	return `${base}-${Date.now()}`;
}

export interface ChoiceContext {
	readonly saves: readonly SaveSummary[];
	/** Slot name for a brand-new world, before uniquifying. */
	readonly baseWorldId: string;
	/** Seed for a brand-new world, when the environment named one. */
	readonly configuredSeed?: number;
	readonly noAi: boolean;
}

/**
 * What choosing a row means.
 *
 * Resuming does not record a flavour, because whether a model runs is a property
 * of *this run* rather than of the world — the same reason `NO_AI=1` has always
 * been per-invocation. The exception is a scenario world, which is prebuilt
 * inherently: its content is already written, so there is nothing for a model to
 * do even if one is available.
 */
export function choiceFor(row: LauncherRow, context: ChoiceContext): LaunchChoice | undefined {
	const taken = context.saves.map((save) => save.worldId);

	switch (row.kind) {
		case "header":
			return undefined;

		case "save":
			return {
				worldId: row.save.worldId,
				seed: row.save.seed,
				flavour: row.save.scenarioId ? "prebuilt" : context.noAi ? "procedural" : "live",
				mustExist: true,
			};

		case "scenario":
			return {
				worldId: freeWorldId(row.scenario.id, taken),
				// Replaced by the artifact's own seed once it is read; the artifact is
				// the only authority on that.
				seed: 0,
				flavour: "prebuilt",
			};

		case "new": {
			const worldId = freeWorldId(context.baseWorldId, taken);
			return {
				worldId,
				// A configured seed wins so `WORLD_SEED=hollowmoor` still means
				// something; otherwise it comes from the slot name, so two new worlds
				// are two different worlds rather than the same one twice.
				seed: context.configuredSeed ?? hashString(worldId),
				flavour: row.flavour,
			};
		}
	}
}

/** Attach a brief to a choice, for the briefed path. */
export function withBrief(choice: LaunchChoice, brief: ScenarioBrief | undefined): LaunchChoice {
	return brief ? { ...choice, brief } : choice;
}
