import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import { FRAME_CHROME, Frame, Rule } from "../panels/primitives.js";
import { type ColorDepth, rgb } from "../render/color.js";
import { clampLine, wrapToLines } from "../render/text.js";
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
	/**
	 * What is wrong with the world that was just written, worst first.
	 *
	 * Shown rather than filed. These used to go to the log and the screen said only that
	 * they had — which is the same as not telling anybody, since the log is a file the
	 * player has no reason to know about and every reason not to be reading four minutes
	 * into a wait they just paid for.
	 */
	readonly findings?: readonly { readonly severity: string; readonly message: string }[];
	/** Where it was kept, once it has been. */
	readonly path?: string;
	/** Called when the player has read the findings and wants to get on with it. */
	readonly onDismiss?: () => void;
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
	findings,
	path,
	onDismiss,
	onStop,
}: GenerateProgressProps) {
	const reviewing = Boolean(findings && findings.length > 0);

	// The clock is the one thing that has to move without anything arriving: between two
	// passes nothing is printed for a minute at a time, and a frozen screen during that
	// minute is the whole problem this page exists to avoid.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (failure || reviewing) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [failure, reviewing]);

	useInput((_input, key) => {
		// Any key once the work is done and there is something to read; ESC only while it
		// is still running, where it means stop rather than go on.
		if (reviewing) {
			onDismiss?.();
			return;
		}
		if (key.escape) onStop();
	});

	const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
	const inner = columns - CHROME;
	// The tail, not the head: the interesting line is always the newest one, and the frame
	// is a fixed height so the older ones have to go somewhere.
	const room = Math.max(1, rows - FRAME_CHROME - PAGE_CHROME);
	const shown = lines.slice(-room);

	// Past tense once the work is done, because a screen that still says "writing" while it
	// waits for a keypress reads as one that has hung.
	const banner = reviewing ? WRITTEN : HEADING;
	const heading = rampRows([banner], RAMP, depth)[0] ?? banner;

	if (reviewing) {
		return (
			<Review
				columns={columns}
				rows={rows}
				heading={heading}
				{...(title ? { title } : {})}
				findings={findings ?? []}
				{...(path ? { path } : {})}
			/>
		);
	}

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

/**
 * What is wrong with the world that was just written, before it is played.
 *
 * The screen this replaces said "finished, with faults noted in the log", which told the
 * player two things they could not act on: that something is wrong, and that the answer is
 * in a file they have never opened. A fault here is *ours* — the authoring passes produced
 * a story with a hole in it — and the player has just paid several minutes for it, so the
 * least they are owed is to be told what, in the words the validator already writes.
 *
 * It is still not a gate. Everything is written and playable; this is read and dismissed.
 */
function Review({
	columns,
	rows,
	heading,
	title,
	findings,
	path,
}: {
	readonly columns: number;
	readonly rows: number;
	readonly heading: string;
	readonly title?: string;
	readonly findings: readonly { readonly severity: string; readonly message: string }[];
	readonly path?: string;
}) {
	const inner = columns - CHROME;
	const errors = findings.filter((finding) => finding.severity === "error");
	const warnings = findings.filter((finding) => finding.severity !== "error");

	// Two rows of chrome above, the rule, two rows of explanation, the path and the prompt.
	const room = Math.max(2, rows - FRAME_CHROME - 8);
	const explanation =
		errors.length > 0
			? "The world is written and playable. The errors above are parts of the story that may not open — everything else still works, and the whole map is there."
			: "The world is written and playable. The warnings above are things that came out rougher than intended.";
	// Errors first and never dropped in favour of a warning: a warning is a world that is
	// merely rougher than intended, and an error is a step of the story that cannot be
	// taken. Whatever will not fit is counted rather than silently missing.
	const ordered = [...errors, ...warnings];
	const shown = ordered.slice(0, room);
	const hidden = ordered.length - shown.length;

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				<Text
					dimColor
				>{`${title ? `  “${title}”` : ""}  ${tally(errors.length, warnings.length)}`}</Text>
			</Box>

			<Box flexGrow={1} flexDirection="column">
				{shown.map((finding) => (
					<Text key={finding.message} wrap="truncate">
						<Text color={finding.severity === "error" ? "red" : "yellow"}>
							{finding.severity === "error" ? "  error   " : "  warning "}
						</Text>
						<Text dimColor={finding.severity !== "error"}>
							{clampLine(finding.message, inner - 10)}
						</Text>
					</Text>
				))}
				{hidden > 0 ? (
					<Text dimColor>{`  …and ${hidden} more, all of them in the log.`}</Text>
				) : null}
			</Box>

			<Rule width={inner} />
			{/* Wrapped rather than truncated, and said plainly: "an error" in a thing you
			    have just waited four minutes for reads as "it did not work" unless somebody
			    says otherwise, and that sentence is the one that must not be cut. */}
			{wrapToLines(explanation, inner, 2).map((line) => (
				<Text key={line} wrap="truncate">
					{line}
				</Text>
			))}
			{path ? (
				<Text dimColor wrap="truncate">
					{`Kept in ${path}`}
				</Text>
			) : null}
			<Text color="cyan" wrap="truncate">
				Press any key to play it.
			</Text>
		</Frame>
	);
}

/** "2 errors, 3 warnings" — the size of the problem, before any of it is read. */
function tally(errors: number, warnings: number): string {
	const parts: string[] = [];
	if (errors > 0) parts.push(`${errors} error${errors === 1 ? "" : "s"}`);
	if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? "" : "s"}`);
	return parts.join(", ");
}

/** `m:ss`, because a run is minutes long and a bare second count stops being readable. */
function clock(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const HEADING = "Writing a world";
const WRITTEN = "A world written";
