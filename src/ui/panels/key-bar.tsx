import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { PendingConfirm } from "../hud-state.js";

/**
 * The keys, along the bottom.
 *
 * Every binding the game has was previously undocumented anywhere on screen
 * except the one line inside the conversation panel, so the only way to find
 * out that `j` opened the journal was to read the source. It is context
 * sensitive because a fixed list of everything would be both too long for the
 * row and mostly wrong: the arrow keys mean three different things depending on
 * what has focus, and a bar that does not say which is worse than none.
 *
 * Deliberately ASCII. Arrow characters are East-Asian-Ambiguous, and this row
 * spans the full frame — one column of disagreement between our width
 * calculation and the terminal's would tear every line below it.
 */
export type KeyBarMode =
	/** `canZoom` is false for glyphs, where there is no tile size to change. */
	| { readonly t: "world"; readonly canZoom: boolean }
	| { readonly t: "card" }
	/** The menu. `inList` decides what up and down are doing right now. */
	| {
			readonly t: "menu";
			readonly canDrop: boolean;
			readonly hasList: boolean;
			readonly inList: boolean;
	  }
	| { readonly t: "dialogue" };

export interface KeyBarProps {
	readonly width: number;
	readonly mode: KeyBarMode;
	readonly confirm?: PendingConfirm;
}

interface Segment {
	readonly text: string;
	readonly color: string;
	readonly bold?: boolean;
}

interface Binding {
	readonly key: string;
	readonly label: string;
}

/** What the keys mean right now, and what they always mean. */
interface BarContent {
	readonly left: readonly Segment[];
	/** Pinned to the right margin, so the row ends on a character. */
	readonly right: readonly Segment[];
}

function bindingsFor(mode: KeyBarMode): readonly Binding[] {
	switch (mode.t) {
		case "card":
			return [{ key: "Space", label: "go on" }];
		case "menu":
			return [
				{ key: "Lt/Rt", label: "tab" },
				// Down means two different things, and which one is not guessable from
				// the screen alone — so the bar says which. A tab with nothing to select
				// offers neither, rather than a binding that visibly does nothing.
				...(mode.hasList
					? [mode.inList ? { key: "Up/Dn", label: "read" } : { key: "Dn", label: "go in" }]
					: []),
				...(mode.canDrop ? [{ key: "D", label: "drop" }] : []),
				{ key: "Esc", label: "back to map" },
			];
		case "dialogue":
			return [
				{ key: "Up/Dn", label: "choose" },
				{ key: "Space", label: "reply" },
			];
		case "world":
			return [
				{ key: "Arrows", label: "move" },
				{ key: "Space", label: "look/act" },
				{ key: "M", label: "menu" },
				// Last, because it is the only one here that is about the window rather
				// than about the world — and the only one a player would never guess is
				// available at all. Absent entirely where it would do nothing: a bar
				// offering a key that is not live is worse than one that stays quiet.
				...(mode.canZoom ? [{ key: "+/-", label: "zoom" }] : []),
			];
	}
}

function keys(bindings: readonly Binding[]): Segment[] {
	const segments: Segment[] = [];
	for (const [index, binding] of bindings.entries()) {
		if (index > 0) segments.push({ text: "  ·  ", color: "gray" });
		segments.push({ text: binding.key, color: "cyan", bold: true });
		segments.push({ text: ` ${binding.label}`, color: "gray" });
	}
	return segments;
}

function contentFor(mode: KeyBarMode, confirm: PendingConfirm | undefined): BarContent {
	if (confirm) {
		// The question replaces the bar rather than crowding in beside it: while it
		// is up, these two keys are the only ones that do anything.
		return {
			left: [
				{ text: confirm.prompt, color: "yellow", bold: true },
				...(confirm.warning ? [{ text: ` ${confirm.warning}`, color: "red" }] : []),
			],
			right: [
				{ text: "Y", color: "green", bold: true },
				{ text: " yes  ", color: "gray" },
				{ text: "N", color: "red", bold: true },
				{ text: " no", color: "gray" },
			],
		};
	}

	// Quitting works from everywhere outside a conversation and a menu, so it sits
	// apart from the keys that change meaning. A conversation swallows it, and
	// offers the only key that gets you out of it instead.
	return {
		left: keys(bindingsFor(mode)),
		right: keys(
			// A card swallows the menu key too, and saying so is better than letting
			// the player press it and watch nothing happen.
			mode.t === "card"
				? []
				: mode.t === "dialogue"
					? [{ key: "Esc", label: "leave" }]
					: mode.t === "menu"
						? []
						: [{ key: "S", label: "save+quit" }],
		),
	};
}

/** Truncate to a column count, leaving runs of spaces intact. */
function cut(text: string, width: number): string {
	if (width <= 0) return "";
	if (stringWidth(text) <= width) return text;
	let out = "";
	for (const ch of text) {
		if (stringWidth(out + ch) > width) break;
		out += ch;
	}
	return out;
}

function measure(segments: readonly Segment[]): number {
	return segments.reduce((total, segment) => total + stringWidth(segment.text), 0);
}

function clip(segments: readonly Segment[], width: number): Segment[] {
	const out: Segment[] = [];
	let used = 0;
	for (const segment of segments) {
		if (used >= width) break;
		const text = cut(segment.text, width - used);
		if (text.length === 0) continue;
		out.push({ ...segment, text });
		used += stringWidth(text);
	}
	return out;
}

/**
 * Lay the two groups out across exactly the frame width.
 *
 * The right-hand group is what makes the row end on a character. Ink trims
 * trailing whitespace off every line it emits, so a bar padded out with spaces
 * comes back short — which leaves the tail of the previous frame showing at the
 * end of the line, and which the app's equal-width assertion catches. The
 * left-hand group is what gets cut when the terminal is narrow, because the
 * keys on the right are the ones that work everywhere.
 */
function layout(content: BarContent, width: number): Segment[] {
	const right = clip(content.right, Math.max(0, width - 4));
	const rightWidth = measure(right);
	const left = clip(content.left, Math.max(0, width - rightWidth - 2));
	const gap = Math.max(0, width - measure(left) - rightWidth);
	return [...left, { text: " ".repeat(gap), color: "gray" }, ...right];
}

export function KeyBar({ width, mode, confirm }: KeyBarProps) {
	const segments = layout(contentFor(mode, confirm), width);
	return (
		<Box width={width} height={1} flexShrink={0}>
			<Text wrap="truncate">
				{segments.map((segment, index) => (
					<Text
						// biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
						key={index}
						color={segment.color}
						bold={segment.bold ?? false}
					>
						{segment.text}
					</Text>
				))}
			</Text>
		</Box>
	);
}
