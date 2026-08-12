import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Pitch } from "../../ai/author/pitch.js";
import type { Duration } from "../../core/world/brief.js";
import { FRAME_CHROME, Frame } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { type ChoiceItem, Chooser } from "./chooser.js";
import { rampRows } from "./gradient.js";

/**
 * Four worlds, offered before one is paid for.
 *
 * The screen this exists to replace was a blank text field and a line saying the model would
 * pick a premise if it was left empty — which most players did, and which meant the first
 * thing they learned about a world they had just waited four minutes for was that nobody had
 * chosen it. A premise is the one decision that shapes everything downstream and the one
 * they had least help making.
 *
 * The call runs here rather than in `pickLaunch`, which is where the rest of the launcher's
 * model work is forbidden from happening. The rule it bends is real — an Ink app that awaits
 * for minutes is one that gets unmounted mid-`await` — and this is the case it does not
 * cover: one call, seconds not minutes, abortable, and useless anywhere else, because the
 * player has to see the answers to make the choice that produces the request.
 */

/** Border and padding, taken off before anything is laid out inside the frame. */
const CHROME = FRAME_CHROME + 4;

/** The heading, its blank, and the footer. */
const PAGE_CHROME = 3;

/** The same ramp the rest of the launcher's headings are lit with. */
const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

export interface PickPremiseProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/** How long the world will be, which changes what fits inside one. */
	readonly duration: Duration;
	/** Whatever the player had already typed, followed rather than embellished. */
	readonly hint?: string;
	/**
	 * The call, injected.
	 *
	 * The same rule the options page follows for the disk: this component has to render in a
	 * test with no gateway key, so it is handed the thing that needs one.
	 */
	readonly suggest: (input: {
		readonly hint?: string;
		readonly avoid?: readonly string[];
	}) => Promise<readonly Pitch[]>;
	readonly onChoose: (pitch: Pitch) => void;
	readonly onBack: () => void;
	readonly isActive?: boolean;
}

export function PickPremise({
	columns,
	rows,
	depth,
	duration,
	hint,
	suggest,
	onChoose,
	onBack,
	isActive = true,
}: PickPremiseProps) {
	const [pitches, setPitches] = useState<readonly Pitch[]>([]);
	const [working, setWorking] = useState(true);
	const [failed, setFailed] = useState(false);
	/*
	 * Every title offered so far, across every round.
	 *
	 * A ref rather than state because it is read inside the async callback below, where a
	 * captured piece of state would be whatever it was when the round started — so the third
	 * round would forget the first. Nothing renders from it, so nothing needs it to be state.
	 */
	const offered = useRef<string[]>([]);

	const ask = useCallback(async () => {
		setWorking(true);
		setFailed(false);
		// Never throws by contract, but this runs in a React effect where a rejected promise
		// is an unhandled rejection rather than a caught error, and a launcher that dies
		// because a premise could not be written is a launcher nobody can get past.
		let next: readonly Pitch[] = [];
		try {
			next = await suggest({
				...(hint ? { hint } : {}),
				...(offered.current.length > 0 ? { avoid: [...offered.current] } : {}),
			});
		} catch {
			next = [];
		}
		if (next.length === 0) {
			setFailed(true);
			setWorking(false);
			return;
		}
		offered.current = [...offered.current, ...next.map((pitch) => pitch.title)];
		setPitches(next);
		setWorking(false);
	}, [hint, suggest]);

	useEffect(() => {
		void ask();
	}, [ask]);

	// `M` is handled here rather than through the chooser's own key hook, because the chooser
	// is not mounted while a round is in flight and a key that only works between rounds is a
	// key that reads as broken.
	useInput(
		(input, key) => {
			if (key.escape) {
				onBack();
				return;
			}
			if (working) return;
			if (input.toLowerCase() === "m") void ask();
		},
		{ isActive },
	);

	// One row, so `rampRows` returns one string. The fallback is for `depth: "none"`, where
	// it hands the text back unchanged rather than colouring it.
	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;

	if (working) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{heading}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text>
						<Text color="cyan">
							<Spinner type="dots" />
						</Text>
						<Text dimColor>{"  writing a few, which takes a moment"}</Text>
					</Text>
				</Box>
				<Text dimColor wrap="truncate">
					ESC to type one of your own instead
				</Text>
			</Frame>
		);
	}

	if (failed) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{heading}</Text>
				</Box>
				<Box flexGrow={1}>
					<Text color="yellow" wrap="truncate">
						Nothing came back. The world can still be written — say what it should be about
						yourself, or leave it and let the model choose as it writes.
					</Text>
				</Box>
				<Text dimColor wrap="truncate">
					M to try again · ESC to go back
				</Text>
			</Frame>
		);
	}

	const items: ChoiceItem[] = pitches.map((pitch, index) => ({
		id: `pitch:${index}:${pitch.title}`,
		label: pitch.title,
		detail: pitch.tone,
		body: pitch.premise,
		accent: SHELF[index % SHELF.length] as string,
	}));

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text dimColor>{`  ${duration}, and any of them can be edited after`}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				<Chooser
					items={items}
					width={columns - CHROME}
					height={rows - FRAME_CHROME - PAGE_CHROME}
					isActive={isActive}
					// Deliberately no `onBack`: the hook above already answers ESC, and it has to,
					// because the spinner and the failure screen have no chooser mounted to answer
					// it for them. Every `useInput` handler on screen fires, so handing the chooser
					// one too would go back twice — which on the page above is two screens.
					onChoose={(_item, index) => {
						const pitch = pitches[index];
						if (pitch) onChoose(pitch);
					}}
				/>
			</Box>

			<Text dimColor wrap="truncate">
				{"↑↓ read · ENTER choose · M four more · ESC type my own"}
			</Text>
		</Frame>
	);
}

/**
 * Colours the offers are labelled with, in order.
 *
 * The same shelf `new-world.tsx` uses for written scenarios, and for the same reason: the
 * list should read as several distinct things at a glance. Cyan is absent because the cursor
 * needs it, and a list where every row is coloured has no colour left to mean "here".
 */
const SHELF: readonly string[] = ["green", "magenta", "yellow", "blue", "red", "white"];

const HEADING = "Choose a world";
