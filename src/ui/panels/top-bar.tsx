import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { TerrainSummary } from "../../core/gen/pipeline.js";
import { clockRuns } from "../../core/rules/clock.js";
import type { GameState } from "../../core/rules/state.js";
import { biomeDef } from "../../core/world/biome.js";
import { CHUNK_AREA } from "../../core/world/coords.js";
import { type WorldRules, worldSeed } from "../../core/world/recipe.js";
import type { Weather } from "../../core/world/weather.js";
import { Rule } from "./primitives.js";

export interface TopBarProps {
	readonly state: GameState;
	readonly width: number;
	readonly summary?: TerrainSummary;
	readonly placeName?: string;
	readonly weather?: Weather;
	readonly light?: string;
}

/** Rows this occupies, so the layout can take them off the map. */
export const TOP_BAR_ROWS = 2;

/**
 * Where you are, when it is, and what the weather is doing.
 *
 * Pinned along the top of the frame rather than living in a tab. It was the map
 * pane of the side panel, which meant the standing state of the world was
 * something you could navigate *away* from — and the panel itself had to go,
 * because a box beside the map cuts a row of kitty placeholders in half.
 *
 * One row of content and a rule beneath it. Every row here is a row the map does
 * not get, so the whole thing is built to degrade: pieces are dropped from the
 * least useful end until what is left fits, rather than being wrapped or cut
 * mid-word.
 */
export function TopBar({ state, width, summary, placeName, weather, light }: TopBarProps) {
	const place = placeName ?? "The wilds";
	/*
	 * A world with the clock frozen shows no clock at all.
	 *
	 * Not "08:00, day 1" forever, which is the tempting thing to do and is worse than
	 * nothing: a clock that never moves reads as the game having hung. The two pieces
	 * come out together, and the position slides left to fill the gap, because every
	 * row of the frame has to stay exactly the same width.
	 */
	const showClock = clockRuns(state.world.time);
	// Minutes, not just hours: a tick is a minute, so an hour is sixty player
	// actions and an hour-only clock sits unchanged for a solid minute of play,
	// which reads as stopped rather than slow.
	const time = showClock ? clock(state.time) : "";
	const day = showClock ? `day ${state.time.day}` : "";
	const at = `${state.player.x}, ${state.player.y}`;

	// In priority order from the middle out. The place and the clock always stay;
	// the ground summary is the first thing to go, because it is the one piece the
	// map itself already tells you.
	//
	// The light label is dropped along with the clock — `NEUTRAL_LIGHT` carries an
	// empty one precisely so there is nothing here to say about an hour this world
	// does not have.
	const optional: { readonly text: string; readonly color: string }[] = [
		...(light ? [{ text: light, color: "gray" }] : []),
		...(weather ? [{ text: weather.description, color: "cyan" }] : []),
		...(summary
			? [
					{
						text: ground(summary, worldSeed(state.world.seed, state.world.recipe).rules),
						color: "green",
					},
				]
			: []),
	];

	const fixed = stringWidth(place) + stringWidth(time) + stringWidth(day) + stringWidth(at);
	// What is left once the pieces that always show, and the two spaces between
	// each of them, are accounted for. Whatever survives becomes the gap before the
	// position — so the row ends on a character rather than on padding Ink would
	// trim, which is what keeps every row of the frame exactly the same width.
	//
	// The separators are counted from what is actually drawn rather than assumed, or a
	// world with no clock would reserve four columns for two pieces it does not render
	// and every row would come out four short.
	let room = width - fixed - (showClock ? 2 * 2 : 0);
	const shown: typeof optional = [];
	for (const piece of optional) {
		const cost = stringWidth(piece.text) + 2;
		// One column always held back, so the position never abuts what precedes it.
		if (cost > room - 1) break;
		room -= cost;
		shown.push(piece);
	}

	return (
		<Box flexDirection="column" flexShrink={0}>
			<Text wrap="truncate">
				<Text bold color="white">
					{place}
				</Text>
				{showClock && (
					<>
						<Text bold color="yellow">{`  ${time}`}</Text>
						<Text color="gray">{`  ${day}`}</Text>
					</>
				)}
				{shown.map((piece) => (
					<Text key={piece.text} color={piece.color}>{`  ${piece.text}`}</Text>
				))}
				{/* Hard against the right margin: useful for reporting a bug or finding
				    the way back, and never worth a row of its own. */}
				<Text color="gray">
					{" ".repeat(Math.max(1, room))}
					{at}
				</Text>
			</Text>
			<Rule width={width} />
		</Box>
	);
}

/** `08:37`, zero-padded so the column never jumps as the digits change. */
function clock(time: GameState["time"]): string {
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

/** The two biomes most of this chunk is made of, as percentages. */
function ground(summary: TerrainSummary, rules: WorldRules): string {
	return Object.entries(summary.biomeCounts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 2)
		.map(
			([biome, count]) =>
				`${biomeDef(biome as never, rules).name} ${Math.round((count / CHUNK_AREA) * 100)}%`,
		)
		.join(" · ");
}
