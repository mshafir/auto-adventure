import { Box, Text } from "ink";
import type { ScenarioSummary } from "../../scenario/repo.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";

/**
 * Where a world comes from: one somebody wrote, or one that invents itself as you walk.
 *
 * The axis is *how much of the world is decided before you walk into it*, and both ends
 * are worth being at. A written scenario has a plotted story, named people, written
 * conversations and cutscenes; an unwritten one is endless and has none of those, and
 * names its towns as you reach them.
 *
 * What is deliberately absent is a way to *make* a written scenario from here. Authoring
 * is a dev-time activity now — an agent driving the `craft` CLI, taking as long as it
 * takes — and its output is a directory in `.scenarios/` that shows up in this list like
 * anything else. The row that used to promise "a few minutes" was promising the pipeline
 * that produced worlds whose people asked after documents that did not exist.
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
	/**
	 * Whether a model can be reached.
	 *
	 * An unwritten world is playable either way — `procedural` names its places from the
	 * flavour tables rather than asking anybody — so this changes what the row promises
	 * rather than whether it is on offer.
	 */
	readonly canUseModel: boolean;
	/** Why a live world is not on offer, when it is not, in the caller's words. */
	readonly unavailableNote?: string;
	readonly onScenario: (scenario: ScenarioSummary) => void;
	/** Start an endless world. Live when a model can be reached, procedural otherwise. */
	readonly onUnwritten: (flavour: "live" | "procedural") => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

/** The row id a scenario is offered under. Prefixed so it cannot collide with `unwritten`. */
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
	onUnwritten,
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
		id: "unwritten",
		label: "An unwritten world",
		detail: canUseModel ? "endless" : "endless, offline",
		// No rule when it is the only row: a separator with nothing above it separates
		// nothing, and reads as a heading for a list of one.
		...(scenarios.length > 0 ? { rule: "or somewhere nobody has written about" } : {}),
		accent: "cyan",
		body: canUseModel
			? "No story and no ending: ground in every direction, and towns that are named and populated as you reach them. Nothing is decided until you get there, which also means nothing is waiting for you."
			: (unavailableNote ??
				"No story and no ending: ground in every direction, with places named out of the flavour tables rather than by a model. Free, offline, and the same world every time for a given seed."),
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
						? "  somewhere written, or somewhere nobody has been"
						: "  nothing written here yet"}
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
						if (item.id === "unwritten") {
							onUnwritten(canUseModel ? "live" : "procedural");
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
