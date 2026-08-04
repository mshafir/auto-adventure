import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useState } from "react";
import { normalizeBrief, type ScenarioBrief } from "../../core/world/brief.js";
import type { SaveSummary } from "../../persist/save-repo.js";
import type { ScenarioSummary } from "../../scenario/repo.js";
import type { LaunchChoice } from "../../scenario/scenario.js";
import {
	buildRows,
	type ChoiceContext,
	choiceFor,
	firstSelectable,
	type LauncherRow,
	moveCursor,
	withBrief,
} from "./rows.js";
import { TextField } from "./text-field.js";

export interface LauncherProps {
	readonly saves: readonly SaveSummary[];
	readonly scenarios: readonly ScenarioSummary[];
	readonly canUseModel: boolean;
	/** Why a live world is not on offer, when it is not. */
	readonly unavailableNote?: string;
	readonly context: ChoiceContext;
	/** A brief from the environment, offered as a starting point. */
	readonly initialBrief?: ScenarioBrief;
	readonly onChoose: (choice: LaunchChoice) => void;
	readonly onQuit: () => void;
}

export function Launcher({
	saves,
	scenarios,
	canUseModel,
	unavailableNote,
	context,
	initialBrief,
	onChoose,
	onQuit,
}: LauncherProps) {
	const { exit } = useApp();
	const rows = useMemo(
		() => buildRows({ saves, scenarios, canUseModel }),
		[saves, scenarios, canUseModel],
	);
	const [cursor, setCursor] = useState(() => firstSelectable(rows));
	const [asking, setAsking] = useState(false);
	const [premise, setPremise] = useState(initialBrief?.premise ?? "");

	// Only one of the two input handlers is mounted at a time: the field owns the
	// keyboard while it is up, or arrow keys would move the list behind it.
	useInput(
		(input, key) => {
			if (key.escape || input === "q") {
				onQuit();
				exit();
				return;
			}
			if (key.upArrow || input === "k") {
				setCursor((at) => moveCursor(rows, at, -1));
				return;
			}
			if (key.downArrow || input === "j") {
				setCursor((at) => moveCursor(rows, at, 1));
				return;
			}
			if (!key.return && input !== " ") return;

			const row = rows[cursor];
			if (!row) return;
			if (row.kind === "new" && row.wantsBrief) {
				setAsking(true);
				return;
			}
			const choice = choiceFor(row, context);
			if (choice) {
				onChoose(choice);
				exit();
			}
		},
		{ isActive: !asking },
	);

	if (asking) {
		const row = rows[cursor];
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
						onSubmit={(value) => {
							if (!row) return;
							const choice = choiceFor(row, context);
							if (!choice) return;
							onChoose(withBrief(choice, normalizeBrief({ ...initialBrief, premise: value })));
							exit();
						}}
						onCancel={() => setAsking(false)}
					/>
				</Box>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			<Text bold color="cyan">
				auto-adventure
			</Text>
			<Box marginTop={1} flexDirection="column">
				{rows.map((row, index) => (
					<RowView key={rowKey(row, index)} row={row} selected={index === cursor} />
				))}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>{"↑↓ move · ENTER choose · Q quit"}</Text>
			</Box>
			{!canUseModel && unavailableNote ? <Text dimColor>{unavailableNote}</Text> : null}
		</Box>
	);
}

function rowKey(row: LauncherRow, index: number): string {
	return `${row.kind}:${row.kind === "header" ? row.label : row.label}:${index}`;
}

function RowView({ row, selected }: { row: LauncherRow; selected: boolean }) {
	if (row.kind === "header") {
		return (
			<Box marginTop={1}>
				<Text bold dimColor>
					{row.label}
				</Text>
			</Box>
		);
	}
	return (
		<Text color={selected ? "cyan" : undefined}>
			{selected ? "❯ " : "  "}
			{row.label}
			<Text dimColor>{`  ${row.detail}`}</Text>
		</Text>
	);
}
