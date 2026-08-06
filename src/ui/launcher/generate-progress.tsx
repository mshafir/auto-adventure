import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { FRAME_CHROME, Frame, Rule } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { rampRows } from "./gradient.js";

/**
 * A world being written, while the player watches.
 *
 * The one screen in the game that exists because something is slow. Several minutes of
 * model calls with a spinner and nothing else would be indistinguishable from a hang, so
 * this shows what each pass actually produced — the shape of the country, the title, the
 * regions named, the places populated, the beats plotted — which turns a wait into
 * something worth reading and, more usefully, tells a player who comes back to a broken
 * run exactly which pass it died in.
 *
 * Purely a view: it owns the elapsed clock and nothing else. `pickLaunch` runs the
 * authoring and re-renders this with each line as it arrives, which keeps the async work
 * out of a component that would otherwise have to survive being unmounted mid-call.
 */

const CHROME = FRAME_CHROME + 4;

/** The heading, its blank, the rule, the footer, and the blank above it. */
const PAGE_CHROME = 5;

const RAMP = { from: rgb("#f0c674"), to: rgb("#4f7fd4") };

export interface GenerateProgressProps {
	readonly columns: number;
	readonly rows: number;
	readonly depth: ColorDepth;
	/** What the world is called, once the lore pass has said. */
	readonly title?: string;
	/** Every progress line so far, oldest first. */
	readonly lines: readonly string[];
	/** Model calls made so far. */
	readonly calls: number;
	/** When authoring began, for the elapsed clock. */
	readonly startedAt: number;
	/** Set once ESC has been pressed and the run is winding up. */
	readonly stopping?: boolean;
	/** How it ended, when it has. Keeps the last frame on screen with a reason. */
	readonly failure?: string;
	readonly onStop: () => void;
}

export function GenerateProgress({
	columns,
	rows,
	depth,
	title,
	lines,
	calls,
	startedAt,
	stopping = false,
	failure,
	onStop,
}: GenerateProgressProps) {
	// The clock is the one thing that has to move without anything arriving: between two
	// passes nothing is printed for a minute at a time, and a frozen screen during that
	// minute is the whole problem this page exists to avoid.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (failure) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [failure]);

	useInput((_input, key) => {
		if (key.escape) onStop();
	});

	const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
	const inner = columns - CHROME;
	// The tail, not the head: the interesting line is always the newest one, and the frame
	// is a fixed height so the older ones have to go somewhere.
	const room = Math.max(1, rows - FRAME_CHROME - PAGE_CHROME);
	const shown = lines.slice(-room);

	const heading = rampRows([HEADING], RAMP, depth)[0] ?? HEADING;

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				{title ? <Text dimColor>{`  “${title}”`}</Text> : null}
			</Box>

			<Box flexGrow={1} flexDirection="column">
				{shown.map((line, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: progress lines are positional
					<Text key={index} wrap="truncate" dimColor={index < shown.length - 1}>
						{`  ${line}`}
					</Text>
				))}
			</Box>

			<Rule width={inner} />
			{failure ? (
				<Text color="yellow" wrap="truncate">
					{failure}
				</Text>
			) : (
				<Text wrap="truncate">
					<Text color="cyan">
						<Spinner type="dots" />
					</Text>
					<Text dimColor>
						{`  ${clock(elapsed)} · ${calls} model ${calls === 1 ? "call" : "calls"} · `}
						{stopping
							? // Said plainly rather than pretending the keypress was instant. Nothing
								// here can be interrupted mid-call, so a player told "stopping" and then
								// made to wait ten seconds has been told the truth.
								"stopping after this pass"
							: "ESC to stop"}
					</Text>
				</Text>
			)}
		</Frame>
	);
}

/** `m:ss`, because a run is minutes long and a bare second count stops being readable. */
function clock(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const HEADING = "Writing a world";
