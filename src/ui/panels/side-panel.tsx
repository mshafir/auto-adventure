import { Box, Text } from "ink";
import type { TerrainSummary } from "../../core/gen/pipeline.js";
import { bearingTo, questMarks } from "../../core/rules/quest-map.js";
import { activeQuests, type GameState } from "../../core/rules/state.js";
import { biomeDef } from "../../core/world/biome.js";
import { toChunk } from "../../core/world/coords.js";
import type { Weather } from "../../core/world/weather.js";
import { useGameState } from "../store.js";
import { Minimap } from "./minimap.js";

export type PanelTab = "map" | "world" | "inventory" | "quests" | "journal";

export interface SidePanelProps {
	readonly tab: PanelTab;
	readonly width: number;
	/** Rows available, border included. The minimap sizes itself from this. */
	readonly height: number;
	readonly summary?: TerrainSummary;
	readonly placeName?: string;
	readonly weather?: Weather;
	readonly light?: string;
}

const TAB_LABEL: Record<PanelTab, string> = {
	map: "(M)ap",
	world: "(W)orld",
	inventory: "(I)nv",
	quests: "(Q)uests",
	journal: "(J)ournal",
};

export function SidePanel({
	tab,
	width,
	height,
	summary,
	placeName,
	weather,
	light,
}: SidePanelProps) {
	const state = useGameState();

	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			flexShrink={0}
			borderStyle="round"
			borderColor="gray"
			paddingX={1}
		>
			<Text>
				{(Object.keys(TAB_LABEL) as PanelTab[]).map((key) => (
					<Text key={key} bold={key === tab} color={key === tab ? "cyan" : "gray"}>
						{TAB_LABEL[key]}{" "}
					</Text>
				))}
			</Text>
			<Text color="gray">{"─".repeat(Math.max(0, width - 4))}</Text>
			{tab === "map" && (
				<MapTab
					state={state}
					summary={summary}
					placeName={placeName}
					weather={weather}
					light={light}
				/>
			)}
			{tab === "world" && <Minimap state={state} width={width - 4} height={height - 5} />}
			{tab === "inventory" && <InventoryTab state={state} />}
			{tab === "quests" && <QuestsTab state={state} />}
			{tab === "journal" && <JournalTab state={state} />}
		</Box>
	);
}

function MapTab({
	state,
	summary,
	placeName,
	weather,
	light,
}: {
	state: GameState;
	summary?: TerrainSummary;
	placeName?: string;
	weather?: Weather;
	light?: string;
}) {
	const biomes = summary
		? Object.entries(summary.biomeCounts)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
		: [];
	const total = 64 * 64;

	return (
		<Box flexDirection="column">
			<Text bold color="white">
				{placeName ?? "The wilds"}
			</Text>
			<Text color="gray">
				{state.player.x}, {state.player.y}
			</Text>
			{/*
			 * Up here rather than buried below the biome breakdown, and showing
			 * minutes: a tick is a minute, so an hour is sixty player actions and an
			 * hour-only clock sits unchanged for a solid minute of play, which reads
			 * as stopped rather than slow.
			 */}
			<Text bold color="yellow">
				{clock(state.time)}
				<Text color="gray">{`  day ${state.time.day}`}</Text>
			</Text>
			{light ? <Text color="gray">{light}</Text> : null}
			<Text> </Text>
			{biomes.map(([biome, count]) => (
				<Text key={biome} color="green">
					{biomeDef(biome as never).name} {Math.round((count / total) * 100)}%
				</Text>
			))}
			<Text> </Text>
			{weather && <Text color="cyan">{weather.description}</Text>}
			<Text color="gray">Explored {state.discovered.length} chunks</Text>
			{summary && summary.roadEntries.length > 0 && (
				<Text color="yellow">Roads: {summary.roadEntries.join(", ")}</Text>
			)}
		</Box>
	);
}

/** `08:37`, zero-padded so the column never jumps as the digits change. */
function clock(time: GameState["time"]): string {
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function InventoryTab({ state }: { state: GameState }) {
	if (state.inventory.length === 0) return <Text color="gray">You carry nothing.</Text>;
	return (
		<Box flexDirection="column">
			{state.inventory.map((item) => (
				<Text key={item.name}>
					<Text color="yellow">{item.quantity}x </Text>
					<Text bold>{item.name}</Text>
				</Text>
			))}
		</Box>
	);
}

function QuestsTab({ state }: { state: GameState }) {
	const open = activeQuests(state);
	if (open.length === 0) return <Text color="gray">No active quests.</Text>;

	// Where each errand was given, and which way that is from here. The quest log
	// is prose; in an infinite world prose is not enough to find a place again.
	const here = toChunk(state.player.x, state.player.y);
	const marks = new Map(questMarks(state).map((mark) => [mark.questId, mark]));

	return (
		<Box flexDirection="column">
			{open.map((quest) => {
				const mark = marks.get(quest.id);
				const bearing = mark ? bearingTo(here.cx, here.cy, mark.cx, mark.cy) : undefined;
				return (
					<Box key={quest.id} flexDirection="column" marginBottom={1}>
						<Text bold color="cyan">
							{quest.name}
							{bearing ? (
								<Text color="magenta">{`  ${bearing.compass} ${bearing.distance}`}</Text>
							) : null}
							{mark && !bearing ? <Text color="green">{"  here"}</Text> : null}
						</Text>
						{quest.objectives.length === 0 ? (
							// A quest can reach the log with nothing to track: the engine refuses
							// objectives that name things it cannot find, and says so rather than
							// showing an empty entry the player would read as broken.
							<Text color="yellow">{"[!] nothing here I can follow — ask again"}</Text>
						) : null}
						{quest.objectives.map((objective) => (
							<Text
								key={`${objective.kind}:${objective.target}`}
								color={objective.done ? "green" : "gray"}
							>
								{objective.done ? "[x] " : "[ ] "}
								{objective.kind} {objective.target}
							</Text>
						))}
					</Box>
				);
			})}
		</Box>
	);
}

function JournalTab({ state }: { state: GameState }) {
	const recent = state.journal.slice(-12).reverse();
	if (recent.length === 0) return <Text color="gray">Your journal is empty.</Text>;
	return (
		<Box flexDirection="column">
			{recent.map((entry) => (
				<Text key={`${entry.tick}:${entry.text}`} wrap="wrap">
					<Text color="gray">[{entry.kind}] </Text>
					{entry.text}
				</Text>
			))}
		</Box>
	);
}
