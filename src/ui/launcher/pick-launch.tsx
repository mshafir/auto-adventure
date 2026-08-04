import { render } from "ink";
import { CONFIG, hasGatewayKey } from "../../config.js";
import { listSaves } from "../../persist/save-repo.js";
import { listScenarios, loadScenario } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { logger } from "../../utils/log.js";
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
			onChoose={(choice) => {
				chosen = choice;
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
