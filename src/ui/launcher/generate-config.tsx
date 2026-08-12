import { Box, Text } from "ink";
import { useState } from "react";
import type { Pitch } from "../../ai/author/pitch.js";
import { CATALOGUE, costLabel, costRatio, modelChoice, priceLine } from "../../ai/catalogue.js";
import type { PackEntry } from "../../content/load.js";
import { defaultTilePackEntry, type TilePackEntry } from "../../content/tiles.js";
import { DEFAULT_PACK as BUILT_IN } from "../../core/content/default.js";
import { type Duration, normalizeBrief } from "../../core/world/brief.js";
import type { GenerateRequest } from "../../scenario/scenario.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";
import { PickPremise } from "./pick-premise.js";
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

const DURATIONS: readonly Duration[] = ["tiny", "short", "medium", "long"];

/**
 * Roughly what each length costs, for the line under the settings.
 *
 * Model calls, because that is the number that turns into money and minutes: one per
 * region, one per place, one per person for their conversation, plus a handful for the
 * world's shape, its lore and its plot. Approximate on purpose — the real count depends
 * on how many places the seed put inside the boundary, which nothing knows yet — and
 * rounded so nobody reads it as a quote.
 *
 * The *minutes* are the part to distrust, and they are a range for a reason that is not
 * the seed. These were calibrated on Gemini Flash, which answers in a few seconds. A
 * reasoning model does not: a measured `tiny` run on `openai/gpt-5-mini` averaged 45
 * seconds a call and took fourteen minutes end to end, four-way concurrency and all.
 * The line under the settings therefore says which model the estimate assumes, rather
 * than quoting a number that is wrong by an order of magnitude for half the catalogue.
 */
const COST: Readonly<Record<Duration, { calls: string; minutes: string }>> = {
	tiny: { calls: "15", minutes: "1–2" },
	short: { calls: "30", minutes: "2–4" },
	medium: { calls: "60", minutes: "4–8" },
	long: { calls: "120", minutes: "8–15" },
};

/**
 * What each length is for, since one of them is not for playing.
 *
 * The paragraph used to be one sentence about the trade between story and map, which is
 * true of three of the four. `tiny` needs saying outright or somebody picks the cheapest
 * row expecting a small adventure and gets a proof that the machinery works.
 */
const LENGTHS: Readonly<Record<Duration, string>> = {
	tiny: "A test world: two beats, a few places, and written conversations only for the people the story turns on. Enough to see whether a premise becomes anything worth paying for, and not much of a game on its own.",
	short: "A handful of places and three beats. An evening.",
	medium: "The default. A dozen or so places, six beats, and room between them.",
	long: "A large map and ten beats, with side errands and forks in it. The dearest by some way.",
};

/**
 * A pack's own line, or an honest admission that it has none.
 *
 * A pack written before descriptions existed is still a good pack, so the fallback names
 * it rather than leaving the row blank — which would read as a pack that failed to load.
 */
function describe(
	entries: readonly { name: string; description?: string }[],
	name: string,
): string {
	const found = entries.find((entry) => entry.name === name);
	return found?.description ?? `“${name}”, which does not describe itself.`;
}

export interface GenerateConfigProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/**
	 * Tile packs found on disk, with their descriptions and previews already resolved.
	 *
	 * Resolved by the caller rather than here, because reading a pack means reading a
	 * manifest, decoding a PNG and building two glyph tables — and this module is a
	 * component. It is the same rule `content/tiles.ts` states from the other side:
	 * `ui/render` has to stay callable with no `.packs` directory anywhere.
	 */
	readonly tilePacks: readonly TilePackEntry[];
	/** Content packs found on disk, likewise. */
	readonly contentPacks: readonly PackEntry[];
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
	/**
	 * Writes a few worlds to choose between, when there is a model to write them with.
	 *
	 * Absent means the Premise row offers only the two answers that need nobody: type one,
	 * or leave it to the lore pass. Passed down rather than imported so this page renders in
	 * a test with no gateway key.
	 *
	 * Takes the duration because the length is state *here* and the call needs it — see the
	 * `suggest` binding below. The alternative was reading the environment's duration in
	 * `pick-launch.tsx`, which compiles and sends the wrong length to the model.
	 */
	readonly onSuggest?: (input: {
		readonly duration: Duration;
		readonly hint?: string;
		readonly avoid?: readonly string[];
	}) => Promise<readonly Pitch[]>;
	readonly onBegin: (request: GenerateRequest) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

/**
 * Which of the three ways into a premise is on screen.
 *
 * `how` and `suggest` take the whole frame; `type` shares it with the settings, in the two
 * rows the cost line normally occupies.
 */
type PremiseWay = "none" | "how" | "suggest" | "type";

export function GenerateConfig({
	columns,
	rows,
	depth,
	tilePacks,
	contentPacks,
	initialPremise = "",
	modelSet,
	onModelSet,
	onSuggest,
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
	// Set only by choosing an offered world. A premise typed by hand leaves both empty, which
	// is what keeps a hand-written brief behaving exactly as it did.
	const [title, setTitle] = useState("");
	const [tone, setTone] = useState("");
	const [premiseWay, setPremiseWay] = useState<PremiseWay>("none");
	// Whether the premise has ever been asked about, which is what decides where the settings
	// list opens once it comes back. Not the same as "a premise was chosen": a player who went
	// to look and came back with nothing still left the page from that row.
	const [askedAboutPremise, setAskedAboutPremise] = useState(false);

	// The default is offered first in both lists, so ← from it wraps to a real pack
	// rather than to nothing. It carries a description and a preview of its own, so
	// the built-in look is not the one option a player has to take on trust.
	const tileEntries = [defaultTilePackEntry(DEFAULT_PACK), ...tilePacks];
	// The built-in pack describes itself, so the line here is the same line a file would
	// carry — rather than a second copy of it written for the launcher and free to drift.
	const packEntries: readonly PackEntry[] = [
		{
			name: DEFAULT_PACK,
			...(BUILT_IN.description ? { description: BUILT_IN.description } : {}),
		},
		...contentPacks,
	];
	const tileChoices = tileEntries.map((entry) => entry.name);
	const packChoices = packEntries.map((entry) => entry.name);
	const tilePreview = tileEntries.find((entry) => entry.name === tiles)?.preview ?? [];

	const chosen = modelChoice(models);
	const modelIds = CATALOGUE.map((entry) => entry.id);

	const items: ChoiceItem[] = [
		{
			id: "length",
			label: "Length",
			detail: duration,
			body: `How long the story runs, and how much world it runs across — in a bounded world those are one knob. ${LENGTHS[duration]}`,
		},
		{
			id: "premise",
			label: "Premise",
			// The premise itself, not a word standing for it. This is the setting a player is
			// most likely to want to re-read before committing several minutes to it, and
			// putting it only in the paragraph means it is invisible unless the cursor happens
			// to be resting here. The title wins where there is one: a player who chose a world
			// by its name recognises it by that name and not by its first forty characters.
			detail: title
				? `“${clamp(title, 48)}”`
				: premise.trim()
					? `“${clamp(premise.trim(), 48)}”`
					: "let the model choose",
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
			// The speed caveat belongs here rather than on the cost line, which is the one
			// row that must never be cut: it is already the longest thing on the page and
			// the number a player reads before pressing ENTER.
			body: `${chosen.note} ${chosen.provider}: ${priceLine(chosen.prose.price)}${
				chosen.fast.model === chosen.prose.model
					? "."
					: `, with ${chosen.fast.model} at ${priceLine(chosen.fast.price)} for the bookkeeping.`
			} The minutes below assume a fast model; a reasoning model thinks for most of a minute per call and takes several times as long.`,
		},
		{
			id: "tiles",
			label: "Look",
			detail: tiles,
			// The chosen pack's own line, not a sentence about the setting. What a player
			// needs here is "which of these six is the cold one", and a description of the
			// *knob* answers that for none of them. The reminder that a look changes nothing
			// about the world is appended, because it is the one thing the picture cannot say.
			body:
				tilePacks.length > 0
					? `${describe(tileEntries, tiles)} Only affects what you see; the world is the same either way.`
					: "Which tile pack draws the map. None are installed, so this is the built-in look.",
			...(tilePreview.length > 0 ? { preview: tilePreview } : {}),
			...(tilePacks.length === 0 ? { disabled: true } : {}),
		},
		{
			id: "pack",
			label: "Names and trades",
			detail: pack,
			body:
				contentPacks.length > 0
					? `${describe(packEntries, pack)} A register rather than a language: this is what makes one world sound unlike another.`
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

	// Both of these take the whole frame, so the settings list unmounts under them — which is
	// why it is told to open on `premise` when it comes back. See `Chooser.initialId`.
	if (premiseWay === "suggest" && onSuggest) {
		return (
			<PickPremise
				columns={columns}
				rows={rows}
				depth={depth}
				duration={duration}
				{...(premise.trim() ? { hint: premise.trim() } : {})}
				// The duration is closed over here rather than asked of the caller, because the
				// length is this page's state and `PickPremise` must not import the AI layer.
				suggest={(input) => onSuggest({ duration, ...input })}
				onChoose={(pitch) => {
					setTitle(pitch.title);
					setTone(pitch.tone);
					setPremise(pitch.premise);
					setPremiseWay("none");
				}}
				onBack={() => setPremiseWay("none")}
			/>
		);
	}

	if (premiseWay === "how") {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{rampRows([WAYS_HEADING], RAMP, depth)[0] ?? WAYS_HEADING}</Text>
					<Text dimColor>{"  the one decision everything else is written around"}</Text>
				</Box>

				<Box flexGrow={1} flexDirection="column">
					<Chooser
						// Keyed apart from the settings list below. Both pages are a `Frame` holding a
						// `Chooser` in the same position, so without distinct keys React reconciles
						// them as one component and this list opens on whatever row the settings
						// cursor was on — which is the Premise row, so it opened on "Type it myself".
						key="premise-way"
						items={wayItems(Boolean(onSuggest))}
						width={columns - CHROME}
						height={rows - FRAME_CHROME - PAGE_CHROME}
						isActive={isActive}
						onBack={() => setPremiseWay("none")}
						onChoose={(item) => {
							if (item.id === "way:model") {
								// Emptied rather than kept and ignored: the row above now says "let the
								// model choose", and a premise still sitting in the state would be sent
								// with the request and quietly obeyed.
								setPremise("");
								setTitle("");
								setTone("");
								setPremiseWay("none");
								return;
							}
							setPremiseWay(item.id === "way:suggest" ? "suggest" : "type");
						}}
					/>
				</Box>

				<Text dimColor wrap="truncate">
					{"↑↓ move · ENTER choose · ESC back"}
				</Text>
			</Frame>
		);
	}

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>{"  and then it will be written"}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					key="settings"
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					// Kept mounted while the premise is being typed, and merely deafened. The
					// cursor lives inside `Chooser`, so unmounting it to show the field sent the
					// player back to the top of the page every time they wrote a premise —
					// and `isActive` is exactly the seam that lets both exist without both
					// acting on the same keypress.
					isActive={isActive && premiseWay !== "type"}
					// Opened on the Premise row once it is what sent the player away, so coming
					// back from a screen of its own lands on the setting just decided rather than
					// at the top of the page. Explicit rather than left to React reusing this list
					// across the two pages, which is what happened before they were keyed apart —
					// and which put the *other* page's cursor in the wrong place instead.
					{...(askedAboutPremise ? { initialId: "premise" } : {})}
					onBack={onBack}
					onCycle={cycle}
					onChoose={(item) => {
						if (item.id === "premise") {
							setAskedAboutPremise(true);
							setPremiseWay("how");
							return;
						}
						if (item.id === "begin") {
							onBegin({
								// `normalizeBrief` drops the empty strings, so a hand-typed premise
								// produces exactly the brief it produced before any of this existed.
								brief: normalizeBrief({ premise, title, tone, duration }) ?? { duration },
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

			{premiseWay === "type" ? (
				// In the two rows the cost and the footer normally occupy, so the frame keeps
				// its height and the settings stay readable above while the premise is written.
				<TextField
					value={premise}
					onChange={setPremise}
					placeholder="a drowned archipelago run by debt-collectors"
					onSubmit={() => setPremiseWay("none")}
					onCancel={() => setPremiseWay("none")}
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
				{premiseWay === "type"
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

/**
 * The three ways a world gets a premise.
 *
 * Suggesting comes first because it is the only one a player cannot discover for themselves:
 * the other two were both already reachable from an empty text field, and this one is the
 * reason the field is no longer the first thing on screen. Shown and disabled without a
 * model rather than hidden, for the reason `ChoiceItem.disabled` gives.
 */
function wayItems(canSuggest: boolean): ChoiceItem[] {
	return [
		{
			id: "way:suggest",
			label: "Suggest some for me",
			accent: "cyan",
			body: canSuggest
				? "Four worlds, written now and read before anything is paid for: a name, a register and a paragraph each. Take one, ask for four more, or go back and write your own."
				: "Not available here: there is no model to write them with.",
			...(canSuggest ? {} : { disabled: true }),
		},
		{
			id: "way:type",
			label: "Type it myself",
			accent: "green",
			body: "A sentence about what the world is about. Followed closely — where it is specific the author obeys it, and where it is silent the author invents.",
		},
		{
			id: "way:model",
			label: "Let the model choose",
			accent: "yellow",
			body: "Say nothing, and the premise is invented along with the rest of the lore. One fewer decision, and no worse a world — but you find out what it is about once it is written.",
		},
	];
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

const WAYS_HEADING = "What is it about?";
