import { Box, Text } from "ink";
import { useState } from "react";
import { CATALOGUE, costLabel, costRatio, modelChoice, priceLine } from "../../ai/catalogue.js";
import { type Duration, normalizeBrief } from "../../core/world/brief.js";
import type { GenerateRequest } from "../../scenario/scenario.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";
import { TextField } from "./text-field.js";

/**
 * What to write, asked before anything is written.
 *
 * Every setting here is one that cannot be changed afterwards without generating a
 * different world, which is why they are asked up front rather than being buried in a
 * config file: the length decides the size of the map as well as the number of story
 * beats, the packs decide what everything is called and what it looks like, and the clock
 * decides whether people keep to a routine. A player who picked wrong has paid for a
 * world they did not want, so the page says what each choice costs before it is made.
 *
 * A settings page rather than a wizard. Six questions across six screens would make the
 * defaults invisible, and the defaults are the answer for most of them.
 */

/** Border and padding, taken off before anything is laid out inside the frame. */
const CHROME = FRAME_CHROME + 4;

/** The heading, the blank under it, the cost line, its blank, and the footer. */
const PAGE_CHROME = 5;

const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

/** The built-in look and the built-in tables, offered as a choice like any other. */
const DEFAULT_PACK = "the default";

const DURATIONS: readonly Duration[] = ["short", "medium", "long"];

/**
 * Roughly what each length costs, for the line under the settings.
 *
 * Model calls, because that is the number that turns into money and minutes: one per
 * region, one per place, one per person for their conversation, plus a handful for the
 * world's shape, its lore and its plot. Approximate on purpose — the real count depends
 * on how many places the seed put inside the boundary, which nothing knows yet — and
 * rounded so nobody reads it as a quote.
 */
const COST: Readonly<Record<Duration, { calls: string; minutes: string }>> = {
	short: { calls: "30", minutes: "1–2" },
	medium: { calls: "60", minutes: "2–4" },
	long: { calls: "120", minutes: "4–8" },
};

export interface GenerateConfigProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/** Tile packs found on disk. The default look is offered alongside them. */
	readonly tilePacks: readonly string[];
	/** Content packs found on disk, likewise. */
	readonly contentPacks: readonly string[];
	/** A premise from the environment, offered as a starting point. */
	readonly initialPremise?: string;
	/** The catalogue id currently in force. Absent means the built-in default. */
	readonly modelSet?: string;
	/**
	 * Reported as the cursor moves through the models, not on beginning.
	 *
	 * The choice is remembered for the next world as well as spent on this one —
	 * it is a machine setting that happens to be reachable from here, because here
	 * is where somebody is thinking about what a world is worth.
	 */
	readonly onModelSet?: (id: string) => void;
	readonly onBegin: (request: GenerateRequest) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function GenerateConfig({
	columns,
	rows,
	depth,
	tilePacks,
	contentPacks,
	initialPremise = "",
	modelSet,
	onModelSet,
	onBegin,
	onBack,
	isActive = true,
}: GenerateConfigProps) {
	const [duration, setDuration] = useState<Duration>("medium");
	const [models, setModels] = useState(() => modelChoice(modelSet).id);
	const [premise, setPremise] = useState(initialPremise);
	const [tiles, setTiles] = useState(DEFAULT_PACK);
	const [pack, setPack] = useState(DEFAULT_PACK);
	const [dayAndNight, setDayAndNight] = useState(true);
	const [liveInGame, setLiveInGame] = useState(true);
	const [editing, setEditing] = useState(false);

	// The default is offered first in both lists, so ← from it wraps to a real pack
	// rather than to nothing.
	const tileChoices = [DEFAULT_PACK, ...tilePacks];
	const packChoices = [DEFAULT_PACK, ...contentPacks];

	const chosen = modelChoice(models);
	const modelIds = CATALOGUE.map((entry) => entry.id);

	const items: ChoiceItem[] = [
		{
			id: "length",
			label: "Length",
			detail: duration,
			body: "How long the story runs, and how much world it runs across — in a bounded world those are one knob. A short world is a handful of places and three beats.",
		},
		{
			id: "premise",
			label: "Premise",
			// The premise itself, not a word standing for it. This is the setting a player is
			// most likely to want to re-read before committing several minutes to it, and
			// putting it only in the paragraph means it is invisible unless the cursor happens
			// to be resting here.
			detail: premise.trim() ? `“${clamp(premise.trim(), 48)}”` : "let the model choose",
			body: premise.trim()
				? premise.trim()
				: "What the world should be about. Optional — with nothing here the model picks a premise as well, which is one fewer decision and no worse a world.",
		},
		{
			id: "model",
			label: "Model",
			detail: `${chosen.label} · ${costLabel(chosen)}`,
			// The two models and both prices, because this is the only row on the page
			// whose cost is not already in the line at the bottom, and "6.6× the
			// default" is only useful next to what the default was.
			body: `${chosen.note} ${chosen.provider}: ${priceLine(chosen.prose.price)}${
				chosen.fast.model === chosen.prose.model
					? "."
					: `, with ${chosen.fast.model} at ${priceLine(chosen.fast.price)} for the bookkeeping.`
			}`,
		},
		{
			id: "tiles",
			label: "Look",
			detail: tiles,
			body:
				tilePacks.length > 0
					? "Which tile pack draws the map. Only affects what you see; the world is the same either way."
					: "Which tile pack draws the map. None are installed, so this is the built-in look.",
			...(tilePacks.length === 0 ? { disabled: true } : {}),
		},
		{
			id: "pack",
			label: "Names and trades",
			detail: pack,
			body:
				contentPacks.length > 0
					? "Which content pack the people and places are named from, and what they deal in. A register rather than a language: this is what makes one world sound unlike another."
					: "Which content pack names the people and places. None are installed, so this is the built-in set.",
			...(contentPacks.length === 0 ? { disabled: true } : {}),
		},
		{
			id: "clock",
			label: "Day and night",
			detail: dayAndNight ? "on" : "off",
			body: dayAndNight
				? "The hour advances, the light changes with it, and people keep to a routine — so who is at the forge depends on when you get there."
				: "The clock is frozen at morning. Everybody stays where they are put, which makes a story easier to follow and the world less alive.",
		},
		{
			id: "live",
			label: "Improvise while playing",
			detail: liveInGame ? "on" : "off",
			body: liveInGame
				? "Anyone the author did not write a conversation for can still hold one, invented as you speak to them. Costs a call per reply, and each is kept, so the same exchange is never paid for twice."
				: "Nobody says anything that was not written down in advance. Free to play, entirely offline, and the same every time.",
		},
		{
			id: "begin",
			label: "Write this world",
			accent: "green",
			body: "Kept in .scenarios when it is done, so this world can be played again without being paid for again.",
		},
	];

	const cycle = (item: ChoiceItem | undefined, step: -1 | 1): void => {
		switch (item?.id) {
			case "length":
				setDuration((current) => next(DURATIONS, current, step));
				return;
			case "model":
				setModels((current) => {
					const to = next(modelIds, current, step);
					// Reported as it changes rather than on beginning, so the choice is
					// still remembered by a player who wandered in, compared the prices and
					// went away again without writing anything.
					onModelSet?.(to);
					return to;
				});
				return;
			case "tiles":
				if (tilePacks.length > 0) setTiles((current) => next(tileChoices, current, step));
				return;
			case "pack":
				if (contentPacks.length > 0) setPack((current) => next(packChoices, current, step));
				return;
			case "clock":
				setDayAndNight((current) => !current);
				return;
			case "live":
				setLiveInGame((current) => !current);
				return;
			default:
				return;
		}
	};

	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>{"  and then it will be written"}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					// Kept mounted while the premise is being typed, and merely deafened. The
					// cursor lives inside `Chooser`, so unmounting it to show the field sent the
					// player back to the top of the page every time they wrote a premise —
					// and `isActive` is exactly the seam that lets both exist without both
					// acting on the same keypress.
					isActive={isActive && !editing}
					onBack={onBack}
					onCycle={cycle}
					onChoose={(item) => {
						if (item.id === "premise") {
							setEditing(true);
							return;
						}
						if (item.id === "begin") {
							onBegin({
								brief: normalizeBrief({ premise, duration }) ?? { duration },
								...(tiles === DEFAULT_PACK ? {} : { tiles }),
								...(pack === DEFAULT_PACK ? {} : { pack }),
								models,
								dayAndNight,
								liveInGame,
							});
							return;
						}
						// ENTER on a setting moves it on as well, so the page can be answered
						// without anybody having to discover that the horizontal arrows do
						// something here that they do not do anywhere else in the launcher.
						cycle(item, 1);
					}}
				/>
			</Box>

			{editing ? (
				// In the two rows the cost and the footer normally occupy, so the frame keeps
				// its height and the settings stay readable above while the premise is written.
				<TextField
					value={premise}
					onChange={setPremise}
					placeholder="a drowned archipelago run by debt-collectors"
					onSubmit={() => setEditing(false)}
					onCancel={() => setEditing(false)}
				/>
			) : (
				/* A line of its own rather than part of the "begin" row's paragraph, because a
				   paragraph is only drawn while the cursor is on it — and on a short terminal
				   only *one* paragraph is drawn at a time. The number that decides whether to
				   press ENTER at all has to be readable without hunting for it. */
				<Text wrap="truncate">
					<Text color="yellow">{`~${COST[duration].calls} model calls on ${chosen.label}`}</Text>
					<Text
						dimColor
					>{`, about ${COST[duration].minutes} minutes${relative(models)}, and it cannot be paused.`}</Text>
				</Text>
			)}

			<Text dimColor wrap="truncate">
				{editing
					? "A sentence is plenty. Empty means the model picks one. ENTER to keep it, ESC to drop it."
					: "↑↓ move · ←→ change · ENTER choose · ESC back"}
			</Text>
		</Frame>
	);
}

/**
 * What the chosen model does to the bill, as a clause or as nothing.
 *
 * Silent on the default, because "at the usual price" is noise on the line a
 * player reads before every world they write. It only speaks up once the answer
 * has stopped being the one they did not choose.
 */
function relative(id: string): string {
	const ratio = costRatio(modelChoice(id));
	if (Math.abs(ratio - 1) < 0.05) return "";
	return ratio < 1
		? `, at about ${ratio.toFixed(1)}× the usual price`
		: `, at about ${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}× the usual price`;
}

/** Enough of a premise to recognise it by, with an ellipsis where the rest was. */
function clamp(text: string, width: number): string {
	return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** The next value along, wrapping at both ends. */
function next<T>(values: readonly T[], current: T, step: number): T {
	if (values.length === 0) return current;
	const at = values.indexOf(current);
	const to = ((at < 0 ? 0 : at) + step + values.length) % values.length;
	return values[to] as T;
}

const HEADING = "Write a world";
