import { render } from "ink";
import { CONFIG, gatewayKey, hasGatewayKey } from "../../config.js";
import { deleteSave, listSaves } from "../../persist/save-repo.js";
import { displaySettingsPath, readSettings, writeSettings } from "../../persist/settings.js";
import { listScenarios, loadScenario } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { logger } from "../../utils/log.js";
import { Launcher } from "./launcher.js";

/**
 * Put the launcher up and wait for a decision.
 *
 * Rendered and unmounted before the game is built, so the two never share a
 * screen or an input handler. Resolves undefined when the player quits.
 *
 * There are exactly three ways in: continue a save, play a scenario that has been
 * written, or start a live procedural world. Worlds are no longer *made* from here —
 * authoring is a dev-time activity done by an agent driving the `craft` CLI, and its
 * output is a scenario directory that shows up in the list below like any other.
 */
export async function pickLaunch(): Promise<LaunchChoice | undefined> {
	const saves = listSaves();
	const scenarios = listScenarios();
	const canUseModel = hasGatewayKey() && !CONFIG.noAi;
	const settings = readSettings();
	// A key in the environment outranks the settings file everywhere, so the page
	// that edits the file has to say when editing it would achieve nothing.
	const keyFromEnv = Boolean(process.env.AI_GATEWAY_API_KEY?.trim());

	let chosen: LaunchChoice | undefined;
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
			onChoose={(choice) => {
				chosen = choice;
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
