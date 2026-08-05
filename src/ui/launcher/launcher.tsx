import { Box, Text, useApp, useStdout } from "ink";
import { useState } from "react";
import { normalizeBrief, type ScenarioBrief } from "../../core/world/brief.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import { type ChoiceContext, choiceFor, withBrief } from "./choice.js";
import { Continue } from "./continue.js";
import { type NewChoice, NewWorld, ScenarioList } from "./new-world.js";
import { TextField } from "./text-field.js";
import { Title } from "./title.js";

/**
 * The launcher, as four pages rather than one list.
 *
 * The old screen put every question on one scrolling list under headings —
 * Continue, Scenarios, New world — which meant the first thing a player saw was
 * every decision at once, and none of them explained. Splitting it costs a keypress
 * and buys room: the modes get a paragraph each, the saves get a timestamp and a
 * way to be deleted, and the title screen gets to be a title screen.
 *
 * ESC always goes back one page, and back from the front page is quitting. That is
 * the only navigation rule, and it is why each page is mounted alone: `useInput`
 * handlers all fire, so two pages on screen would both act on every arrow key.
 */

type Page = "title" | "new" | "scenarios" | "continue";

export interface LauncherProps {
	readonly saves: readonly SaveSummary[];
	readonly scenarios: readonly ScenarioSummary[];
	readonly canUseModel: boolean;
	/** Why a live world is not on offer, when it is not. */
	readonly unavailableNote?: string;
	readonly context: ChoiceContext;
	/** A brief from the environment, offered as a starting point. */
	readonly initialBrief?: ScenarioBrief;
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
	context,
	initialBrief,
	now = Date.now(),
	onChoose,
	onDelete,
	onQuit,
}: LauncherProps) {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const [page, setPage] = useState<Page>("title");
	const [asking, setAsking] = useState(false);
	const [premise, setPremise] = useState(initialBrief?.premise ?? "");
	// Deleting takes a world off this page without the launcher restarting, so the
	// list it renders from is state rather than the prop.
	const [worlds, setWorlds] = useState(saves);
	const columns = stdout.columns ?? 80;

	// Rebuilt from the live list rather than taken from the prop, so a slot freed by
	// a delete is one a new world can immediately be given.
	const here: ChoiceContext = { ...context, saves: worlds };

	const take = (choice: LaunchChoice) => {
		onChoose(choice);
		exit();
	};

	const quit = () => {
		onQuit();
		exit();
	};

	if (asking) {
		return (
			<Box flexDirection="column" paddingX={2} paddingY={1}>
				<Text bold>What should this world be about?</Text>
				<Text dimColor>
					A premise, a setting, a story — a sentence is plenty. ENTER to begin, ESC to go back.
				</Text>
				<Box marginTop={1}>
					<TextField
						value={premise}
						onChange={setPremise}
						placeholder="a drowned archipelago run by debt-collectors"
						onSubmit={(value) =>
							take(
								withBrief(
									choiceFor({ kind: "new", flavour: "live" }, here),
									normalizeBrief({ ...initialBrief, premise: value }),
								),
							)
						}
						onCancel={() => setAsking(false)}
					/>
				</Box>
			</Box>
		);
	}

	if (page === "continue") {
		return (
			<Continue
				saves={worlds}
				columns={columns}
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

	if (page === "scenarios") {
		return (
			<ScenarioList
				scenarios={scenarios}
				columns={columns}
				onChoose={(scenario) => take(choiceFor({ kind: "scenario", scenario }, here))}
				onBack={() => setPage("new")}
			/>
		);
	}

	if (page === "new") {
		return (
			<NewWorld
				scenarios={scenarios}
				columns={columns}
				canUseModel={canUseModel}
				{...(unavailableNote ? { unavailableNote } : {})}
				onScenarios={() => setPage("scenarios")}
				onStart={(choice: NewChoice) => {
					if (choice === "briefed") {
						setAsking(true);
						return;
					}
					take(
						choiceFor(
							{ kind: "new", flavour: choice === "unguided" ? "live" : "procedural" },
							here,
						),
					);
				}}
				onBack={() => setPage("title")}
			/>
		);
	}

	return (
		<Title
			columns={columns}
			saveCount={worlds.length}
			onNew={() => setPage("new")}
			onContinue={() => setPage("continue")}
			onQuit={quit}
		/>
	);
}
