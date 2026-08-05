import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { wrapToLines } from "../render/text.js";

/**
 * A list you move a cursor down and pick from.
 *
 * Every page of the launcher is one of these, so the keys are decided once: up and
 * down (or `k` and `j`) move, ENTER and SPACE choose, ESC goes back. A page that
 * spelled its own would be a page where ESC one day did something else.
 *
 * The cursor lives here rather than in the page, which is what makes going back and
 * forward cheap — a page unmounts, its cursor goes with it, and coming back starts
 * at the top rather than wherever you happened to leave it. That is the right
 * behaviour for four short lists.
 *
 * Only one of these is ever mounted, because `useInput` handlers all fire: two
 * lists on screen at once would both move on every arrow key.
 */

export interface ChoiceItem {
	/** Stable across renders; used as the React key and returned on choosing. */
	readonly id: string;
	readonly label: string;
	/** A few words beside the label. */
	readonly detail?: string;
	/** A sentence or two under it, for a choice that needs explaining. */
	readonly body?: string;
	/**
	 * Shown, but not choosable, with `body` saying why.
	 *
	 * Hiding an unavailable choice is worse: a player who has heard the game can be
	 * played with a model and cannot find the option assumes they have the wrong
	 * version, rather than a missing key.
	 */
	readonly disabled?: boolean;
}

export interface ChooserProps {
	readonly items: readonly ChoiceItem[];
	/** Columns the list may use. Bodies wrap to it rather than being cut. */
	readonly width?: number;
	readonly onChoose: (item: ChoiceItem, index: number) => void;
	/** ESC, and `q` where the page above is the title. */
	readonly onBack?: () => void;
	/**
	 * A page-specific key, given the item under the cursor.
	 *
	 * Returns true when it handled the press. The Continue page uses it for `D`, and
	 * nothing else needs one — which is why this is a callback rather than a table.
	 */
	readonly onKey?: (input: string, item: ChoiceItem | undefined) => boolean;
	readonly isActive?: boolean;
}

export function Chooser({
	items,
	width = 76,
	onChoose,
	onBack,
	onKey,
	isActive = true,
}: ChooserProps) {
	const [cursor, setCursor] = useState(() => firstEnabled(items));

	useInput(
		(input, key) => {
			if (onKey?.(input, items[cursor])) return;
			if (key.escape) {
				onBack?.();
				return;
			}
			if (key.upArrow || input === "k") {
				setCursor((at) => step(items, at, -1));
				return;
			}
			if (key.downArrow || input === "j") {
				setCursor((at) => step(items, at, 1));
				return;
			}
			if (!key.return && input !== " ") return;
			const item = items[cursor];
			if (item && !item.disabled) onChoose(item, cursor);
		},
		{ isActive },
	);

	// Clamped rather than stored back, so a list that shrinks under the cursor —
	// which is what deleting a save does — cannot leave it pointing past the end.
	const at = Math.min(cursor, Math.max(0, items.length - 1));

	return (
		<Box flexDirection="column">
			{items.map((item, index) => (
				<Row key={item.id} item={item} width={width} selected={index === at && isActive} />
			))}
		</Box>
	);
}

/** Room the body has once the four columns of indent are taken off. */
const BODY_INDENT = 4;

function Row({ item, width, selected }: { item: ChoiceItem; width: number; selected: boolean }) {
	const color = item.disabled ? "gray" : selected ? "cyan" : undefined;
	// Wrapped rather than truncated. A paragraph is the whole reason a choice has a
	// body — cutting it mid-sentence puts back exactly the problem the old one-line
	// list had.
	const body = item.body
		? wrapToLines(item.body, Math.max(20, width - BODY_INDENT), BODY_ROWS)
		: [];

	return (
		<Box flexDirection="column" marginBottom={body.length > 0 ? 1 : 0}>
			<Text color={color} wrap="truncate">
				{selected ? "❯ " : "  "}
				{item.label}
				{item.detail ? <Text dimColor>{`  ${item.detail}`}</Text> : null}
			</Text>
			{body.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
				<Text key={index} dimColor wrap="truncate">
					{`${" ".repeat(BODY_INDENT)}${line}`}
				</Text>
			))}
		</Box>
	);
}

/**
 * Three lines is enough for the longest of these and short enough that four
 * choices still fit a 24-row terminal beside their labels and the footer.
 */
const BODY_ROWS = 3;

function firstEnabled(items: readonly ChoiceItem[]): number {
	const at = items.findIndex((item) => !item.disabled);
	return at === -1 ? 0 : at;
}

/** Move, skipping what cannot be chosen, and stop at the ends rather than wrapping. */
function step(items: readonly ChoiceItem[], from: number, delta: -1 | 1): number {
	for (let i = from + delta; i >= 0 && i < items.length; i += delta) {
		if (!items[i]?.disabled) return i;
	}
	return from;
}
