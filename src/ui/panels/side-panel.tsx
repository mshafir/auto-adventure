import { Box, Text } from "ink";
import stringWidth from "string-width";
import type { TerrainSummary } from "../../core/gen/pipeline.js";
import { type ArcOutline, arcOutline, arcProgress } from "../../core/rules/arc.js";
import { bearingTo, questMarks } from "../../core/rules/quest-map.js";
import { describeObjective, questNeeding } from "../../core/rules/quests.js";
import { activeQuests, type GameState } from "../../core/rules/state.js";
import { biomeDef } from "../../core/world/biome.js";
import { toChunk } from "../../core/world/coords.js";
import type { Weather } from "../../core/world/weather.js";
import { type HudState, listWindow } from "../hud-state.js";
import { wrapToLines } from "../render/text.js";
import { useGameState } from "../store.js";
import { type LegendEntry, mapLegend, minimapLegend } from "./legend.js";
import { Minimap } from "./minimap.js";

export type PanelTab = "map" | "world" | "inventory" | "quests" | "journal";

export interface SidePanelProps {
	readonly hud: HudState;
	readonly width: number;
	/** Rows available, border included. Every pane sizes itself from this. */
	readonly height: number;
	readonly summary?: TerrainSummary;
	readonly placeName?: string;
	readonly weather?: Weather;
	readonly light?: string;
}

const TABS: readonly { readonly key: PanelTab; readonly label: string }[] = [
	{ key: "map", label: "Map" },
	{ key: "world", label: "World" },
	{ key: "inventory", label: "Inv" },
	{ key: "quests", label: "Quests" },
	{ key: "journal", label: "Jrnl" },
];

/** Border plus a column of padding on each side. */
const CHROME = 4;
/** The tab strip and the rule beneath it. */
const HEADER_ROWS = 2;

export function SidePanel({
	hud,
	width,
	height,
	summary,
	placeName,
	weather,
	light,
}: SidePanelProps) {
	const state = useGameState();
	const inner = Math.max(12, width - CHROME);
	const rows = Math.max(3, height - 2 - HEADER_ROWS);

	return (
		<Box
			flexDirection="column"
			width={width}
			height={height}
			flexShrink={0}
			borderStyle="round"
			// The border is how the panel says it has the arrow keys. Without a
			// visible marker a modal binding is a trap; with one it is a mode.
			borderColor={hud.focus ? "cyan" : "gray"}
			paddingX={1}
		>
			<Text wrap="truncate">
				{TABS.map(({ key, label }, index) => {
					const active = key === hud.tab;
					return (
						<Text key={key} bold={active} color={active ? "cyan" : "gray"}>
							{index > 0 ? " " : ""}
							<Text underline>{label.slice(0, 1)}</Text>
							{label.slice(1)}
						</Text>
					);
				})}
			</Text>
			<Rule width={inner} />
			{hud.tab === "map" && (
				<MapTab
					state={state}
					width={inner}
					rows={rows}
					summary={summary}
					placeName={placeName}
					weather={weather}
					light={light}
				/>
			)}
			{hud.tab === "world" && <WorldTab state={state} width={inner} rows={rows} />}
			{hud.tab === "inventory" && (
				<InventoryTab state={state} hud={hud} width={inner} rows={rows} />
			)}
			{hud.tab === "quests" && <QuestsTab state={state} hud={hud} width={inner} rows={rows} />}
			{hud.tab === "journal" && <JournalTab state={state} hud={hud} width={inner} rows={rows} />}
		</Box>
	);
}

// --- shared chrome ----------------------------------------------------------

/**
 * A horizontal rule that can carry its own heading.
 *
 * A separate heading line and rule would cost two rows of a panel that is
 * already the shortest thing on screen, and every pane wants at least two
 * sections.
 */
function Rule({ width, label }: { width: number; label?: string }) {
	const text = label ? `─ ${label.toUpperCase()} ` : "";
	return (
		<Text color="gray" wrap="truncate">
			{text}
			{"─".repeat(Math.max(0, width - stringWidth(text)))}
		</Text>
	);
}

/** A grey label on the left, its value hard against the right margin. */
function Field({
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

/**
 * The key, two columns wide.
 *
 * One entry per row would take more of the panel than the map summary it
 * explains; two columns fit a dozen symbols into six rows.
 */
function LegendGrid({
	entries,
	width,
	rows,
}: {
	entries: readonly LegendEntry[];
	width: number;
	rows: number;
}) {
	const columns = 2;
	const cell = Math.floor(width / columns);
	const shown = entries.slice(0, Math.max(0, rows) * columns);

	const lines: React.ReactElement[] = [];
	for (let start = 0; start < shown.length; start += columns) {
		const group = shown.slice(start, start + columns);
		lines.push(
			<Text key={group[0]?.label ?? start} wrap="truncate">
				{group.map((entry) => (
					<Text key={entry.label}>
						<Text bold={entry.bold ?? false} color={entry.color}>
							{entry.ch}
						</Text>
						<Text color="gray">{` ${entry.label}`.padEnd(cell - 2)}</Text>
					</Text>
				))}
			</Text>,
		);
	}
	return <>{lines}</>;
}

/** Prose that fills whatever rows are left, and says so when it does not fit. */
function Prose({
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

/**
 * A selectable list, windowed to the rows it was given.
 *
 * Shared by all three list panes so that "how do I scroll this" has one answer
 * everywhere, and so the cursor cannot be drawn off the end of one of them.
 */
function ScrollList({
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

// --- panes ------------------------------------------------------------------

function MapTab({
	state,
	width,
	rows,
	summary,
	placeName,
	weather,
	light,
}: {
	state: GameState;
	width: number;
	rows: number;
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
	const roads = summary?.roadEntries ?? [];

	// Everything above the key is fixed; the key takes whatever is left, so a
	// short terminal loses the bottom of the legend rather than overflowing the
	// frame — which would make Ink clear and repaint the whole screen.
	const fixed =
		3 + (biomes.length > 0 ? 1 : 0) + biomes.length + 1 + (roads.length > 0 ? 1 : 0) + 1 + 1;
	const legendRows = Math.max(0, rows - fixed);

	const stamp = `${clock(state.time)}  day ${state.time.day}${light ? `  ${light}` : ""}`;
	const at = `${state.player.x}, ${state.player.y}`;

	return (
		<Box flexDirection="column">
			<Text bold color="white" wrap="truncate">
				{placeName ?? "The wilds"}
			</Text>
			{/*
			 * Minutes, not just hours: a tick is a minute, so an hour is sixty player
			 * actions and an hour-only clock sits unchanged for a solid minute of
			 * play, which reads as stopped rather than slow.
			 */}
			<Text wrap="truncate">
				<Text bold color="yellow">
					{clock(state.time)}
				</Text>
				<Text color="gray">{`  day ${state.time.day}`}</Text>
				{light ? <Text color="gray">{`  ${light}`}</Text> : null}
				{/* The coordinates share the clock's row: useful for reporting a bug or
				    finding your way back, but not worth a line of its own. */}
				<Text color="gray">
					{" ".repeat(Math.max(1, width - stringWidth(stamp) - stringWidth(at)))}
					{at}
				</Text>
			</Text>
			{weather ? (
				<Text color="cyan" wrap="truncate">
					{weather.description}
				</Text>
			) : (
				<Text> </Text>
			)}

			{/* Indoors there is no chunk summary, and a GROUND heading with nothing
			    under it reads as something that failed to load. */}
			{biomes.length > 0 && <Rule width={width} label="ground" />}
			{biomes.map(([biome, count]) => (
				<Field
					key={biome}
					label={biomeDef(biome as never).name}
					value={`${Math.round((count / total) * 100)}%`}
					width={width}
					color="green"
				/>
			))}
			{roads.length > 0 && (
				<Field label="roads" value={roads.join(", ")} width={width} color="yellow" />
			)}
			<Field label="explored" value={`${state.discovered.length} chunks`} width={width} />

			{legendRows > 0 && (
				<>
					<Rule width={width} label="key" />
					<LegendGrid entries={mapLegend()} width={width} rows={legendRows} />
				</>
			)}
		</Box>
	);
}

/** `08:37`, zero-padded so the column never jumps as the digits change. */
function clock(time: GameState["time"]): string {
	return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}

function WorldTab({ state, width, rows }: { state: GameState; width: number; rows: number }) {
	const key = minimapLegend();
	const keyRows = Math.ceil(key.length / 2);
	// The map gets everything the key does not, and the key is dropped entirely
	// before the map is squeezed to nothing.
	const mapRows = rows - keyRows - 1;
	const showKey = mapRows >= 5;

	return (
		<Box flexDirection="column">
			<Minimap state={state} width={width} height={showKey ? mapRows : rows} />
			{showKey && (
				<>
					<Rule width={width} label="key" />
					<LegendGrid entries={key} width={width} rows={keyRows} />
				</>
			)}
		</Box>
	);
}

/** Rows the detail block below a list gets, leaving the list at least three. */
function detailRows(rows: number, wanted: number): number {
	return Math.max(0, Math.min(wanted, rows - 4));
}

function InventoryTab({
	state,
	hud,
	width,
	rows,
}: {
	state: GameState;
	hud: HudState;
	width: number;
	rows: number;
}) {
	const items = state.inventory;
	if (items.length === 0) {
		return (
			<Box flexDirection="column">
				<Rule width={width} label="carrying" />
				<Text color="gray">You carry nothing.</Text>
			</Box>
		);
	}

	const detail = detailRows(rows, 5);
	const listRows = Math.max(1, rows - detail - (detail > 0 ? 2 : 1));
	const selected = items[Math.min(hud.cursor, items.length - 1)];
	const wanted = selected ? questNeeding(state, selected.name) : undefined;

	return (
		<Box flexDirection="column">
			<Rule width={width} label={`carrying ${items.length}`} />
			<ScrollList
				count={items.length}
				cursor={Math.min(hud.cursor, items.length - 1)}
				rows={listRows}
				focus={hud.focus}
				render={(index) => {
					const item = items[index];
					if (!item) return null;
					return (
						<>
							<Text color="yellow">{`${item.quantity}x `}</Text>
							<Text>{item.name}</Text>
						</>
					);
				}}
			/>
			{detail > 0 && selected && (
				<>
					<Rule width={width} />
					<Prose
						text={selected.description}
						width={width}
						rows={wanted ? detail - 1 : detail}
						color="gray"
					/>
					{wanted && (
						<Text color="magenta" wrap="truncate">
							{`Wanted for: ${wanted.name}`}
						</Text>
					)}
				</>
			)}
		</Box>
	);
}

/**
 * The story, always on screen.
 *
 * Pinned above the errands rather than being one entry in the list, because the arc
 * is not an errand: it has no bearing, it cannot be completed by walking somewhere,
 * and it is the thing the player most often wants to be reminded of. Reachable
 * without moving a cursor for the same reason.
 *
 * Backwards-looking on purpose — what is done and what has been learned. The next
 * step is already below it as an open errand with a bearing on the map, and naming
 * the beat after that would hand over the plot.
 */
function MainQuest({ outline, width, rows }: { outline: ArcOutline; width: number; rows: number }) {
	if (rows <= 1) return null;

	const settled = outline.steps.filter((step) => step.complete).length;
	const total = outline.steps.length + outline.remaining;
	const progress = settled === total ? "done" : `${settled}/${total}`;

	// The rule takes one row and the premise one or two; whatever is left goes to the
	// ticked objectives first, because those are the answer to "where was I", and the
	// clues take the remainder. A clue cut short is still a reminder; a missing
	// objective reads as progress lost.
	const premiseRows = Math.min(2, Math.max(0, rows - 2));
	let left = rows - 1 - premiseRows;
	const doneRows = Math.min(outline.steps.length, Math.max(0, left - 1));
	left -= doneRows;
	const clueRows = outline.clues.length > 0 ? Math.max(0, left - 1) : 0;

	return (
		<Box flexDirection="column">
			<Rule width={width} label={`${outline.title} ${progress}`} />
			<Prose text={outline.premise} width={width} rows={premiseRows} color="gray" />
			{outline.steps.slice(-doneRows).map((step) => (
				<Text key={step.label} color={step.complete ? "green" : "white"} wrap="truncate">
					{step.complete ? "[x] " : "[~] "}
					{step.label}
				</Text>
			))}
			{clueRows > 0 && (
				<>
					<Rule width={width} label="clues" />
					{/* Newest last, like the story: this is read as a recap, not as a feed. */}
					{outline.clues.slice(-clueRows).map((clue) => (
						<Text key={clue} color="yellow" wrap="truncate">
							{"• "}
							{clue}
						</Text>
					))}
				</>
			)}
		</Box>
	);
}

function QuestsTab({
	state,
	hud,
	width,
	rows,
}: {
	state: GameState;
	hud: HudState;
	width: number;
	rows: number;
}) {
	const open = activeQuests(state);
	const outline = arcOutline(state.arc, state);

	// The story gets up to half the pane and no more: it is context, and the errand
	// with a bearing on it is what the player can act on right now.
	const storyRows = outline
		? Math.min(Math.floor(rows / 2), 4 + outline.steps.length + outline.clues.length)
		: 0;
	const questRows = rows - storyRows;

	if (open.length === 0) {
		return (
			<Box flexDirection="column">
				{outline && <MainQuest outline={outline} width={width} rows={storyRows} />}
				<Rule width={width} label="errands" />
				<Text color="gray">No active quests.</Text>
			</Box>
		);
	}

	// Where each errand was given, and which way that is from here. The quest log
	// is prose; in an infinite world prose is not enough to find a place again.
	const here = toChunk(state.player.x, state.player.y);
	const marks = new Map(questMarks(state).map((mark) => [mark.questId, mark]));

	const cursor = Math.min(hud.cursor, open.length - 1);
	const selected = open[cursor];
	const detail = detailRows(questRows, 8);
	const listRows = Math.max(1, questRows - detail - (detail > 0 ? 2 : 1));
	const mark = selected ? marks.get(selected.id) : undefined;
	const bearing = mark ? bearingTo(here.cx, here.cy, mark.cx, mark.cy) : undefined;

	// The objectives are the part worth the space — they are what the player is
	// checking — so they are budgeted first and the description takes the rest.
	const bearingRows = mark ? 1 : 0;
	const objectiveRows = Math.min(
		Math.max(selected?.objectives.length ?? 0, 1),
		Math.max(0, detail - bearingRows - 1),
	);
	const proseRows = Math.max(0, detail - bearingRows - objectiveRows);

	return (
		<Box flexDirection="column">
			{outline && <MainQuest outline={outline} width={width} rows={storyRows} />}
			<Rule width={width} label={`errands ${open.length}`} />
			<ScrollList
				count={open.length}
				cursor={cursor}
				rows={listRows}
				focus={hud.focus}
				render={(index) => {
					const quest = open[index];
					if (!quest) return null;
					return <Text color="cyan">{quest.name}</Text>;
				}}
			/>
			{detail > 0 && selected && (
				<>
					<Rule width={width} />
					{bearing ? (
						<Field
							label="bearing"
							value={`${bearing.compass} ${bearing.distance}`}
							width={width}
							color="magenta"
						/>
					) : mark ? (
						<Field label="bearing" value="you are here" width={width} color="green" />
					) : null}
					<Prose text={selected.description} width={width} rows={proseRows} color="gray" />
					{selected.objectives.length === 0 ? (
						// A quest can reach the log with nothing to track: the engine refuses
						// objectives that name things it cannot find, and says so rather than
						// showing an empty entry the player would read as broken.
						<Text color="yellow" wrap="truncate">
							{"[!] nothing here I can follow"}
						</Text>
					) : (
						selected.objectives.slice(0, objectiveRows).map((objective) => (
							<Text
								key={`${objective.kind}:${objective.target}`}
								color={objective.done ? "green" : "white"}
								wrap="truncate"
							>
								{objective.done ? "[x] " : "[ ] "}
								{describeObjective(objective)}
							</Text>
						))
					)}
				</>
			)}
		</Box>
	);
}

function JournalTab({
	state,
	hud,
	width,
	rows,
}: {
	state: GameState;
	hud: HudState;
	width: number;
	rows: number;
}) {
	// Newest first: the thing you want is almost always the thing that just
	// happened, and the log only grows.
	const entries = [...state.journal].reverse();
	if (entries.length === 0) {
		return (
			<Box flexDirection="column">
				<Rule width={width} label="journal" />
				<Text color="gray">Your journal is empty.</Text>
			</Box>
		);
	}

	// A scenario has a known number of beats, so it can say how far through you are.
	// An unbounded world cannot, and says nothing rather than inventing a total.
	const progress = arcProgress(state.arc, state);

	const detail = detailRows(rows, 4);
	const listRows = Math.max(1, rows - detail - (detail > 0 ? 2 : 1));
	const cursor = Math.min(hud.cursor, entries.length - 1);
	const selected = entries[cursor];

	return (
		<Box flexDirection="column">
			<Rule
				width={width}
				label={
					state.arc && progress.total > 0
						? `${state.arc.title} ${progress.opened}/${progress.total}`
						: `journal ${entries.length}`
				}
			/>
			<ScrollList
				count={entries.length}
				cursor={cursor}
				rows={listRows}
				focus={hud.focus}
				render={(index) => {
					const entry = entries[index];
					if (!entry) return null;
					return (
						<>
							{/* Colour carries the kind in the list, where there is no room to
							    name it; the rule above the detail spells it out. */}
							<Text color={KIND_COLOR[entry.kind] ?? "gray"}>{"• "}</Text>
							<Text>{entry.text}</Text>
						</>
					);
				}}
			/>
			{detail > 0 && selected && (
				<>
					<Rule width={width} label={selected.kind} />
					<Prose text={selected.text} width={width} rows={detail} color="gray" />
				</>
			)}
		</Box>
	);
}

const KIND_COLOR: Readonly<Record<string, string>> = {
	lore: "magenta",
	place: "cyan",
	rumor: "yellow",
	event: "green",
};
