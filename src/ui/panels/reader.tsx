import { Text } from "ink";
import { arcOutline } from "../../core/rules/arc.js";
import { bearingTo, questMarks } from "../../core/rules/quest-map.js";
import { describeObjective, questNeeding } from "../../core/rules/quests.js";
import { activeQuests, type GameState, type Quest } from "../../core/rules/state.js";
import { toChunk } from "../../core/world/coords.js";
import type { HudState, PanelTab } from "../hud-state.js";
import { mapLegend } from "./legend.js";
import { Bullet, Field, FRAME_CHROME, Frame, Prose, Rule, ScrollList } from "./primitives.js";

/**
 * A page, given the whole frame.
 *
 * Everything here is prose written for a human: a quest description, a journal
 * entry, a story clue. In the 32-column side panel this used to share with the map,
 * all of it arrived elided mid-sentence, and the elision fell on exactly the part
 * worth reading — the panel showed "The miller wants three…" and the rest was gone.
 *
 * Widening the panel was the wrong fix twice over: the map would pay for the columns,
 * and a pane tall enough to hold a quest log reaches the terminal height, at which
 * point Ink clears the screen on every keypress. Taking the frame for as long as
 * somebody is reading costs nothing when they are not — and it is the only shape
 * that works in pixel mode, where anything laid out beside the map cuts a row of
 * kitty placeholders in half.
 */

export interface ReaderProps {
	readonly state: GameState;
	readonly hud: HudState;
	readonly width: number;
	readonly height: number;
	/** Which page to draw. The caller has already decided one is open. */
	readonly tab: PanelTab;
}

/** How much of the frame the list of entries gets before the detail below it. */
const LIST_SHARE = 0.35;

export function Reader({ state, hud, width, height, tab }: ReaderProps) {
	// The border and the padding inside it come off before anything is laid out.
	// Every component here is told its size rather than measuring, because a pane
	// that grows to fit reaches the terminal height, and at that point Ink clears
	// the screen on every keypress.
	const inner = Math.max(20, width - FRAME_CHROME - 4);
	const rows = Math.max(3, height - FRAME_CHROME);
	return (
		<Frame style="reader" width={width} height={height}>
			{tab === "quests" && <QuestReader state={state} hud={hud} width={inner} rows={rows} />}
			{tab === "journal" && <JournalReader state={state} hud={hud} width={inner} rows={rows} />}
			{tab === "inventory" && <InventoryReader state={state} hud={hud} width={inner} rows={rows} />}
			{tab === "key" && <KeyReader width={inner} rows={rows} />}
		</Frame>
	);
}

/**
 * What the glyphs on the map mean.
 *
 * A page of its own because the map is full width now and there is no panel to
 * put a key in. That is no loss: read at full width it fits in one column with
 * room for the labels, where in the panel it was a two-column grid the bottom of
 * which fell off a short terminal.
 */
function KeyReader({ width, rows }: { width: number; rows: number }) {
	const entries = mapLegend().slice(0, Math.max(0, rows - 1));
	return (
		<>
			<Rule width={width} label="what you are looking at" />
			{entries.map((entry) => (
				<Text key={entry.label} wrap="truncate">
					<Text bold={entry.bold ?? false} color={entry.color}>
						{entry.ch}
					</Text>
					<Text color="gray">{`  ${entry.label}`}</Text>
				</Text>
			))}
		</>
	);
}

/**
 * The story in full, then the errands, then the one under the cursor in full.
 *
 * The arc comes first and is never scrolled past: it is the answer to "what am I
 * doing", and in the panel its clues were the first thing cut. Here every step and
 * every clue is shown, on a line each, at full width.
 */
function QuestReader({
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
	const cursor = Math.min(hud.cursor, Math.max(0, open.length - 1));
	const selected = open[cursor];

	// Clues are two or three sentences each and wrap, so the story block asks for
	// room per clue rather than per line. Capped at two thirds of the frame: the story
	// is why the player opened this, but the errand it handed out still has to fit.
	const CLUE_ROWS = 3;
	const storyWanted = outline
		? 5 +
			outline.steps.length +
			(outline.remaining > 0 ? 1 : 0) +
			(outline.finished ? 1 : 0) +
			outline.clues.length * CLUE_ROWS
		: 0;
	const storyRows = Math.min(storyWanted, Math.floor((rows * 2) / 3));
	const left = rows - storyRows;
	const listRows = Math.max(1, Math.min(open.length + 1, Math.floor(left * LIST_SHARE)));
	const detailRows = Math.max(0, left - listRows - 2);

	return (
		<>
			{outline && storyRows > 3 && (
				<>
					<Rule
						width={width}
						label={`${outline.title} — ${outline.finished ? "the story, told" : "the story so far"}`}
					/>
					<Prose text={outline.premise} width={width} rows={3} color="gray" />
					{outline.steps.map((step) => (
						<Text key={step.label} color={step.complete ? "green" : "white"} wrap="truncate">
							{step.complete ? "[x] " : "[~] "}
							{step.label}
						</Text>
					))}
					{outline.remaining > 0 && (
						<Text color="gray" wrap="truncate">
							{`    …and ${outline.remaining} more to come`}
						</Text>
					)}
					{outline.finished && (
						<Text color="green" wrap="truncate">
							The story is told. Nothing is waiting on you now.
						</Text>
					)}
					{outline.clues.length > 0 && (
						<>
							<Rule width={width} label="clues" />
							{outline.clues.map((clue) => (
								<Bullet key={clue} text={clue} width={width} rows={CLUE_ROWS} color="yellow" />
							))}
						</>
					)}
				</>
			)}

			<Rule width={width} label={open.length > 0 ? `errands ${open.length}` : "errands"} />
			{open.length === 0 ? (
				<Text color="gray">Nobody has asked anything of you.</Text>
			) : (
				<ScrollList
					count={open.length}
					cursor={cursor}
					rows={listRows}
					focus
					render={(index) => {
						const quest = open[index];
						if (!quest) return null;
						const done = quest.objectives.filter((objective) => objective.done).length;
						return (
							<>
								<Text color="cyan">{quest.name}</Text>
								{quest.objectives.length > 0 && (
									<Text color="gray">{`  ${done}/${quest.objectives.length}`}</Text>
								)}
							</>
						);
					}}
				/>
			)}

			{selected && detailRows > 0 && (
				<QuestDetail state={state} quest={selected} width={width} rows={detailRows} />
			)}
		</>
	);
}

function QuestDetail({
	state,
	quest,
	width,
	rows,
}: {
	state: GameState;
	quest: Quest;
	width: number;
	rows: number;
}) {
	const here = toChunk(state.player.x, state.player.y);
	const mark = questMarks(state).find((candidate) => candidate.questId === quest.id);
	const bearing = mark ? bearingTo(here.cx, here.cy, mark.cx, mark.cy) : undefined;

	// Objectives and the progress notes are lines; the description is the only part
	// that wraps, so it gets whatever the rest leaves.
	const fixed = quest.objectives.length + quest.progress.length + (mark ? 1 : 0);
	const proseRows = Math.max(1, rows - fixed - 1);

	return (
		<>
			<Rule width={width} label={quest.name} />
			{mark && (
				<Field
					label="given in"
					value={bearing ? `${bearing.compass} ${bearing.distance} chunks off` : "you are here"}
					width={width}
					color={bearing ? "magenta" : "green"}
				/>
			)}
			<Prose text={quest.description} width={width} rows={proseRows} color="gray" />
			{quest.objectives.length === 0 ? (
				<Text color="yellow" wrap="truncate">
					{"[!] nothing here I can follow"}
				</Text>
			) : (
				quest.objectives.map((objective) => (
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
			{quest.progress.map((note) => (
				<Text key={note} color="gray" wrap="truncate">
					{"· "}
					{note}
				</Text>
			))}
		</>
	);
}

/**
 * The log, newest first, with the selected entry in full.
 *
 * The list is where a clue was being cut to a third of a line; here it is one line
 * per entry across the whole frame, and the entry under the cursor is wrapped out in
 * full below.
 */
function JournalReader({
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
	const entries = [...state.journal].reverse();
	if (entries.length === 0) {
		return (
			<>
				<Rule width={width} label="journal" />
				<Text color="gray">Nothing has happened worth writing down.</Text>
			</>
		);
	}

	const cursor = Math.min(hud.cursor, entries.length - 1);
	const selected = entries[cursor];
	const detail = Math.min(6, Math.max(3, Math.floor(rows * 0.3)));
	const listRows = Math.max(1, rows - detail - 2);

	return (
		<>
			<Rule width={width} label={`journal ${entries.length}`} />
			<ScrollList
				count={entries.length}
				cursor={cursor}
				rows={listRows}
				focus
				render={(index) => {
					const entry = entries[index];
					if (!entry) return null;
					return (
						<>
							<Text color={KIND_COLOR[entry.kind] ?? "gray"}>{`[${entry.kind}] `}</Text>
							<Text>{entry.text}</Text>
						</>
					);
				}}
			/>
			{selected && (
				<>
					{/* The kind, not the source: a source is an internal id — "weight",
					    "arc:the-short-tally" — and reading one in a heading is reading the
					    implementation. It earns its keep as a filter, not as a label. */}
					<Rule width={width} label={selected.kind} />
					<Prose text={selected.text} width={width} rows={detail} />
				</>
			)}
		</>
	);
}

const KIND_COLOR: Readonly<Record<string, string>> = {
	lore: "magenta",
	place: "cyan",
	rumor: "yellow",
	event: "green",
};

function InventoryReader({
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
			<>
				<Rule width={width} label="carrying" />
				<Text color="gray">You are carrying nothing at all.</Text>
			</>
		);
	}

	const cursor = Math.min(hud.cursor, items.length - 1);
	const held = items[cursor];
	const wanted = held ? questNeeding(state, held.name) : undefined;
	const detail = Math.min(6, Math.max(3, Math.floor(rows * 0.3)));
	const listRows = Math.max(1, rows - detail - 2);

	return (
		<>
			<Rule width={width} label={`carrying ${items.length}`} />
			<ScrollList
				count={items.length}
				cursor={cursor}
				rows={listRows}
				focus
				render={(index) => {
					const item = items[index];
					if (!item) return null;
					return (
						<>
							<Text>{item.name}</Text>
							{item.quantity > 1 && <Text color="gray">{`  x${item.quantity}`}</Text>}
						</>
					);
				}}
			/>
			{held && (
				<>
					<Rule width={width} label={held.name} />
					<Prose text={held.description} width={width} rows={detail} color="gray" />
					{wanted && (
						<Text color="yellow" wrap="truncate">
							{`Wanted for "${wanted.name}".`}
						</Text>
					)}
				</>
			)}
		</>
	);
}
