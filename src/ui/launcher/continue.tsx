import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SaveSummary } from "../../persist/save-repo.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { formatDate, formatWhen } from "./when.js";

/**
 * The worlds you can go back to, as cards.
 *
 * The old list gave a save one line: its name, the day, and either a scenario id or
 * a coordinate. Which is nearly useless for the actual question — *which of these
 * was I playing* — because the answer is almost always "the one I touched most
 * recently", and nothing on screen said when that was.
 *
 * So each card says when. Last played in words ("yesterday"), because a wall-clock
 * timestamp makes the reader do the subtraction; made as a date, because two
 * relative times side by side read as the same fact twice.
 *
 * And a way to throw one away, which there has never been. Saves accumulate — every
 * unguided world tried for five minutes is a permanent row — and the only remedy
 * was knowing where the game keeps its files.
 */

/** The `paddingX` on every page here, taken off before anything is wrapped. */
const PADDING = 4;

export interface ContinueProps {
	readonly saves: readonly SaveSummary[];
	readonly columns: number;
	readonly now: number;
	readonly onResume: (save: SaveSummary) => void;
	readonly onDelete: (save: SaveSummary) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function Continue({
	saves,
	columns,
	now,
	onResume,
	onDelete,
	onBack,
	isActive = true,
}: ContinueProps) {
	const [confirming, setConfirming] = useState<SaveSummary | undefined>(undefined);

	// While the question is up it owns the keyboard, or `y` would also be a
	// keystroke in the list behind it.
	useInput(
		(input, key) => {
			if (!confirming) return;
			if (input === "y" || input === "Y") {
				onDelete(confirming);
				setConfirming(undefined);
				return;
			}
			if (key.escape || input === "n" || input === "N" || key.return) setConfirming(undefined);
		},
		{ isActive: isActive && confirming !== undefined },
	);

	if (saves.length === 0) {
		return (
			<Box flexDirection="column" paddingX={2} paddingY={1}>
				<Text bold color="cyan">
					Continue
				</Text>
				<Box marginY={1}>
					<Text dimColor>There are no worlds to go back to yet.</Text>
				</Box>
				<Chooser
					items={[{ id: "back", label: "Back" }]}
					isActive={isActive}
					onBack={onBack}
					onChoose={onBack}
				/>
			</Box>
		);
	}

	const items: ChoiceItem[] = saves.map((save) => ({
		id: save.worldId,
		label: save.name,
		detail: describe(save, now),
		...(save.scenarioId ? { body: `from the scenario "${save.scenarioId}"` } : {}),
	}));

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Continue
				</Text>
			</Box>

			<Chooser
				items={items}
				width={columns - PADDING}
				isActive={isActive && confirming === undefined}
				onBack={onBack}
				onChoose={(item) => {
					const save = saves.find((candidate) => candidate.worldId === item.id);
					if (save) onResume(save);
				}}
				onKey={(input, item) => {
					if (input !== "d" && input !== "D") return false;
					const save = saves.find((candidate) => candidate.worldId === item?.id);
					// Asked, never done. A world is hours of play and there is no undo.
					if (save) setConfirming(save);
					return true;
				}}
			/>

			{confirming ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color="yellow" wrap="truncate">
						{`Delete "${confirming.name}"? It is gone for good.`}
					</Text>
					<Text dimColor>{"Y to delete · anything else to keep it"}</Text>
				</Box>
			) : (
				<Text dimColor>{"↑↓ move · ENTER resume · D delete · ESC back"}</Text>
			)}
		</Box>
	);
}

/**
 * One line about a world: how far in, where, and when it was last touched.
 *
 * Built as a list and joined, so a save with no `createdAt` — one written before the
 * field was surfaced — simply has one fewer part rather than a gap with a separator
 * on either side of it.
 */
export function describe(save: SaveSummary, now: number): string {
	const made = formatDate(save.createdAt);
	return [
		`day ${save.day}`,
		`at ${save.at.x},${save.at.y}`,
		`played ${formatWhen(save.playedAt, now)}`,
		...(made ? [`made ${made}`] : []),
	].join(" · ");
}
