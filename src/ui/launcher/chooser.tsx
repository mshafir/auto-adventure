import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Rule } from "../panels/primitives.js";
import { toHex } from "../render/color.js";
import { wrapToLines } from "../render/text.js";
import type { PreviewCell } from "../render/tile-preview.js";

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
	 * A few rows of colour under the body, for a choice that can be *shown*.
	 *
	 * Drawn only under the cursor, however much room the bodies have. A preview is
	 * several rows and every choice having one at once would be a page of swatches with
	 * the settings squeezed between them — and unlike a body, it answers a question only
	 * about the row being decided.
	 */
	readonly preview?: readonly (readonly PreviewCell[])[];
	/**
	 * Shown, but not choosable, with `body` saying why.
	 *
	 * Hiding an unavailable choice is worse: a player who has heard the game can be
	 * played with a model and cannot find the option assumes they have the wrong
	 * version, rather than a missing key.
	 */
	readonly disabled?: boolean;
	/**
	 * The row's own colour, used when the cursor is elsewhere.
	 *
	 * An Ink colour name rather than a hex string, so the row degrades with the
	 * terminal instead of asking what the terminal can do — this list is drawn before
	 * anything has been established about it. The cursor still overrides it: what is
	 * selected has to be unmistakable, and a list where every row is a different colour
	 * has no spare colour left to mean "here".
	 */
	readonly accent?: string;
	/**
	 * A labelled rule drawn above this row, separating it from what came before.
	 *
	 * Grouping without nesting. The alternative was a list of lists, which buys nothing
	 * — the cursor still walks straight through — and costs the one thing this screen
	 * needs, which is for two unlike kinds of choice to look unlike.
	 */
	readonly rule?: string;
}

export interface ChooserProps {
	readonly items: readonly ChoiceItem[];
	/** Columns the list may use. Bodies wrap to it rather than being cut. */
	readonly width?: number;
	/**
	 * Rows the list may use.
	 *
	 * The whole list has to fit: it lives inside a fixed-height frame now, and a
	 * frame that overflows does not scroll — Ink clips it, so the last choice and the
	 * footer simply vanish. Given too few rows the bodies shrink, and given fewer
	 * still only the selected choice keeps one.
	 */
	readonly height?: number;
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
	/**
	 * Left or right on the row under the cursor: `-1` or `1`.
	 *
	 * Its own hook rather than something read out of `onKey`, for the same reason
	 * `onChoose` is: a list where the horizontal arrows change the row's *value* is a
	 * settings page, and a settings page is a shape worth naming. `h` and `l` come here
	 * too, mirroring the `j` and `k` that already move the cursor.
	 *
	 * A row with no value to change simply does not implement it.
	 */
	readonly onCycle?: (item: ChoiceItem | undefined, step: -1 | 1) => void;
	readonly isActive?: boolean;
}

export function Chooser({
	items,
	width = 76,
	height = Number.POSITIVE_INFINITY,
	onChoose,
	onBack,
	onKey,
	onCycle,
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
			// Swallowed whether or not anybody is listening, so that a page with no
			// settings on it does not scroll its terminal when somebody presses right.
			if (key.leftArrow || input === "h") {
				onCycle?.(items[cursor], -1);
				return;
			}
			if (key.rightArrow || input === "l") {
				onCycle?.(items[cursor], 1);
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
	const budget = bodyBudget(items, height);

	return (
		<Box flexDirection="column">
			{items.map((item, index) => (
				<Row
					key={item.id}
					item={item}
					width={width}
					// In `selected` mode only the choice under the cursor explains itself,
					// which is what keeps a four-paragraph page usable on a short terminal.
					rows={budget.mode === "all" || index === at ? budget.rows : 0}
					previewRows={budget.preview}
					selected={index === at && isActive}
				/>
			))}
		</Box>
	);
}

interface BodyBudget {
	readonly mode: "all" | "selected";
	readonly rows: number;
	/**
	 * Preview rows the selected choice may draw, which is not the same as how many it has.
	 *
	 * Handed out explicitly rather than merely *reserved*, and that distinction is the bug
	 * this field exists to fix. Subtracting the preview from the paragraph budget is enough
	 * while there are paragraphs to shrink; once they are already at nothing there is
	 * nothing left to give, and a preview drawn anyway pushes the last choice off the
	 * bottom — where Ink clips it rather than scrolling, so the row that vanishes is the
	 * one that writes the world.
	 */
	readonly preview: number;
}

/**
 * How many rows each choice's paragraph may have.
 *
 * Every choice gets one while there is room for every choice to get one — reading
 * four descriptions side by side is the whole point of the page. Below that it
 * collapses to explaining only what the cursor is on, which is worse but still
 * answers the question, and is much better than the alternative of the page
 * overflowing and dropping its last choice off the bottom without a word.
 */
function bodyBudget(items: readonly ChoiceItem[], height: number): BodyBudget {
	const explained = items.filter((item) => item.body).length;
	// Separators are chrome and are never dropped: a rule costs one row whether or not
	// there is room for the paragraphs, so it comes off the budget before they are shared
	// out rather than being the thing that overflows the frame.
	const rules = items.filter((item) => item.rule).length;
	if (explained === 0) return { mode: "all", rows: 0, preview: 0 };

	// The tallest preview any *one* item has, because only the selected item draws one.
	// Charged whether or not the cursor is on that item, so that moving onto it cannot
	// change the height of the list — one that grew under the cursor would jump under the
	// player's hands.
	const wanted = items.reduce((most, item) => Math.max(most, item.preview?.length ?? 0), 0);

	// One row per label, and one blank under each body.
	const spare = height - items.length - explained - rules - wanted;
	const each = Math.floor(spare / explained);
	if (each >= 1) return { mode: "all", rows: Math.min(BODY_ROWS, each), preview: wanted };

	// Only the selected choice explains itself now: one paragraph, one blank under it, and
	// whatever is left over for the preview. Everything is clamped at zero and taken from
	// the same total, so the sum of what is handed out can never exceed the height.
	const forOne = Math.max(0, height - items.length - rules);
	const rows = Math.max(0, Math.min(BODY_ROWS, forOne - wanted - 1));
	const preview = Math.max(0, Math.min(wanted, forOne - rows - (rows > 0 ? 1 : 0)));
	return { mode: "selected", rows, preview };
}

/** Room the body has once the four columns of indent are taken off. */
const BODY_INDENT = 4;

function Row({
	item,
	width,
	rows,
	previewRows,
	selected,
}: {
	item: ChoiceItem;
	width: number;
	rows: number;
	/** How many rows of preview there is room for, which may be fewer than it has. */
	previewRows: number;
	selected: boolean;
}) {
	const color = item.disabled ? "gray" : selected ? "cyan" : item.accent;
	// Wrapped rather than truncated. A paragraph is the whole reason a choice has a
	// body — cutting it mid-sentence puts back exactly the problem the old one-line
	// list had.
	const body =
		item.body && rows > 0 ? wrapToLines(item.body, Math.max(20, width - BODY_INDENT), rows) : [];

	return (
		<Box flexDirection="column" marginBottom={body.length > 0 ? 1 : 0}>
			{item.rule ? <Rule width={width} label={item.rule} /> : null}
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
			{selected && item.preview && previewRows > 0 ? (
				// Truncated rather than dropped whole: two rows of a coast still says what
				// colour the sea is, which is most of what the strip is for.
				<Preview rows={item.preview.slice(0, previewRows)} />
			) : null}
		</Box>
	);
}

/**
 * A strip of world, drawn in the colours of whatever is under the cursor.
 *
 * Not dimmed the way a body is. The whole content of this row is its colour, and
 * dimming it would be answering "what does this look like" with a washed-out version of
 * the answer.
 */
function Preview({ rows }: { rows: readonly (readonly PreviewCell[])[] }) {
	return (
		<>
			{rows.map((row, y) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
				<Text key={y} wrap="truncate">
					{" ".repeat(BODY_INDENT)}
					{row.map((cell, x) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
							key={x}
							color={toHex(cell.fg)}
							{...(cell.bg ? { backgroundColor: toHex(cell.bg) } : {})}
							bold={cell.bold ?? false}
							dimColor={cell.dim ?? false}
						>
							{cell.ch}
						</Text>
					))}
				</Text>
			))}
		</>
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
