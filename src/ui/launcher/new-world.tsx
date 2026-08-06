import { Box, Text } from "ink";
import type { ScenarioSummary } from "../../scenario/repo.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";

/**
 * Where a world comes from: one somebody wrote, or one written to order.
 *
 * This used to offer four ways to start — briefed, unguided, without a model, and a
 * written scenario — which was four points on one axis pretending to be four kinds of
 * thing. The axis is *how much of the world is decided before you walk into it*, and the
 * far end turned out to be the only end worth being at: a world with a plotted story,
 * named people and written conversations beats one that invents them as you arrive, and
 * it costs a wait rather than a compromise. So there are two rows' worth of choice here
 * now, and they differ only in whether the waiting has already been done for you.
 *
 * The finished ones come first. Generating sits under a rule because it is the same kind
 * of world arrived at the long way round, and a player should see that at a glance
 * instead of reading four paragraphs to work it out.
 */

/** Border and padding, taken off before anything is laid out inside the frame. */
const CHROME = FRAME_CHROME + 4;

/** The heading, the blank under it, and the footer. */
const PAGE_CHROME = 3;

/**
 * The ramp the heading is lit with, the same one the title screen uses.
 *
 * Lamplight down into deep water, both already in the map's palette — so the launcher is
 * in the same key as the game behind it rather than being decorated separately.
 */
const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

/**
 * Colours the authored scenarios are labelled with, in order.
 *
 * Ink colour names rather than hex, so a row degrades with the terminal instead of asking
 * what it can do — this screen is drawn before anything has been established about it.
 * Which scenario gets which colour carries no meaning; the point is only that the shelf
 * reads as several distinct things. Cyan is deliberately absent, because the cursor needs
 * it and a list where every row is coloured has no spare colour left to mean "here".
 */
const SHELF: readonly string[] = ["green", "magenta", "yellow", "blue", "red", "white"];

export interface NewWorldProps {
	readonly scenarios: readonly ScenarioSummary[];
	/** Terminal size. The paragraphs wrap to it rather than to a guess. */
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	readonly canUseModel: boolean;
	/** Why generating is not on offer, when it is not, in the caller's words. */
	readonly unavailableNote?: string;
	readonly onScenario: (scenario: ScenarioSummary) => void;
	readonly onGenerate: () => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

/** The row id a scenario is offered under. Prefixed so it cannot collide with `generate`. */
function rowId(scenario: ScenarioSummary): string {
	return `scenario:${scenario.id}`;
}

export function NewWorld({
	scenarios,
	columns,
	rows,
	depth,
	canUseModel,
	unavailableNote,
	onScenario,
	onGenerate,
	onBack,
	isActive = true,
}: NewWorldProps) {
	const items: ChoiceItem[] = scenarios.map((scenario, index) => ({
		id: rowId(scenario),
		label: scenario.title,
		detail: `${scenario.siteCount} places`,
		accent: SHELF[index % SHELF.length] as string,
		...(scenario.blurb ? { body: scenario.blurb } : {}),
	}));

	items.push({
		id: "generate",
		label: "Generate a New Scenario",
		detail: "a few minutes",
		// No rule when it is the only row: a separator with nothing above it separates
		// nothing, and reads as a heading for a list of one.
		...(scenarios.length > 0 ? { rule: "or have one written" } : {}),
		accent: "cyan",
		body: canUseModel
			? "Written to order: the country, the towns, the people in them and a story running through the lot. Takes a few minutes, and is kept — so you can play the same world again exactly."
			: (unavailableNote ??
				"Written to order. Not available here: there is no model to write it with."),
		...(canUseModel ? {} : { disabled: true }),
	});

	// One row, so `rampRows` returns one string. The fallback is for `depth: "none"`,
	// where it hands the text back unchanged rather than colouring it.
	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>
					{scenarios.length > 0
						? "  something written, or something written for you"
						: "  nothing written here yet, so let it be written"}
				</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					isActive={isActive}
					onBack={onBack}
					onChoose={(item) => {
						if (item.id === "generate") {
							onGenerate();
							return;
						}
						const scenario = scenarios.find((each) => rowId(each) === item.id);
						if (scenario) onScenario(scenario);
					}}
				/>
			</Box>

			<Text dimColor wrap="truncate">
				{"↑↓ move · ENTER choose · ESC back"}
			</Text>
		</Frame>
	);
}

const HEADING = "A new world";
