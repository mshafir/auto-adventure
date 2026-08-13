import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState } from "react";
import {
	money,
	onTelemetry,
	type TelemetrySnapshot,
	telemetrySnapshot,
	tokens,
} from "../../ai/telemetry.js";
import { type Exchange, onTranscript, transcript } from "../../ai/transcript.js";
import { type LogLine, logRing, onLog } from "../../utils/log.js";
import { FRAME_CHROME, Frame, Rule } from "../panels/primitives.js";
import { TRANSCRIPT_PAGE, type TranscriptPart, TranscriptView } from "../panels/transcript-view.js";
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
	/**
	 * Whether the work is finished and the review is what should be on screen.
	 *
	 * Inferred from there being findings, normally, since a world with nothing wrong with it
	 * used to go straight into play. But a world that has just been read back and mended may
	 * have *nothing* left wrong with it, and that is precisely the outcome worth showing —
	 * so the caller can say so outright.
	 */
	readonly done?: boolean;
	/** Called when the player has read the findings and wants to get on with it. */
	readonly onDismiss?: () => void;
	/**
	 * Called when the player asks for the world to be read back and mended.
	 *
	 * Absent means the offer is not made — there is no key to spend, or the world came out
	 * with nothing to mend. An offer that cannot be taken is worse than no offer: it is a
	 * key on the screen that does nothing, which reads as the game having stopped
	 * responding at the exact moment the player is deciding whether to trust it.
	 */
	readonly onPolish?: () => void;
	/** A reader's verdict on the world, once one has read it. */
	readonly verdict?: string;
	/**
	 * The beat whose scene could not be made to work, when the story does not play.
	 *
	 * The one outcome where nothing was kept. Every other screen here is about a world that
	 * exists and can be walked into; this one is about a world that was written, played, and put
	 * down again — so it offers a different world rather than a keypress to get on with it.
	 */
	readonly unplayable?: {
		readonly beat: string;
		readonly why: string;
		readonly tried: readonly string[];
	};
	/** Throw this one away and write another with the same brief and a new seed. */
	readonly onRetry?: () => void;
	/** Keep this one anyway and play it. */
	readonly onAccept?: () => void;
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
	done,
	onDismiss,
	onPolish,
	verdict,
	unplayable,
	onRetry,
	onAccept,
	onStop,
}: GenerateProgressProps) {
	// The unplayable page is a review too, in the one sense this flag controls: the work is over,
	// so the clock stops and the keys stop meaning "stop the run".
	const reviewing = Boolean(unplayable) || (done ?? Boolean(findings && findings.length > 0));

	// The clock is the one thing that has to move without anything arriving: between two
	// passes nothing is printed for a minute at a time, and a frozen screen during that
	// minute is the whole problem this page exists to avoid.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (failure || reviewing) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [failure, reviewing]);

	/*
	 * The spend, kept current between progress lines.
	 *
	 * Progress lines arrive once a *pass* and calls arrive once a *call*, so a cost
	 * drawn only when a line lands would sit frozen for a minute at a time — the same
	 * stalled-looking screen the elapsed clock exists to avoid. Both counters subscribe
	 * instead, and a version number is enough: the snapshot itself is read during render.
	 */
	const [, bump] = useState(0);
	useEffect(() => {
		const redraw = () => bump((n) => n + 1);
		const offTelemetry = onTelemetry(redraw);
		const offTranscript = onTranscript(redraw);
		const offLog = onLog(redraw);
		return () => {
			offTelemetry();
			offTranscript();
			offLog();
		};
	}, []);
	const spend = telemetrySnapshot();

	// Where the reader is in the transcript. Held here rather than in the component that
	// draws it, so moving the cursor does not reset the scroll and vice versa.
	const [showing, setShowing] = useState(false);
	const [cursor, setCursor] = useState(0);
	const [offset, setOffset] = useState(0);
	const [part, setPart] = useState<TranscriptPart>("prompt");
	// Under the exchange rather than instead of it, and only when asked for: the pane it
	// takes is a third of the detail, which is a third fewer lines of the prompt somebody
	// opened this to read.
	const [showLog, setShowLog] = useState(false);
	const exchanges: readonly Exchange[] = showing ? transcript() : [];
	const log: readonly LogLine[] = showing && showLog ? logRing() : [];

	useInput((input, key) => {
		const letter = input.toLowerCase();

		// The transcript takes every key while it is up, including the ones that would
		// otherwise stop the run or start the game. Somebody reading a prompt has not
		// asked to leave, and ESC here means "put this down", not "throw the world away".
		if (showing) {
			if (key.escape || letter === "d") {
				setShowing(false);
				return;
			}
			if (key.upArrow) {
				setCursor((at) => Math.max(0, at - 1));
				setOffset(0);
				return;
			}
			if (key.downArrow) {
				setCursor((at) => Math.min(Math.max(0, exchanges.length - 1), at + 1));
				setOffset(0);
				return;
			}
			// Left and right swap which half of the exchange is shown, which is the one
			// thing a reader does constantly: the question and the answer to it.
			if (key.leftArrow || key.rightArrow) {
				setPart((current) => (current === "prompt" ? "answer" : "prompt"));
				setOffset(0);
				return;
			}
			if (letter === "l") {
				setShowLog((up) => !up);
				setOffset(0);
				return;
			}
			if (input === " " || key.return) {
				setOffset((line) => line + TRANSCRIPT_PAGE);
				return;
			}
			if (letter === "b") setOffset((line) => Math.max(0, line - TRANSCRIPT_PAGE));
			return;
		}

		// Never on any key. `D` opens the working, and taking it as "I have read the
		// findings, start the game" would make the transcript unreachable exactly where
		// it is most wanted — on the screen reporting what came out wrong.
		if (letter === "d") {
			setShowing(true);
			return;
		}
		// The unplayable page takes its keys before everything below, and takes *only* them.
		// Nothing was written, so there is no "any other key to play it" to fall through to —
		// a screen that started a world that is not on the disk would be the worst possible
		// answer to a page saying the world was not kept.
		if (unplayable) {
			if (letter === "r") onRetry?.();
			else if (letter === "p") onAccept?.();
			else if (key.escape) onStop();
			return;
		}
		// Before the catch-all below, for the same reason `D` is: this screen dismisses on
		// any key, so a key that means something has to be taken out of "any" first.
		if (reviewing && onPolish && letter === "p") {
			onPolish();
			return;
		}
		// Any other key once the work is done and there is something to read; ESC only
		// while it is still running, where it means stop rather than go on.
		if (reviewing) {
			onDismiss?.();
			return;
		}
		if (key.escape) onStop();
	});

	if (showing) {
		return (
			<Frame style="menu" width={columns} height={rows}>
				<Box marginBottom={1}>
					<Text bold>{rampRows([WORKING], RAMP, depth)[0] ?? WORKING}</Text>
					{title ? <Text dimColor>{`  “${title}”`}</Text> : null}
				</Box>
				<Box flexGrow={1} flexDirection="column">
					<TranscriptView
						exchanges={exchanges}
						cursor={cursor}
						offset={offset}
						part={part}
						width={columns - CHROME}
						rows={Math.max(6, rows - FRAME_CHROME - PAGE_CHROME)}
						totals={spend}
						{...(log.length > 0 ? { log } : {})}
					/>
				</Box>
				<Text dimColor wrap="truncate">
					↑↓ exchange · ←→ question/answer · L log · SPACE down · B up · D or ESC back
				</Text>
			</Frame>
		);
	}

	const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
	const inner = columns - CHROME;
	// The tail, not the head: the interesting line is always the newest one, and the frame
	// is a fixed height so the older ones have to go somewhere.
	const room = Math.max(1, rows - FRAME_CHROME - PAGE_CHROME);
	const shown = lines.slice(-room);

	// Past tense once the work is done, because a screen that still says "writing" while it
	// waits for a keypress reads as one that has hung. And never "a world written" for a world
	// that was not kept — that sentence is the one thing this page must not say.
	const banner = unplayable ? UNPLAYABLE : reviewing ? WRITTEN : HEADING;
	const heading = rampRows([banner], RAMP, depth)[0] ?? banner;

	if (unplayable) {
		return (
			<Unplayable
				columns={columns}
				rows={rows}
				heading={heading}
				{...(title ? { title } : {})}
				stuck={unplayable}
				spent={spend}
			/>
		);
	}

	if (reviewing) {
		return (
			<Review
				columns={columns}
				rows={rows}
				heading={heading}
				{...(title ? { title } : {})}
				findings={findings ?? []}
				{...(path ? { path } : {})}
				spent={spend}
				canPolish={Boolean(onPolish)}
				{...(verdict ? { verdict } : {})}
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
					</Text>
					{/* The bill, as it is run up rather than after the fact.
					    This is the number a player is actually deciding about while they
					    watch — whether to let it finish — and until now the only place it
					    existed was a summary line in a log file written when it was too
					    late to act on. Tokens beside it because a cost of zero is what an
					    unpriced model looks like, and a token count says the difference
					    between "nothing has happened" and "we cannot price this". */}
					<Text color="yellow">{money(spend.totalCost)}</Text>
					<Text dimColor>
						{` ${tokens(spend.totalTokens)} tok`}
						{spend.failures > 0 ? ` · ${spend.failures} failed` : ""}
						{" · "}
						{stopping
							? // Said plainly rather than pretending the keypress was instant. Nothing
								// here can be interrupted mid-call, so a player told "stopping" and then
								// made to wait ten seconds has been told the truth.
								"stopping after this pass"
							: "ESC to stop · D for the working"}
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
	spent,
	canPolish,
	verdict,
}: {
	readonly columns: number;
	readonly rows: number;
	readonly heading: string;
	readonly title?: string;
	readonly findings: readonly { readonly severity: string; readonly message: string }[];
	readonly path?: string;
	readonly spent: TelemetrySnapshot;
	readonly canPolish: boolean;
	readonly verdict?: string;
}) {
	const inner = columns - CHROME;
	const errors = findings.filter((finding) => finding.severity === "error");
	const warnings = findings.filter((finding) => finding.severity !== "error");

	// Two rows of chrome above, the rule, two rows of explanation, the path and the prompt,
	// and the verdict when a reader has given one.
	const room = Math.max(2, rows - FRAME_CHROME - 8 - (verdict ? 1 : 0));
	const explanation =
		findings.length === 0
			? "Nothing is wrong with it. Every place the story sends you exists, every errand can be finished, and every scene has somebody in it to play it."
			: errors.length > 0
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
			{/* What a reader made of it, in its own words, above the bookkeeping. This is the
			    answer to the question the player actually has — "is this worth playing" — and
			    the only line on the screen that answers it rather than counting something. */}
			{verdict ? (
				<Text color="green" wrap="truncate">
					{clampLine(verdict, inner)}
				</Text>
			) : null}
			{path ? (
				<Text dimColor wrap="truncate">
					{`Kept in ${path}`}
				</Text>
			) : null}
			{/* What it came to, said once, where it can be read. A player deciding
			    whether to write another one of these has exactly one question, and
			    "several minutes and some number of calls" was never an answer to it. */}
			<Text wrap="truncate">
				<Text dimColor>{"Cost "}</Text>
				<Text color="yellow">{money(spent.totalCost)}</Text>
				<Text dimColor>
					{` over ${spent.calls} call${spent.calls === 1 ? "" : "s"}, ${tokens(spent.totalTokens)} tokens`}
					{spent.failures > 0 ? `, ${spent.failures} of them failed` : ""}
				</Text>
			</Text>
			{/* The offer, and it is only ever made when it can be taken. Named for what it
			    does rather than for what it is: "fix" is the word somebody looking at a list
			    of faults is already thinking, and "run the polish pass" is a sentence about
			    our pipeline rather than about their world. */}
			<Text color="cyan" wrap="truncate">
				{[
					canPolish ? "P to have it read back and the faults written out" : "",
					"D to read the working",
					"any other key to play it",
				]
					.filter(Boolean)
					.join(" · ")}
			</Text>
		</Frame>
	);
}

/**
 * A world that was written, played, and put down again.
 *
 * The only screen here about something that does not exist. Everything else reports on a world
 * sitting in `.scenarios` — this one reports that the story stopped at a beat nothing local could
 * fix, and that nothing was kept because of it.
 *
 * Three things it must say, in this order, because that is the order the questions arrive in:
 * what went wrong, that nothing was kept, and what it cost. The fixes that were tried are on the
 * page rather than in the log for the same reason the findings are: the log is a file the player
 * has no reason to know about, and this is the moment they are deciding whether to spend again.
 */
function Unplayable({
	columns,
	rows,
	heading,
	title,
	stuck,
	spent,
}: {
	readonly columns: number;
	readonly rows: number;
	readonly heading: string;
	readonly title?: string;
	readonly stuck: {
		readonly beat: string;
		readonly why: string;
		readonly tried: readonly string[];
	};
	readonly spent: TelemetrySnapshot;
}) {
	const inner = columns - CHROME;
	// The heading and its blank, the rule, two lines of explanation, the cost and the keys.
	const room = Math.max(1, rows - FRAME_CHROME - 8);
	const tried = stuck.tried.slice(0, room);

	return (
		<Frame style="menu" width={columns} height={rows}>
			<Box marginBottom={1}>
				<Text bold>{heading}</Text>
				{title ? <Text dimColor>{`  “${title}”`}</Text> : null}
			</Box>

			<Box flexGrow={1} flexDirection="column">
				{/* "stops at" rather than "would not open", because there are two ways a story stops
				    and only one of them is a scene that will not start. The other is a scene that
				    opens and hands out an errand nothing can close, which leaves the player at the
				    last beat waiting for an ending that cannot come. The sentence below says
				    which. */}
				<Text wrap="truncate">
					<Text color="red">{"  stopped  "}</Text>
					<Text>{clampLine(`the story stops at "${stuck.beat}"`, inner - 11)}</Text>
				</Text>
				{wrapToLines(`  ${stuck.why}.`, inner, 2).map((line) => (
					<Text key={line} dimColor wrap="truncate">
						{line}
					</Text>
				))}
				{tried.length > 0 ? <Text dimColor>{"  What was tried:"}</Text> : null}
				{tried.map((attempt) => (
					<Text key={attempt} dimColor wrap="truncate">
						{`    ${clampLine(attempt, inner - 4)}`}
					</Text>
				))}
			</Box>

			<Rule width={inner} />
			{/* The sentence the whole screen exists for. Said plainly and said first, because a
			    player who has just watched four minutes of work assumes it was kept. */}
			<Text wrap="truncate">
				Nothing was kept. The rest of this world is fine; its story stops here.
			</Text>
			<Text wrap="truncate">
				<Text dimColor>{"Cost so far "}</Text>
				<Text color="yellow">{money(spent.totalCost)}</Text>
				<Text dimColor>
					{` over ${spent.calls} call${spent.calls === 1 ? "" : "s"}, ${tokens(spent.totalTokens)} tokens`}
				</Text>
			</Text>
			{/* Another world costs about what this one did, and the number above is the estimate:
			    the player is deciding whether to spend it again, and there is no cap on how often
			    they may — each attempt is a keypress with the price on the screen beside it. */}
			<Text color="cyan" wrap="truncate">
				{[
					"R for another world, same story, new country",
					"P to keep this one and play it anyway",
					"ESC to give up",
				].join(" · ")}
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
const UNPLAYABLE = "A world put down";
const WORKING = "The working";
