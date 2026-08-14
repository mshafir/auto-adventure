import { useApp, useStdout } from "ink";
import { useState } from "react";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { detectColorDepth } from "../render/color.js";
import { type ChoiceContext, choiceFor } from "./choice.js";
import { Continue } from "./continue.js";
import { NewWorld } from "./new-world.js";
import { Options } from "./options.js";
import { Title } from "./title.js";

/**
 * The launcher, as four pages rather than one list.
 *
 * The old screen put every question on one scrolling list under headings —
 * Continue, Scenarios, New world — which meant the first thing a player saw was
 * every decision at once, and none of them explained. Splitting it costs a keypress
 * and buys room: the choices get a paragraph each, the saves get a timestamp and a
 * way to be deleted, and the title screen gets to be a title screen.
 *
 * ESC always goes back one page, and back from the front page is quitting. That is
 * the only navigation rule, and it is why each page is mounted alone: `useInput`
 * handlers all fire, so two pages on screen would both act on every arrow key.
 *
 * Three of these pages end in a `LaunchChoice`, and there is no fourth. Worlds are not
 * made from here: authoring is a dev-time activity done by an agent driving the `craft`
 * CLI, and what it produces is a directory in `.scenarios/` that the New world page lists
 * like any other. What this screen offers is a choice between things that already exist.
 *
 * Options ends in nothing at all, which makes it the odd one out. It changes the machine
 * rather than the run, so coming back from it lands on the title screen with the rest of
 * the launcher having quietly changed its mind about what is on offer — which is the
 * whole point of it being reachable from the front door.
 */

type Page = "title" | "new" | "continue" | "options";

/**
 * The settings page's whole dependency on the disk, passed in.
 *
 * Reading and writing the key happens in `pickLaunch`, not here, for the same
 * reason deleting a save does: this component has to stay renderable in a test
 * with no home directory to write a key into.
 */
export interface OptionsBinding {
	readonly gatewayKey?: string;
	readonly keyFromEnv?: boolean;
	readonly modelSet?: string;
	readonly settingsPath: string;
	/** An empty string means forget it. */
	readonly onSaveKey: (key: string) => void;
	readonly onChooseModel: (id: string) => void;
}

export interface LauncherProps {
	readonly saves: readonly SaveSummary[];
	readonly scenarios: readonly ScenarioSummary[];
	readonly canUseModel: boolean;
	/** Why a live world is not on offer, when it is not. */
	readonly unavailableNote?: string;
	/** Everything the Options page needs, and what it does with an answer. */
	readonly options?: OptionsBinding;
	readonly context: ChoiceContext;
	/**
	 * Wall-clock, for the "last played" line. Passed in so the page is a function of
	 * its inputs and a test does not have to freeze the clock.
	 */
	readonly now?: number;
	readonly onChoose: (choice: LaunchChoice) => void;
	readonly onDelete?: (worldId: string) => void;
	readonly onQuit: () => void;
}

export function Launcher({
	saves,
	scenarios,
	canUseModel,
	unavailableNote,
	options,
	context,
	now = Date.now(),
	onChoose,
	onDelete,
	onQuit,
}: LauncherProps) {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [page, setPage] = useState<Page>("title");
	// Deleting takes a world off this page without the launcher restarting, so the
	// list it renders from is state rather than the prop.
	const [worlds, setWorlds] = useState(saves);
	// The key and the model are state for the same reason the world list is: both
	// can change without the launcher restarting, and every page downstream of the
	// title screen asks a different question once they do.
	const [key, setKey] = useState(options?.gatewayKey);
	const [modelSet, setModelSet] = useState(options?.modelSet);
	const columns = stdout.columns ?? 80;
	// One row short of the terminal, the same rule the game itself follows: Ink
	// updates incrementally only while its output is *shorter* than the window, and
	// at exactly the window height it clears the screen on every keypress.
	const rows = Math.max(12, (stdout.rows ?? 24) - 1);
	const depth = detectColorDepth();

	// Rebuilt from the live list rather than taken from the prop, so a slot freed by
	// a delete is one a new world can immediately be given.
	const here: ChoiceContext = { ...context, saves: worlds };

	// A key added on the options page makes a live world possible without the
	// launcher restarting — so this is the prop only until somebody changes it.
	// `context.noAi` still wins: NO_AI is a decision, not a missing dependency.
	const modelUsable = options ? Boolean(key) && !context.noAi : canUseModel;
	const note = modelUsable ? undefined : (unavailableNote ?? liveUnavailable(context.noAi));

	const take = (choice: LaunchChoice) => {
		onChoose(choice);
		exit();
	};

	const quit = () => {
		onQuit();
		exit();
	};

	if (page === "options" && options) {
		return (
			<Options
				columns={columns}
				rows={rows}
				depth={depth}
				{...(key ? { gatewayKey: key } : {})}
				{...(options.keyFromEnv ? { keyFromEnv: true } : {})}
				{...(modelSet ? { modelSet } : {})}
				settingsPath={options.settingsPath}
				onSaveKey={(next) => {
					options.onSaveKey(next);
					setKey(next || undefined);
				}}
				onChooseModel={(id) => {
					options.onChooseModel(id);
					setModelSet(id);
				}}
				onBack={() => setPage("title")}
			/>
		);
	}

	if (page === "continue") {
		return (
			<Continue
				saves={worlds}
				columns={columns}
				rows={rows}
				now={now}
				onResume={(save) => take(choiceFor({ kind: "save", save }, here))}
				onDelete={(save) => {
					onDelete?.(save.worldId);
					setWorlds((current) => current.filter((each) => each.worldId !== save.worldId));
				}}
				onBack={() => setPage("title")}
			/>
		);
	}

	if (page === "new") {
		return (
			<NewWorld
				scenarios={scenarios}
				columns={columns}
				rows={rows}
				depth={depth}
				canUseModel={modelUsable}
				{...(note ? { unavailableNote: note } : {})}
				onScenario={(scenario) => take(choiceFor({ kind: "scenario", scenario }, here))}
				onUnwritten={(flavour) => take(choiceFor({ kind: "new", flavour }, here))}
				onBack={() => setPage("title")}
			/>
		);
	}

	return (
		<Title
			columns={columns}
			rows={rows}
			depth={depth}
			saveCount={worlds.length}
			canUseModel={modelUsable}
			onNew={() => setPage("new")}
			onContinue={() => setPage("continue")}
			{...(options ? { onOptions: () => setPage("options") } : {})}
			onQuit={quit}
		/>
	);
}

/**
 * Why a live world is not being offered.
 *
 * Two different reasons, and saying the wrong one is worse than saying nothing: a
 * player who set NO_AI themselves does not need to be told their key is missing,
 * and one whose key really is missing must not be left hunting for a setting they
 * never touched. It points at the Options page now rather than at a variable,
 * because there is a screen to point at.
 */
function liveUnavailable(noAi: boolean | undefined): string {
	if (noAi) return "NO_AI is set, so a live world is not on offer.";
	return "No AI gateway key yet, so a live world is not on offer. Options, on the title screen, is where it goes.";
}
