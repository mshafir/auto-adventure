import { Box, Text } from "ink";
import type { Card } from "../../core/rules/card.js";
import { wrapToLines } from "../render/text.js";
import { FRAME_CHROME, Frame, Rule } from "./primitives.js";

/**
 * A card, filling the frame.
 *
 * Takes the whole screen rather than sitting in the map pane, because the point is
 * to be read: a paragraph squeezed into a 32-column side panel is a paragraph the
 * player skims. The layout is fixed to the frame it is given and never grows,
 * because Ink stops updating incrementally once output reaches the terminal height
 * and clears the screen every keypress instead — which reads as flicker.
 *
 * Prose is measured rather than left to Ink's own wrapping so the section budget
 * below can be honest about what fits. Ink would clip; this elides, with an
 * ellipsis, which at least tells the reader there was more.
 */

/** Wider than this and prose gets hard to track back to the left margin. */
const MAX_TEXT_WIDTH = 74;

export interface CardScreenProps {
	readonly card: Card;
	readonly width: number;
	readonly height: number;
}

export function CardScreen({ card, width, height }: CardScreenProps) {
	const text = Math.max(20, Math.min(width - FRAME_CHROME - 8, MAX_TEXT_WIDTH));

	// Rows spoken for before any body text: the title, an optional subtitle, the
	// blank under them, one rule and one blank per section, and the footer with its
	// own blank above it. The border takes its own two on top of that.
	const fixed = 1 + (card.subtitle ? 1 : 0) + 1 + card.sections.length * 2 + 2 + FRAME_CHROME;
	const budget = Math.max(card.sections.length, height - fixed);

	// Share the remaining rows out evenly, giving the leftovers to the earliest
	// sections — the opening card puts "where you are" first, and that is the one
	// worth reading in full when the terminal is short.
	const per = Math.floor(budget / Math.max(1, card.sections.length));
	const extra = budget - per * card.sections.length;

	return (
		<Frame style="card" width={width} height={height}>
			<Text bold wrap="truncate">
				{card.title}
			</Text>
			{card.subtitle ? (
				<Text color="gray" wrap="truncate">
					{card.subtitle}
				</Text>
			) : null}
			<Text> </Text>

			{card.sections.map((section, index) => {
				const rows = Math.max(1, per + (index < extra ? 1 : 0));
				return (
					<Box flexDirection="column" key={section.heading}>
						<Rule width={text} label={section.heading} />
						{wrapToLines(section.body, text, rows).map((line, row) => (
							<Text key={`${section.heading}:${row}`} wrap="truncate">
								{line}
							</Text>
						))}
						<Text> </Text>
					</Box>
				);
			})}

			<Box flexGrow={1} />
			<Text color="gray" wrap="truncate">
				{card.footer ?? "SPACE to go on"}
			</Text>
		</Frame>
	);
}
