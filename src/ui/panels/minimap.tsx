import { Text } from "ink";
import type { GameState } from "../../core/rules/state.js";
import { toHex } from "../render/color.js";
import { minimapCells } from "../render/minimap-data.js";

export interface MinimapProps {
	readonly state: GameState;
	readonly width: number;
	readonly height: number;
}

/**
 * The explored world, one character per chunk.
 *
 * What to draw lives in `render/minimap-data.ts`, because the same map has to be
 * composited into the frame by both renderers and neither can call a component.
 * This is only the Ink presentation of it.
 */
export function Minimap({ state, width, height }: MinimapProps) {
	const rows = minimapCells(state, width, height);

	return (
		<>
			{rows.map((row, y) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, not identities
				<Text key={y} wrap="truncate">
					{row.map((cell, x) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: cells are positional, not identities
						<Text key={x} bold={cell.bold} color={toHex(cell.fg)}>
							{cell.ch}
						</Text>
					))}
				</Text>
			))}
		</>
	);
}
