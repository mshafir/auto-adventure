import { Text } from "ink";
import type React from "react";
import stringWidth from "string-width";
import { listWindow } from "../hud-state.js";
import { wrapToLines } from "../render/text.js";

/**
 * The pieces every pane is built from.
 *
 * Extracted when the full-frame reader arrived and needed the same rules, fields,
 * wrapped prose and windowed lists as the side panel. Two copies would drift, and
 * the drift would be visible in the worst way: the same quest laid out differently
 * depending on how much room it had.
 *
 * All of them take their width and row count rather than measuring anything. A pane
 * that grows to fit its contents can reach the terminal's height, and at that point
 * Ink stops updating incrementally and clears the screen on every keypress — which
 * the player sees as flicker. Fixed boxes are what avoid that, and the cost is that
 * every component here has to be told how much space it has.
 */

export function Rule({ width, label }: { width: number; label?: string }) {
	const text = label ? `─ ${label.toUpperCase()} ` : "";
	return (
		<Text color="gray" wrap="truncate">
			{text}
			{"─".repeat(Math.max(0, width - stringWidth(text)))}
		</Text>
	);
}

/** A grey label on the left, its value hard against the right margin. */
export function Field({
	label,
	value,
	width,
	color = "white",
}: {
	label: string;
	value: string;
	width: number;
	color?: string;
}) {
	const room = Math.max(0, width - stringWidth(label) - stringWidth(value));
	return (
		<Text wrap="truncate">
			<Text color="gray">{label}</Text>
			{" ".repeat(room)}
			<Text color={color}>{value}</Text>
		</Text>
	);
}

export function Prose({
	text,
	width,
	rows,
	color = "white",
}: {
	text: string;
	width: number;
	rows: number;
	color?: string;
}) {
	return (
		<>
			{wrapToLines(text, width, Math.max(0, rows)).map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
				<Text key={index} color={color} wrap="truncate">
					{line}
				</Text>
			))}
		</>
	);
}

export function ScrollList({
	count,
	cursor,
	rows,
	focus,
	render,
}: {
	count: number;
	cursor: number;
	rows: number;
	focus: boolean;
	render: (index: number, selected: boolean) => React.ReactNode;
}) {
	const view = listWindow(count, cursor, rows);
	const lines: React.ReactElement[] = [];
	for (let index = view.start; index < view.end; index++) {
		const selected = index === cursor;
		lines.push(
			<Text key={index} wrap="truncate">
				<Text bold={selected} color={selected ? (focus ? "cyan" : "gray") : "gray"}>
					{selected ? "▸ " : "  "}
				</Text>
				{render(index, selected)}
			</Text>,
		);
	}
	// Only shown when there is genuinely more than fits, so it never nags.
	if (view.more) {
		lines.push(
			<Text key="more" color="gray">
				{`  ${cursor + 1}/${count}`}
			</Text>,
		);
	}
	return <>{lines}</>;
}

/**
 * A bullet whose continuation lines line up under the text, not under the marker.
 *
 * Written because the reader's clues were the last thing still being cut: they are
 * two or three sentences of the story, and a one-line bullet elided them exactly
 * where they got interesting. Hanging the indent keeps a wrapped clue legible as one
 * item rather than reading as several.
 */
export function Bullet({
	text,
	width,
	rows,
	marker = "•",
	color,
}: {
	text: string;
	width: number;
	rows: number;
	marker?: string;
	color?: string;
}) {
	const indent = marker.length + 1;
	const lines = wrapToLines(text, Math.max(1, width - indent), Math.max(0, rows));
	return (
		<>
			{lines.map((line, index) => (
				<Text
					// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
					key={index}
					{...(color ? { color } : {})}
					wrap="truncate"
				>
					{index === 0 ? `${marker} ` : " ".repeat(indent)}
					{line}
				</Text>
			))}
		</>
	);
}
