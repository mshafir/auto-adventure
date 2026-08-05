import { Box, Text } from "ink";
import type { ScenarioSummary } from "../../scenario/repo.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ChoiceItem, Chooser } from "./chooser.js";

/**
 * The four ways to start a world, each with a paragraph.
 *
 * The old screen gave these five words apiece — "let the model invent a premise" —
 * and five words cannot carry what actually differs. Whether a model runs decides
 * whether the world costs money, whether it needs a network, whether the people in
 * it say things nobody wrote, and how long the first frame takes. A player choosing
 * between them deserves to know that before they choose, not after.
 *
 * All four on one page rather than a fresh screen per branch. A written scenario is
 * a way of starting a world like the others are, and putting it elsewhere would
 * make "New" mean "new *generated*" — a distinction that matters to the code and
 * not at all to the person reading the screen.
 */

export type NewChoice = "briefed" | "unguided" | "procedural";

/** Border and padding, taken off before anything is laid out inside the frame. */
const CHROME = FRAME_CHROME + 4;

/** The heading, the blank under it, and the footer. */
const PAGE_CHROME = 3;

export interface NewWorldProps {
	readonly scenarios: readonly ScenarioSummary[];
	/** Terminal size. The paragraphs wrap to it rather than to a guess. */
	readonly columns: number;
	readonly rows: number;
	readonly canUseModel: boolean;
	/** Why a live world is not on offer, in the caller's words. */
	readonly unavailableNote?: string;
	readonly onStart: (choice: NewChoice) => void;
	readonly onScenarios: () => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function NewWorld({
	scenarios,
	columns,
	rows,
	canUseModel,
	unavailableNote,
	onStart,
	onScenarios,
	onBack,
	isActive = true,
}: NewWorldProps) {
	// Shown greyed rather than hidden when there is no model: a player who has heard
	// the game writes its own worlds and cannot find the option assumes they have the
	// wrong build, rather than a missing key.
	const live = (id: string, label: string, body: string): ChoiceItem => ({
		id,
		label,
		body: canUseModel ? body : (unavailableNote ?? `${body} Not available here.`),
		...(canUseModel ? {} : { disabled: true }),
	});

	const items: ChoiceItem[] = [
		live(
			"briefed",
			"Briefed",
			"You say what the world should be about — a premise, a setting, a story — and a model writes the places and the people to match.",
		),
		live(
			"unguided",
			"Unguided",
			"A model invents the premise as well, and the world is discovered rather than asked for. Same cost, one fewer decision.",
		),
		{
			id: "procedural",
			label: "Without a model",
			body: "No network and no key. Every place is still named and peopled, and conversations are real dialogue trees rather than a model's replies.",
		},
		{
			id: "scenarios",
			label: "A written scenario",
			detail: scenarios.length === 0 ? "none installed" : `${scenarios.length} to choose from`,
			body:
				scenarios.length === 0
					? "A world authored ahead of time. There are none in .scenarios yet — `npm run author` makes one."
					: "Authored ahead of time — premise, towns, people and story all written down. Nothing arrives late, and no model runs while you play.",
			...(scenarios.length === 0 ? { disabled: true } : {}),
		},
	];

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					A new world
				</Text>
				<Text dimColor>{"  what should the game do for you?"}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					isActive={isActive}
					onBack={onBack}
					onChoose={(item) => {
						if (item.id === "scenarios") onScenarios();
						else onStart(item.id as NewChoice);
					}}
				/>
			</Box>

			<Text dimColor wrap="truncate">
				{"↑↓ move · ENTER choose · ESC back"}
			</Text>
		</Frame>
	);
}

/**
 * The scenarios themselves, once that road is taken.
 *
 * A page of its own because a scenario has a title and a blurb somebody wrote, and
 * those deserve the room — on the old flat list the blurb shared a line with the
 * title and was the first thing cut.
 */
export function ScenarioList({
	scenarios,
	columns,
	rows,
	onChoose,
	onBack,
	isActive = true,
}: {
	readonly scenarios: readonly ScenarioSummary[];
	readonly columns: number;
	readonly rows: number;
	readonly onChoose: (scenario: ScenarioSummary) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}) {
	const items: ChoiceItem[] = scenarios.map((scenario) => ({
		id: scenario.id,
		label: scenario.title,
		detail: `${scenario.siteCount} places`,
		...(scenario.blurb ? { body: scenario.blurb } : {}),
	}));

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold color="cyan">
					A written scenario
				</Text>
				<Text dimColor>{"  a world somebody wrote before you got here"}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					isActive={isActive}
					onBack={onBack}
					onChoose={(item) => {
						const scenario = scenarios.find((candidate) => candidate.id === item.id);
						if (scenario) onChoose(scenario);
					}}
				/>
			</Box>

			<Text dimColor wrap="truncate">
				{"↑↓ move · ENTER begin · ESC back"}
			</Text>
		</Frame>
	);
}
