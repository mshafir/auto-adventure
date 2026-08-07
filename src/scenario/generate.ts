import { AuthoringStopped, type AuthorResult, authorScenario } from "../ai/author/author.js";
import { resolveSeed } from "../config.js";
import { logger } from "../utils/log.js";
import type { ScenarioArtifact } from "./artifact.js";
import { listScenarios, writeScenario } from "./repo.js";
import type { GenerateRequest, LaunchChoice } from "./scenario.js";
import type { Finding } from "./validate.js";

/**
 * Write a world to order, check it, keep it, and hand back something to play.
 *
 * Separate from the screen that shows it happening, and that separation is the point:
 * this is where the decisions live — what the world is called, what is wrong with it,
 * whether that is bad enough to matter — and none of them should need an Ink app and a
 * terminal to be tested. `pick-launch.tsx` is the forty lines that draw it.
 */

export interface GenerationOutcome {
	/** What to play. Absent when nothing was written. */
	readonly choice?: LaunchChoice;
	/** Where it was kept. Absent when nothing was written. */
	readonly path?: string;
	/**
	 * What is wrong with what was written, worst first.
	 *
	 * Reported rather than acted on. These are faults in *our* authoring passes, not in
	 * anything the player did, and refusing to start after several paid minutes would turn
	 * a blemish into a total loss — so a world with findings is still a world.
	 */
	readonly findings: readonly Finding[];
	/** The player pressed ESC. Nothing was written. */
	readonly stopped?: boolean;
	/** Something went wrong, in words. Nothing was written. */
	readonly failure?: string;
	readonly calls: number;
}

export interface GenerationDeps {
	readonly onProgress: (message: string) => void;
	readonly signal?: AbortSignal;
	/** Injected so the flow can be tested without spending several minutes and a key. */
	readonly author?: typeof authorScenario;
	readonly write?: (artifact: ScenarioArtifact) => string;
	readonly taken?: () => readonly string[];
}

export async function generateScenario(
	request: GenerateRequest,
	deps: GenerationDeps,
): Promise<GenerationOutcome> {
	const author = deps.author ?? authorScenario;
	const write = deps.write ?? writeScenario;
	const taken = deps.taken ?? (() => listScenarios().map((scenario) => scenario.id));

	const id = freeScenarioId(request.brief.premise, taken());
	// From the id, so the same name always names the same country — the rule the CLI
	// already follows, and what makes a run reproducible from its filename alone.
	const seed = resolveSeed(id);
	logger.info(`generating scenario "${id}" seed ${seed}, ${request.brief.duration ?? "medium"}`);

	let result: AuthorResult;
	try {
		result = await author({
			id,
			brief: request.brief,
			seed,
			...(deps.signal ? { signal: deps.signal } : {}),
			onProgress: deps.onProgress,
		});
	} catch (error) {
		if (error instanceof AuthoringStopped) {
			logger.info(`generation of "${id}" stopped; nothing was written`);
			return { stopped: true, findings: [], calls: 0 };
		}
		logger.error(`generating "${id}" failed`, error);
		return {
			failure: error instanceof Error ? error.message : String(error),
			findings: [],
			calls: 0,
		};
	}

	const artifact: ScenarioArtifact = {
		...result.artifact,
		...(request.tiles ? { tiles: request.tiles } : {}),
		...(request.pack ? { pack: request.pack } : {}),
		// Written only when they differ from the default, so an ordinary generated world's
		// artifact stays the shape every hand-written one already has.
		...(request.dayAndNight ? {} : { time: { enabled: false } }),
		...(request.liveInGame ? { liveInGame: true } : {}),
	};

	// Whatever the repair pass could not fix, reported in its own words — structural
	// problems included, since those are what it was judged on too. Asking again here
	// would mean generating the whole bounded world a second time to be told the same
	// thing, and would be a second opinion that could disagree with the one the repairs
	// were weighed against.
	const findings: Finding[] = [...result.findings];
	findings.sort((a, b) => rank(a) - rank(b));
	for (const finding of findings) {
		logger.warn(`generated ${id}: ${finding.severity} ${finding.message}`);
	}

	const path = write(artifact);
	logger.info(`wrote ${path} after ${result.calls} model calls`);

	return {
		path,
		findings,
		calls: result.calls,
		choice: {
			worldId: id,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
			...(request.liveInGame ? { liveInGame: true } : {}),
		},
	};
}

/** Errors before warnings, so a truncated list shows the ones that matter. */
function rank(finding: Finding): number {
	return finding.severity === "error" ? 0 : 1;
}

/**
 * A filename nothing else has taken, from what the player asked for.
 *
 * The premise makes a far better name than a counter does — `.scenarios` is a directory a
 * person reads — but two worlds asked for in the same words must not overwrite each other,
 * so a taken slug gets a number. Falls back to a fixed stem when there is no premise,
 * which is the case where the model was left to invent one.
 */
export function freeScenarioId(premise: string | undefined, taken: readonly string[]): string {
	const already = new Set(taken);
	const stem = slug(premise) || "a-world";
	if (!already.has(stem)) return stem;
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}`;
		if (!already.has(candidate)) return candidate;
	}
}

/** The scenario id rules, which are also the filename rules: lower-case, digits, dashes. */
function slug(text: string | undefined): string {
	return (text ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.split("-")
		.slice(0, 5)
		.join("-")
		.slice(0, 48)
		.replace(/-+$/g, "");
}
