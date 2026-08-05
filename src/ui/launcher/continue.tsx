import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { SaveSummary } from "../../persist/save-repo.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	type Direction,
	GAP,
	gridLayout,
	gridWindow,
	moveInGrid,
} from "./grid.js";
import { formatDate, formatWhen } from "./when.js";

/**
 * The worlds you can go back to, as a grid of cards.
 *
 * A list was wrong twice over. It gave a save one line — name, day, and either a
 * scenario id or a coordinate — which is nearly useless for the actual question,
 * *which of these was I playing*, since the answer is almost always "the one I
 * touched most recently" and nothing on screen said when that was. And it ran off
 * the bottom with no way to scroll, so past a dozen worlds the older half simply
 * could not be reached.
 *
 * Cards fix both. Each has room to say when it was last played in words
 * ("yesterday", because a wall-clock timestamp makes the reader do the
 * subtraction) and when it was made as a date (because two relative times side by
 * side read as the same fact twice). Laid out in as many columns as the terminal
 * allows, they show three or four times as many worlds in the same space, and what
 * still does not fit scrolls by whole rows.
 *
 * And a way to throw one away, which there has never been. Saves accumulate — every
 * unguided world tried for five minutes is a permanent card — and the only remedy
 * was knowing where the game keeps its files.
 */

export interface ContinueProps {
	readonly saves: readonly SaveSummary[];
	readonly columns: number;
	readonly rows: number;
	readonly now: number;
	readonly onResume: (save: SaveSummary) => void;
	readonly onDelete: (save: SaveSummary) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

/** The heading, the blank under it, and the footer. */
const PAGE_CHROME = 3;

export function Continue({
	saves,
	columns,
	rows,
	now,
	onResume,
	onDelete,
	onBack,
	isActive = true,
}: ContinueProps) {
	const [cursor, setCursor] = useState(0);
	const [confirming, setConfirming] = useState<SaveSummary | undefined>(undefined);

	const inner = Math.max(CARD_WIDTH, columns - FRAME_CHROME - 4);
	const layout = gridLayout(inner, Math.max(CARD_HEIGHT, rows - FRAME_CHROME - PAGE_CHROME));
	// Clamped rather than stored back, so deleting a card cannot leave the cursor
	// pointing past the end of the list.
	const at = Math.min(cursor, Math.max(0, saves.length - 1));
	const view = gridWindow(saves.length, layout, at);

	useInput(
		(input, key) => {
			// While the question is up it owns the keyboard, or `y` would also be a
			// keystroke in the grid behind it — and ENTER would answer the question and
			// start the world in the same press.
			if (confirming) {
				if (input === "y" || input === "Y") {
					onDelete(confirming);
					setConfirming(undefined);
					return;
				}
				if (key.escape || key.return || input === "n" || input === "N") setConfirming(undefined);
				return;
			}

			if (key.escape) {
				onBack();
				return;
			}
			if (input === "d" || input === "D") {
				// Asked, never done. A world is hours of play and there is no undo.
				const save = saves[at];
				if (save) setConfirming(save);
				return;
			}
			const direction = directionOf(input, key);
			if (direction) {
				setCursor(moveInGrid(saves.length, layout.columns, at, direction));
				return;
			}
			if (!key.return && input !== " ") return;
			const save = saves[at];
			if (save) onResume(save);
		},
		{ isActive },
	);

	if (saves.length === 0) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Text bold color="cyan">
					Continue
				</Text>
				<Box flexGrow={1} marginTop={1}>
					<Text dimColor>There are no worlds to go back to yet.</Text>
				</Box>
				<Text dimColor>{"ESC back"}</Text>
			</Frame>
		);
	}

	const shown = saves.slice(view.start, view.end);

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					Continue
				</Text>
				<Text dimColor>{`  ${saves.length === 1 ? "1 world" : `${saves.length} worlds`}`}</Text>
				{view.scrolled ? (
					<Text dimColor>{`  ·  showing ${view.start + 1}-${view.end}`}</Text>
				) : null}
			</Box>

			<Box flexGrow={1} flexDirection="column">
				{chunk(shown, layout.columns).map((row, rowIndex) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a row of cards is positional
					<Box key={rowIndex} flexDirection="row">
						{row.map((save, columnIndex) => (
							<Card
								key={save.worldId}
								save={save}
								now={now}
								width={layout.cardWidth}
								last={columnIndex === row.length - 1}
								selected={view.start + rowIndex * layout.columns + columnIndex === at}
							/>
						))}
					</Box>
				))}
			</Box>

			{confirming ? (
				<>
					<Text color="yellow" wrap="truncate">
						{`Delete "${confirming.name}"? It is gone for good.`}
					</Text>
					<Text dimColor wrap="truncate">
						{"Y to delete · anything else to keep it"}
					</Text>
				</>
			) : (
				<Text dimColor wrap="truncate">
					{"↑↓←→ move · ENTER resume · D delete · ESC back"}
				</Text>
			)}
		</Frame>
	);
}

/**
 * One world, in a box.
 *
 * Four lines, and the same four whatever the world is: name, the one thing that
 * places it, how far in it is, and when it was last touched. A grid whose boxes are
 * different heights reads as a rendering fault, so a world with nothing to put on
 * the second line gets a blank rather than a shorter card.
 *
 * The second line is a scenario name where there is one and the date the world was
 * made where there is not. For a scenario world the scenario is the more
 * identifying of the two — three worlds started from the same file on the same
 * afternoon are told apart by everything except their date.
 */
function Card({
	save,
	now,
	width,
	selected,
	last,
}: {
	save: SaveSummary;
	now: number;
	width: number;
	selected: boolean;
	last: boolean;
}) {
	const made = formatDate(save.createdAt);
	return (
		<Box
			flexDirection="column"
			width={width}
			height={CARD_HEIGHT}
			flexShrink={0}
			marginRight={last ? 0 : GAP}
			borderStyle={selected ? "bold" : "round"}
			borderColor={selected ? "cyan" : "gray"}
			paddingX={1}
		>
			<Text bold={selected} color={selected ? "cyan" : undefined} wrap="truncate">
				{save.name}
			</Text>
			<Text dimColor wrap="truncate">
				{save.scenarioId ?? (made ? `made ${made}` : " ")}
			</Text>
			<Text color="gray" wrap="truncate">
				{`day ${save.day} · at ${save.at.x},${save.at.y}`}
			</Text>
			<Text color={selected ? "white" : "gray"} wrap="truncate">
				{`played ${formatWhen(save.playedAt, now)}`}
			</Text>
		</Box>
	);
}

/** Arrow keys, and the vi keys the rest of the launcher already answers to. */
function directionOf(input: string, key: Record<string, unknown>): Direction | undefined {
	if (key.leftArrow || input === "h") return "left";
	if (key.rightArrow || input === "l") return "right";
	if (key.upArrow || input === "k") return "up";
	if (key.downArrow || input === "j") return "down";
	return undefined;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
	return out;
}
