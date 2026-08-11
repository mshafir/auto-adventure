import { render } from "ink";
import { logTelemetry } from "../../ai/telemetry.js";
import { clearTranscript, debugAi, setDebugAi } from "../../ai/transcript.js";
import { CONFIG, gatewayKey, hasGatewayKey } from "../../config.js";
import { packCatalogue } from "../../content/load.js";
import { tilePackCatalogue } from "../../content/tiles.js";
import { deleteSave, listSaves } from "../../persist/save-repo.js";
import { displaySettingsPath, readSettings, writeSettings } from "../../persist/settings.js";
import {
	type GenerationOutcome,
	generateScenario,
	polishScenario,
} from "../../scenario/generate.js";
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
	// Read once, here, rather than inside the config page. Resolving a tile pack means
	// reading a manifest, decoding an atlas and building two glyph tables, and the page
	// re-renders on every keypress — so doing it there would pay for all of them on each
	// arrow key. It is also the rule the render layer is built on: components take values.
	const tilePacks = tilePackCatalogue();
	const contentPacks = packCatalogue();
	const canUseModel = hasGatewayKey() && !CONFIG.noAi;
	const settings = readSettings();
	// A key in the environment outranks the settings file everywhere, so the page
	// that edits the file has to say when editing it would achieve nothing.
	const keyFromEnv = Boolean(process.env.AI_GATEWAY_API_KEY?.trim());

	let chosen: LaunchChoice | undefined;
	let requested: GenerateRequest | undefined;
	const instance = render(
		<Launcher
			saves={saves}
			scenarios={scenarios}
			canUseModel={canUseModel}
			options={{
				...(gatewayKey() ? { gatewayKey: gatewayKey() } : {}),
				...(keyFromEnv ? { keyFromEnv: true } : {}),
				...(settings.modelSet ? { modelSet: settings.modelSet } : {}),
				settingsPath: displaySettingsPath(),
				onSaveKey: (key) => {
					// Written here rather than in the component, which has to stay renderable
					// in a test with no home directory to write a key into — the same reason
					// deleting a save happens out here.
					writeSettings({ gatewayKey: key });
					if (!keyFromEnv) {
						// The AI SDK reads the environment and nothing else, so a key that has
						// just been typed only counts once it is put there. Clearing it has to
						// clear the environment too, or "forget the key" would forget it
						// everywhere except the place that matters until the next run.
						if (key) process.env.AI_GATEWAY_API_KEY = key;
						else delete process.env.AI_GATEWAY_API_KEY;
					}
					logger.info(key ? "gateway key saved" : "gateway key forgotten");
				},
				onChooseModel: (id) => {
					writeSettings({ modelSet: id });
					logger.info(`models set to "${id}"`);
				},
			}}
			context={{
				saves,
				baseWorldId: CONFIG.worldName,
				...(CONFIG.seedExplicit ? { configuredSeed: CONFIG.seed } : {}),
				noAi: CONFIG.noAi,
			}}
			{...(CONFIG.brief ? { initialBrief: CONFIG.brief } : {})}
			tilePacks={tilePacks}
			contentPacks={contentPacks}
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
	// The launcher has already saved this, but saving it and spending it are two
	// different things and only one of them is this run's business. Written again
	// here so the world about to be paid for is provably the one the price on the
	// config page described, even if something else edited settings in between.
	if (request.models) writeSettings({ modelSet: request.models });

	// Before the first call, or the first pass is the one exchange nobody can read.
	// Cleared as well as enabled: the launcher may have been round this loop already,
	// and a transcript that opens on the previous world's prompts is worse than none.
	if (request.debug) {
		clearTranscript();
		setDebugAi(true);
	}

	const startedAt = Date.now();
	const stop = new AbortController();
	// Recomputed here rather than passed down from `pickLaunch`: the key can be typed on the
	// options page during the same session, so the answer that matters is the one at the
	// moment the offer is made.
	const canUseModel = hasGatewayKey() && !CONFIG.noAi;

	const lines: string[] = [];
	let calls = 0;
	let title: string | undefined;
	let stopping = false;
	let outcome: GenerationOutcome | undefined;
	let dismiss: (() => void) | undefined;

	const columns = process.stdout.columns ?? 80;
	const rows = Math.max(12, (process.stdout.rows ?? 24) - 1);
	const depth = detectColorDepth();

	// Set while the world is being read back, so the screen stops offering a second pass
	// over the same faults and goes back to showing progress lines.
	let polishing = false;
	let polish: (() => void) | undefined;
	// Whether the review page is what should be on screen. Declared here rather than beside
	// the loop that owns it because `view` closes over it and is called long before that
	// loop is reached.
	let reviewing = false;

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
			done={reviewing && !polishing}
			{...(outcome?.verdict ? { verdict: outcome.verdict } : {})}
			debug={debugAi()}
			// Offered only when there is a model to ask and the pass has not already run. A
			// second reading of a world the reader has already passed on would be a call spent
			// to be told the same thing.
			{...(polish && canUseModel && !outcome?.verdict ? { onPolish: polish } : {})}
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

	/*
	 * Read before played, and mended before played if that is what the player wants.
	 *
	 * A loop rather than a single wait, because reading the world back is a *second* pass
	 * over it: it produces its own findings, which the player is owed a look at on the same
	 * terms as the first set. It goes round at most twice in practice — the offer is
	 * withdrawn once a reader has given a verdict, since a second reading of a world the
	 * reader has already passed on is a call spent to be told the same thing.
	 */
	reviewing = outcome.findings.length > 0;
	while (reviewing) {
		const next = await new Promise<"play" | "polish">((resolve) => {
			dismiss = () => resolve("play");
			polish = () => resolve("polish");
			draw();
		});
		dismiss = undefined;
		polish = undefined;
		if (next === "play") break;

		// Back to the progress screen while it works. The findings are still true, but a page
		// of faults with a spinner nowhere on it looks like a game that has stopped.
		polishing = true;
		lines.push("");
		draw();
		outcome = await polishScenario(outcome, {
			signal: stop.signal,
			onProgress: (message) => {
				lines.push(message);
				calls += 1;
				draw();
			},
		});
		calls = outcome.calls;
		polishing = false;
		// Shown even when it comes back clean, which is the whole reason `done` exists: a
		// world with nothing left wrong with it is the outcome most worth telling somebody
		// about, and it used to be the one case that said nothing at all.
		reviewing = true;
	}

	instance.unmount();
	logTelemetry();
	// Asked again rather than remembered from above: `outcome` has been replaced since, by a
	// pass that returns a whole new one, and the narrowing that came with the first answer
	// does not survive that.
	const playing = outcome.choice;
	if (!playing) return undefined;
	// The last thing before the world opens, so that a run which dies between here and the
	// first frame says where it got to rather than simply ending.
	logger.info(`starting the generated world "${playing.worldId}"`);
	return playing;
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
