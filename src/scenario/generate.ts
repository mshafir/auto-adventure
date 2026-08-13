import {
	AuthoringStopped,
	type AuthorResult,
	authorScenario,
	writeTree,
} from "../ai/author/author.js";
import { polishArtifact } from "../ai/author/polish.js";
import { beginWorking } from "../ai/working-file.js";
import { resolveSeed } from "../config.js";
import { resolveOverride } from "../content/load.js";
import type { ScenarioBrief } from "../core/world/brief.js";
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
	/**
	 * A reader's one-sentence answer to "could a player follow this", once one has read it.
	 *
	 * Only ever set by the polish pass, which is the only thing that asks.
	 */
	readonly verdict?: string;
	/**
	 * The main-line beat that could not be settled. Nothing was written.
	 *
	 * The one fault that is not merely reported. Everything else here is a blemish on a world
	 * that still plays; this is a story that stops, and handing one to a player who has just
	 * paid four minutes for it — with nothing on the file to say so — is what the Continue list
	 * was quietly filling up with.
	 */
	readonly unplayable?: {
		readonly beat: string;
		readonly why: string;
		readonly tried: readonly string[];
	};
	/**
	 * The world that was written and not kept, so the player can take it anyway.
	 *
	 * Held rather than written: `path` and `choice` are absent precisely because nothing reached
	 * the disk, and this is what {@link acceptScenario} needs to change that.
	 */
	readonly held?: ScenarioArtifact;
}

/**
 * Read a written world back, fix what reading it found, and keep the result.
 *
 * Split out from {@link generateScenario} rather than folded into it because it is a
 * *second* decision, taken after the first has finished: the player has the findings in
 * front of them and chooses whether to spend more. Everything that decides anything is in
 * `polishArtifact`; this is the boundary that writes the answer back to disk, so the world
 * that gets played is the world that was kept.
 */
export async function polishScenario(
	outcome: GenerationOutcome,
	deps: PolishDeps = {},
): Promise<GenerationOutcome> {
	const choice = outcome.choice;
	const artifact = choice?.scenario;
	if (!choice || !artifact) return outcome;

	const polish = deps.polish ?? polishArtifact;
	const write = deps.write ?? writeScenario;

	let result: Awaited<ReturnType<typeof polishArtifact>>;
	try {
		result = await polish({
			artifact,
			findings: outcome.findings,
			writeTree,
			...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
			...(deps.signal ? { signal: deps.signal } : {}),
		});
	} catch (error) {
		// Never fatal. The world was already written, checked and kept; a polish that fell
		// over must leave the player with exactly what they had before they asked for it.
		logger.error(`polishing "${artifact.id}" failed`, error);
		return outcome;
	}

	for (const repair of result.repairs) logger.info(`polished ${artifact.id}: ${repair}`);
	const findings = [...result.findings].sort((a, b) => rank(a) - rank(b));
	for (const finding of findings) {
		logger.warn(`polished ${artifact.id}: ${finding.severity} ${finding.message}`);
	}

	// Written again only when something actually changed. Rewriting the file to record that
	// nothing happened would touch its timestamp and tell the player it had been edited.
	const path = result.artifact === artifact ? outcome.path : write(result.artifact);

	return {
		...outcome,
		...(path ? { path } : {}),
		findings,
		calls: outcome.calls + result.calls,
		...(result.verdict ? { verdict: result.verdict } : {}),
		choice: { ...choice, scenario: result.artifact },
	};
}

export interface PolishDeps {
	readonly onProgress?: (message: string) => void;
	readonly signal?: AbortSignal;
	readonly polish?: typeof polishArtifact;
	readonly write?: (artifact: ScenarioArtifact) => string;
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

	const id = freeScenarioId(request.brief, taken());
	// From the id, so the same name always names the same country — the rule the CLI already
	// follows, and what makes a run reproducible from its filename alone.
	//
	// A reseed breaks that property deliberately. The premise, the title, the tone, the packs and
	// the id are all the same on the second attempt; the *world* is the thing the player asked to
	// be given again, so the seed is salted with which attempt this is. A kept world is still
	// exactly reproducible — `artifact.seed` is authoritative and is what a save records — so
	// what is lost is only guessing a seed from a filename.
	const attempt = request.attempt ?? 1;
	const seed = resolveSeed(attempt > 1 ? `${id}#${attempt}` : id);
	// Opened here rather than by the caller, because here is where the id first exists and
	// the record is named after it. Closed by the caller, which is the only thing that knows
	// when the run is actually over — a polish pass afterwards belongs in the same record.
	beginWorking(id);
	logger.info(`generating scenario "${id}" seed ${seed}, ${request.brief.duration ?? "medium"}`);

	const packOverride = request.pack ? resolveOverride(request.pack) : undefined;

	let result: AuthorResult;
	try {
		result = await author({
			id,
			brief: request.brief,
			seed,
			// Read *before* authoring rather than attached after it. A pack has a recipe
			// fragment in it, and a world that is surveyed and plotted before its pack is
			// known has already decided everything the fragment had an opinion about.
			...(packOverride ? { pack: packOverride } : {}),
			...(request.pack ? { packName: request.pack } : {}),
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
		// Restated rather than left to the author, which also sets it. The author needs it
		// early, so the repair loop validates against the right catalogue; this is the
		// boundary's own guarantee that what was asked for is what was written, and it
		// holds even for an author that was injected and knows nothing about packs.
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

	// Nothing reaches the disk when the story does not play. The world is handed back in `held`
	// instead, the screen names the beat that could not be settled and what was tried, and the
	// player chooses between another attempt and taking this one anyway. Writing it regardless —
	// which is what this did — meant a world whose story stops at its second scene sat in the
	// Continue list looking exactly like one that works.
	if (result.unplayable) {
		logger.warn(
			`"${id}" was not kept: beat ${result.unplayable.beat} could not be settled (${result.unplayable.why})`,
		);
		return {
			findings,
			calls: result.calls,
			unplayable: result.unplayable,
			held: artifact,
		};
	}

	const path = write(artifact);
	logger.info(`wrote ${path} after ${result.calls} model calls`);

	return {
		path,
		findings,
		calls: result.calls,
		choice: playable(id, artifact, request),
	};
}

/**
 * Keep a world whose story stops, because the player asked for it.
 *
 * The only path by which an unsettled story reaches the disk, and it is a decision rather than a
 * fallback: everything is already paid for, the fault is named on the screen in front of them,
 * and a world that stops at its last beat is still most of a world. `unplayable` is deliberately
 * carried through, so the review screen after this still says what is wrong with it.
 */
export function acceptScenario(
	outcome: GenerationOutcome,
	deps: { readonly write?: (artifact: ScenarioArtifact) => string } = {},
): GenerationOutcome {
	const artifact = outcome.held;
	if (!artifact) return outcome;
	const write = deps.write ?? writeScenario;
	const path = write(artifact);
	logger.info(`kept "${artifact.id}" at the player's asking, story unsettled`);
	return {
		...outcome,
		path,
		choice: {
			worldId: artifact.id,
			seed: artifact.seed,
			flavour: "prebuilt",
			scenario: artifact,
			...(artifact.liveInGame ? { liveInGame: true } : {}),
		},
	};
}

function playable(
	id: string,
	artifact: ScenarioArtifact,
	request: GenerateRequest,
): NonNullable<GenerationOutcome["choice"]> {
	return {
		worldId: id,
		seed: artifact.seed,
		flavour: "prebuilt",
		scenario: artifact,
		...(request.liveInGame ? { liveInGame: true } : {}),
	};
}

/** Errors before warnings, so a truncated list shows the ones that matter. */
function rank(finding: Finding): number {
	return finding.severity === "error" ? 0 : 1;
}

/**
 * A filename nothing else has taken, from what the player asked for.
 *
 * The title first, because `.scenarios` is a directory a person reads and a shelf of book
 * names beats a list of pitches. The premise second, which is what every world written
 * before there was a title to give has. Two worlds asked for in the same words must not
 * overwrite each other, so a taken slug gets a number, and a brief with neither falls back
 * to a fixed stem.
 */
export function freeScenarioId(brief: ScenarioBrief | undefined, taken: readonly string[]): string {
	const already = new Set(taken);
	const stem = slug(brief?.title) || slug(brief?.premise) || "a-world";
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
