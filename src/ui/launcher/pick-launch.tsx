import { render } from "ink";
import { logTelemetry } from "../../ai/telemetry.js";
import { CONFIG, hasGatewayKey } from "../../config.js";
import { listPacks } from "../../content/load.js";
import { listTilePacks } from "../../content/tiles.js";
import { deleteSave, listSaves } from "../../persist/save-repo.js";
import { type GenerationOutcome, generateScenario } from "../../scenario/generate.js";
import { listScenarios, loadScenario } from "../../scenario/repo.js";
import type { GenerateRequest, LaunchChoice } from "../../scenario/scenario.js";
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
 * Everything that decides anything lives in `generateScenario`; this draws it. The result
 * lands in `.scenarios` before the game starts, so the world can be played again exactly.
 */
async function generateAndLaunch(request: GenerateRequest): Promise<LaunchChoice | undefined> {
	const startedAt = Date.now();
	const stop = new AbortController();

	const lines: string[] = [];
	let calls = 0;
	let title: string | undefined;
	let stopping = false;
	let outcome: GenerationOutcome | undefined;
	let dismiss: (() => void) | undefined;

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
			{...(outcome?.findings.length ? { findings: outcome.findings } : {})}
			{...(outcome?.path ? { path: outcome.path } : {})}
			onDismiss={() => dismiss?.()}
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

	outcome = await generateScenario(request, {
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
	calls = outcome.calls;

	if (!outcome.choice) {
		lines.push(outcome.stopped ? "stopped. nothing was written." : `failed: ${outcome.failure}`);
		instance.rerender(view("Nothing was kept. Press Ctrl-C to go back to the shell."));
		await instance.waitUntilExit();
		logTelemetry();
		return undefined;
	}

	// Read before played, when there is anything to read. The screen this replaces filed
	// the findings in the log and told the player it had done so, which is the same as not
	// telling them: the log is a file they have no reason to know about.
	if (outcome.findings.length > 0) {
		await new Promise<void>((resolve) => {
			dismiss = resolve;
			draw();
		});
	}

	instance.unmount();
	logTelemetry();
	// The last thing before the world opens, so that a run which dies between here and the
	// first frame says where it got to rather than simply ending.
	logger.info(`starting the generated world "${outcome.choice.worldId}"`);
	return outcome.choice;
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
