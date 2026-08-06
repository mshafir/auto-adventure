import { render } from "ink";
import { AuthoringStopped, authorScenario } from "../../ai/author/author.js";
import { logTelemetry } from "../../ai/telemetry.js";
import { CONFIG, hasGatewayKey, resolveSeed } from "../../config.js";
import { listPacks } from "../../content/load.js";
import { listTilePacks } from "../../content/tiles.js";
import { deleteSave, listSaves } from "../../persist/save-repo.js";
import type { ScenarioArtifact } from "../../scenario/artifact.js";
import { listScenarios, loadScenario, verifyArtifact, writeScenario } from "../../scenario/repo.js";
import type { GenerateRequest, LaunchChoice } from "../../scenario/scenario.js";
import { hasErrors, validateArtifact } from "../../scenario/validate.js";
import { logger } from "../../utils/log.js";
import { detectColorDepth } from "../render/color.js";
import { GenerateProgress } from "./generate-progress.js";
import { Launcher } from "./launcher.js";

/**
 * Put the launcher up and wait for a decision.
 *
 * Rendered and unmounted before the game is built, so the two never share a
 * screen or an input handler. Resolves undefined when the player quits.
 */
export async function pickLaunch(): Promise<LaunchChoice | undefined> {
	const saves = listSaves();
	const scenarios = listScenarios();
	const canUseModel = hasGatewayKey() && !CONFIG.noAi;

	let chosen: LaunchChoice | undefined;
	let requested: GenerateRequest | undefined;
	const instance = render(
		<Launcher
			saves={saves}
			scenarios={scenarios}
			canUseModel={canUseModel}
			{...(canUseModel ? {} : { unavailableNote: liveUnavailableNote() })}
			context={{
				saves,
				baseWorldId: CONFIG.worldName,
				...(CONFIG.seedExplicit ? { configuredSeed: CONFIG.seed } : {}),
				noAi: CONFIG.noAi,
			}}
			{...(CONFIG.brief ? { initialBrief: CONFIG.brief } : {})}
			tilePacks={listTilePacks()}
			contentPacks={listPacks()}
			onChoose={(choice) => {
				chosen = choice;
			}}
			onGenerate={(request) => {
				requested = request;
			}}
			onDelete={(worldId) => {
				// Done here rather than in the component, which must stay renderable in a
				// test without a temporary home directory to delete things out of.
				if (deleteSave(worldId)) logger.info(`deleted save "${worldId}"`);
			}}
			onQuit={() => {
				chosen = undefined;
			}}
		/>,
		{ exitOnCtrlC: true },
	);

	await instance.waitUntilExit();
	// Generating happens here rather than inside the component, and only once the
	// launcher has unmounted: it takes minutes, it needs a screen of its own, and two Ink
	// apps sharing stdin would both act on every keypress.
	if (requested) return await generateAndLaunch(requested);
	if (!chosen) return undefined;

	// A scenario row only carries its id; the artifact itself is read here, where a
	// file that has gone missing or gone bad can still be reported rather than
	// starting a world with no content in it.
	if (chosen.flavour === "prebuilt" && !chosen.scenario) {
		const id = scenarioIdFor(chosen, scenarios, saves);
		const artifact = id ? loadScenario(id) : undefined;
		if (id && !artifact) {
			logger.error(`scenario "${id}" could not be read; not starting`);
			return undefined;
		}
		if (artifact) return { ...chosen, scenario: artifact, seed: artifact.seed };
	}
	return chosen;
}

/**
 * Write a world, showing the work, then hand it back as something to play.
 *
 * The expensive path, and the only one where the player waits: sixty-odd model calls for a
 * medium world. It runs here rather than inside the launcher because the launcher has to be
 * gone first — two Ink apps both hold stdin and would both act on every keypress — and
 * because a component that has to survive being unmounted mid-`await` is a component that
 * will eventually be unmounted mid-`await`.
 *
 * The result lands in `.scenarios` before the game starts, so the world can be played
 * again exactly. That is the whole difference between this and a live world: the same
 * authoring either way, but here it is kept.
 */
async function generateAndLaunch(request: GenerateRequest): Promise<LaunchChoice | undefined> {
	const id = freeScenarioId(request.brief.premise);
	// From the id, so the same name always names the same country — the rule the CLI
	// already follows, and what makes a run reproducible from its filename alone.
	const seed = resolveSeed(id);
	const startedAt = Date.now();
	const stop = new AbortController();

	const lines: string[] = [];
	let calls = 0;
	let title: string | undefined;
	let stopping = false;

	const columns = process.stdout.columns ?? 80;
	const rows = Math.max(12, (process.stdout.rows ?? 24) - 1);
	const depth = detectColorDepth();

	const view = (failure?: string) => (
		<GenerateProgress
			columns={columns}
			rows={rows}
			depth={depth}
			{...(title ? { title } : {})}
			lines={lines}
			calls={calls}
			startedAt={startedAt}
			stopping={stopping}
			{...(failure ? { failure } : {})}
			onStop={() => {
				if (stopping) return;
				stopping = true;
				stop.abort();
				draw();
			}}
		/>
	);

	const instance = render(view(), { exitOnCtrlC: true });
	const draw = () => instance.rerender(view());

	logger.info(`generating scenario "${id}" seed ${seed}, ${request.brief.duration ?? "medium"}`);

	let artifact: ScenarioArtifact | undefined;
	try {
		const result = await authorScenario({
			id,
			brief: request.brief,
			seed,
			signal: stop.signal,
			onProgress: (message) => {
				lines.push(message);
				// `calls` is not reported per-message, so it is inferred from the lore line
				// onward the same way the CLI's summary does — close enough for a progress
				// display and not worth threading a counter through five passes for.
				calls = lines.length;
				if (!title && message.startsWith("lore: ")) title = message.slice("lore: ".length);
				draw();
			},
		});
		calls = result.calls;
		artifact = {
			...result.artifact,
			...(request.tiles ? { tiles: request.tiles } : {}),
			...(request.pack ? { pack: request.pack } : {}),
			// Written only when it differs from the default, so an ordinary world's artifact
			// stays the shape every hand-written one already has.
			...(request.dayAndNight ? {} : { time: { enabled: false } }),
			...(request.liveInGame ? { liveInGame: true } : {}),
		};
	} catch (error) {
		if (error instanceof AuthoringStopped) {
			lines.push("stopped. nothing was written.");
		} else {
			logger.error("generating a scenario failed", error);
			lines.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		instance.rerender(view("Nothing was kept. Press ESC to go back to the shell."));
		await instance.waitUntilExit();
		logTelemetry();
		return undefined;
	}

	// Validated but not gated on. A finding here is a fault in *our* authoring passes, not
	// in something a player did, and refusing to start after four paid minutes would turn a
	// blemish into a total loss. Logged in full so it is still findable, and a scenario with
	// a warning in it is a playable scenario.
	for (const problem of verifyArtifact(artifact)) logger.warn(`generated ${id}: ${problem}`);
	const findings = validateArtifact(artifact);
	for (const finding of findings) {
		logger.warn(`generated ${id}: ${finding.severity} ${finding.message}`);
	}
	if (hasErrors(findings)) lines.push("finished, with faults noted in the log.");

	const path = writeScenario(artifact);
	logger.info(`wrote ${path} after ${calls} model calls`);
	lines.push(`kept in ${path}`);
	draw();
	instance.unmount();
	await instance.waitUntilExit();
	logTelemetry();

	return {
		worldId: id,
		seed: artifact.seed,
		flavour: "prebuilt",
		scenario: artifact,
		...(request.liveInGame ? { liveInGame: true } : {}),
	};
}

/**
 * A filename nothing else has taken, from what the player asked for.
 *
 * The premise makes a far better name than a counter does — `.scenarios` is a directory a
 * person reads — but two worlds asked for in the same words must not overwrite each other,
 * so a taken slug gets a number. Falls back to a fixed stem when there is no premise,
 * which is the unguided case.
 */
function freeScenarioId(premise: string | undefined): string {
	const taken = new Set(listScenarios().map((scenario) => scenario.id));
	const stem = slug(premise) || "a-world";
	if (!taken.has(stem)) return stem;
	for (let n = 2; ; n++) {
		const candidate = `${stem}-${n}`;
		if (!taken.has(candidate)) return candidate;
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

/**
 * Why a live world is not being offered.
 *
 * Two different reasons, and saying the wrong one is worse than saying nothing: a
 * player who set NO_AI themselves does not need to be told their key is missing,
 * and one whose key really is missing must not be left hunting for a setting they
 * never touched.
 */
function liveUnavailableNote(): string {
	if (CONFIG.noAi) return "NO_AI is set, so a live world is not on offer.";
	return "No AI_GATEWAY_API_KEY, so a live world is not on offer.";
}

/**
 * Which scenario a prebuilt choice refers to.
 *
 * A new scenario world takes its slot name from the scenario id, but a *resumed*
 * one has whatever slot it was given, so the save is what remembers.
 */
function scenarioIdFor(
	choice: LaunchChoice,
	scenarios: readonly { readonly id: string }[],
	saves: readonly { readonly worldId: string; readonly scenarioId?: string }[],
): string | undefined {
	const resumed = saves.find((save) => save.worldId === choice.worldId);
	if (resumed?.scenarioId) return resumed.scenarioId;
	return scenarios.find((scenario) => choice.worldId.startsWith(scenario.id))?.id;
}
