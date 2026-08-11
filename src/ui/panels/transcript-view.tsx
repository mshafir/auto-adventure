import { Text } from "ink";
import { money, type TelemetrySnapshot, tokens } from "../../ai/telemetry.js";
import type { Exchange } from "../../ai/transcript.js";
import type { LogLine } from "../../utils/log.js";
import { clampLine, wrapBlock } from "../render/text.js";
import { Rule, ScrollList } from "./primitives.js";

/**
 * What was said to the model, readable without leaving the program.
 *
 * One component for two callers — the screen that watches a world being written, and
 * the page you can open mid-game — because they are the same view of the same buffer
 * and the only difference is which frame they sit in. Written twice they would drift,
 * and the drift would show up as the same exchange being summarised differently
 * depending on where you happened to be reading it.
 *
 * Purely a view. It owns no cursor and no scroll position: both are held by whichever
 * screen has the keyboard, which is what lets the same component be driven by the
 * launcher's own key handling in one place and by the HUD reducer in the other.
 */

/**
 * Which half of an exchange the detail pane is showing, or both at once.
 *
 * The two screens want different things and both are right. Watching a world being
 * written, the prompts are long and the answers are short, so flipping between them is
 * how you compare a question with what it got. Reading afterwards from inside the game
 * there is no hurry and no second hand on the keys, so the whole exchange as one
 * document is less to learn.
 */
export type TranscriptPart = "prompt" | "answer" | "both";

export interface TranscriptViewProps {
	readonly exchanges: readonly Exchange[];
	/** Index into `exchanges` of the selected row. */
	readonly cursor: number;
	/** First line of the detail to draw, so a long prompt can be scrolled. */
	readonly offset: number;
	readonly part: TranscriptPart;
	readonly width: number;
	readonly rows: number;
	/** Running totals, shown above the list. Absent where the caller shows its own. */
	readonly totals?: TelemetrySnapshot;
	/**
	 * The debug log, when the caller wants it under the exchange.
	 *
	 * The other half of the answer to "why did this world come out like that". The
	 * exchanges say what was asked and what came back; this says what the pipeline then did
	 * with it — dropped a late spec for a committed site, escalated to a dearer model,
	 * replayed a remembered reply. Absent means the caller is not showing it, which is the
	 * ordinary case.
	 */
	readonly log?: readonly LogLine[];
}

/**
 * How much of the frame the list of exchanges gets.
 *
 * A third, matching the reader's other pages. The detail is what somebody came here
 * to read; the list is how they find it.
 */
const LIST_SHARE = 0.35;

export function TranscriptView({
	exchanges,
	cursor,
	offset,
	part,
	width,
	rows,
	totals,
	log,
}: TranscriptViewProps) {
	if (exchanges.length === 0) {
		return (
			<>
				<Rule width={width} label="the working" />
				<Text color="gray" wrap="truncate">
					Nothing has been asked of a model yet.
				</Text>
			</>
		);
	}

	const at = Math.max(0, Math.min(cursor, exchanges.length - 1));
	const selected = exchanges[at] as Exchange;
	// Two rules and the summary line come off the top; the rest is split. The log, when it
	// is up, takes a third of what is left — enough to read the last few lines, which is
	// what a reader wants beside an exchange rather than the whole file.
	const listRows = Math.max(2, Math.floor((rows - 3) * LIST_SHARE));
	const showLog = log !== undefined && log.length > 0;
	const logRows = showLog ? Math.max(2, Math.floor((rows - 3 - listRows) / 3)) : 0;
	const detailRows = Math.max(2, rows - 3 - listRows - logRows - (showLog ? 1 : 0));

	const asked = `${selected.system}\n\n${selected.prompt}`;
	const body =
		part === "prompt"
			? asked
			: part === "answer"
				? detail(selected)
				: `${asked}\n\n${"─".repeat(Math.max(4, Math.min(width, 40)))}\n\n${detail(selected)}`;
	const lines = wrapBlock(body, width);
	// Clamped against the end rather than trusted, so a scroll position left over from a
	// longer exchange cannot show a blank pane after the cursor moves.
	const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - detailRows)));
	const shown = lines.slice(start, start + detailRows);

	return (
		<>
			{totals ? (
				<Text wrap="truncate">
					<Text color="yellow">{money(totals.totalCost)}</Text>
					<Text dimColor>
						{`  ${totals.calls} calls${totals.failures > 0 ? ` (${totals.failures} failed)` : ""}` +
							`  ${tokens(totals.totalTokens)} tokens`}
					</Text>
				</Text>
			) : null}
			<Rule width={width} label={`${exchanges.length} exchanges`} />
			<ScrollList
				count={exchanges.length}
				cursor={at}
				rows={listRows}
				focus
				render={(index) => <Row exchange={exchanges[index] as Exchange} width={width - 2} />}
			/>
			<Rule
				width={width}
				label={`#${selected.seq} ${selected.kind} · ${PART_LABELS[part]}${
					lines.length > detailRows
						? ` · ${start + 1}-${start + shown.length} of ${lines.length}`
						: ""
				}`}
			/>
			{shown.map((line, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines are positional
				<Text key={index} wrap="truncate" color={selected.error ? "yellow" : undefined}>
					{line}
				</Text>
			))}
			{showLog ? (
				<>
					<Rule width={width} label="log" />
					{(log ?? []).slice(-logRows).map((line, index) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: log lines are positional
							key={index}
							wrap="truncate"
							color={line.level === "error" || line.level === "warn" ? "yellow" : undefined}
							dimColor={line.level === "debug"}
						>
							{clampLine(`${stamp(line.at)} ${line.text}`, width)}
						</Text>
					))}
				</>
			) : null}
		</>
	);
}

/** `hh:mm:ss`, so two lines can be told apart by when as well as by what. */
function stamp(at: number): string {
	return new Date(at).toISOString().slice(11, 19);
}

/** One row: enough to recognise the call by, and to spot the expensive one. */
function Row({ exchange, width }: { exchange: Exchange; width: number }) {
	const usage =
		exchange.inputTokens === undefined && exchange.outputTokens === undefined
			? ""
			: ` ${tokens(exchange.inputTokens ?? 0)}→${tokens(exchange.outputTokens ?? 0)}`;
	const label =
		`#${exchange.seq} ${exchange.kind}` +
		`${exchange.attempt > 1 ? ` (try ${exchange.attempt})` : ""}` +
		` ${(exchange.millis / 1000).toFixed(1)}s${usage}` +
		`${exchange.cost > 0 ? ` ${money(exchange.cost)}` : ""}` +
		`${exchange.error ? " — failed" : ""}`;
	return (
		<Text color={exchange.error ? "yellow" : "white"}>{clampLine(label, Math.max(4, width))}</Text>
	);
}

/** The answer, or the reason there is not one. */
function detail(exchange: Exchange): string {
	if (exchange.error) return `The call failed.\n\n${exchange.error}`;
	return exchange.response ?? "(nothing came back)";
}

const PART_LABELS: Readonly<Record<TranscriptPart, string>> = {
	prompt: "what was asked",
	answer: "what came back",
	both: "the exchange",
};

/** How many lines of detail a scroll key should move. Kept out of both callers. */
export const TRANSCRIPT_PAGE = 10;
