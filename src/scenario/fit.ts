import {
	isBarredBranch,
	orderedBeats,
	type ScenarioArc,
	type ScenarioBeat,
} from "../core/rules/arc.js";
import { asCondition, flagsRead } from "../core/rules/condition.js";
import type { ScenarioArtifact } from "./artifact.js";
import { closeWhatIsOpen, openBeat, type Playing, walkMainLine, withStory } from "./play.js";
import { applySpatialRepairs } from "./repair.js";

/**
 * Place the side errands, once the main line stands.
 *
 * Deliberately a lower tolerance than the pass before it, and every rule here follows from one
 * sentence: side quests are worth having and none of them is worth risking the story for.
 *
 * **No growth.** The ordering forces this rather than a preference. Growing a site re-rolls its
 * entire layout — the subdivision runs over the whole settlement rect, so every plot moves —
 * which would disturb the main line that has just been settled against the old layout. So
 * fitting gets only the fixes that touch no map: stand somebody at an anchor that exists, move
 * them into a room that was built, hide a thing where there is somewhere to hide it, spell an
 * errand the way the world spells it. A side quest that needs a site to be bigger is a side
 * quest we do not have.
 *
 * **Give up easily.** One attempt at a fix, not three. On failure the beat is dropped and the
 * pass moves on. Dropping an optional beat is already what the repairs permit; the difference is
 * that it now happens after a genuine attempt to place it rather than instead of one.
 *
 * **Except where the main line waits on it.** A step of the main story written as a step of a
 * side errand cannot open once its parent is gone, so there the beat stays and the fault is
 * reported. That is the same rule the repairs follow, in the one place this pass could break it.
 */

export interface FitReport {
	readonly artifact: ScenarioArtifact;
	/** Optional beats that opened, or that a fork barred, which is not a failure. */
	readonly fitted: readonly string[];
	/** Optional beats taken out of the story, in words. */
	readonly dropped: readonly string[];
	/** Beats that would not fit and could not be dropped, in words. */
	readonly refused: readonly string[];
	/** What was changed to fit them, in words. */
	readonly fixes: readonly string[];
	/** What had to be given rather than earned. Recorded, never gated on. */
	readonly concessions: readonly string[];
}

export async function fitSideQuests(
	artifact: ScenarioArtifact,
	onProgress: (message: string) => void = () => undefined,
): Promise<FitReport> {
	const arc = artifact.arc;
	const optional = arc ? orderedBeats(arc).filter((beat) => beat.optional) : [];
	if (!arc || optional.length === 0) {
		return { artifact, fitted: [], dropped: [], refused: [], fixes: [], concessions: [] };
	}

	let current = artifact;
	const fixes: string[] = [];
	const concessions: string[] = [];

	let attempt = await attemptEach(current, optional, concessions);

	// One fix attempt for the whole set rather than three per beat. These are the repairs that
	// touch no map, so they are re-derived once against the whole artifact and only the beats
	// that failed are visited again. A second attempt buys nothing: a fix that changed nothing
	// will change nothing next time either.
	if (attempt.failed.length > 0) {
		const fixed = applySpatialRepairs(current);
		if (fixed.artifact !== current) {
			current = fixed.artifact;
			fixes.push(...fixed.repairs);
			onProgress(
				`fixed ${fixed.repairs.length} placement fault(s) and tried the side quests again`,
			);
			const again = await attemptEach(current, attempt.failed, concessions);
			attempt = { fitted: [...attempt.fitted, ...again.fitted], failed: again.failed };
		}
	}

	const dropped: string[] = [];
	const refused: string[] = [];
	for (const beat of attempt.failed) {
		const waiting = waitingOn(current, beat.id);
		if (waiting) {
			refused.push(
				`side errand ${beat.id} would not fit here, and ${waiting} waits on it; left it in the story rather than shortening the main line`,
			);
			continue;
		}
		current = dropBeat(current, beat.id);
		dropped.push(`side errand ${beat.id} could not be placed in this world; dropped it`);
	}
	for (const said of [...dropped, ...refused]) onProgress(said);

	return { artifact: current, fitted: attempt.fitted, dropped, refused, fixes, concessions };
}

/**
 * Try to open every one of these beats, and say which would not.
 *
 * One session per round, and rounds exist for one reason: opening an arm of a fork bars its
 * siblings for good, so two arms cannot both be tried in the same playthrough. Trying them
 * together and calling the barred one "kept, unexamined" hides exactly the case worth catching —
 * a side errand that could never open whichever way the fork went. So each fork's arms are dealt
 * one to a round, and every arm gets a session in which it is the one that was chosen.
 *
 * A round costs a session and a main-line walk over caches the last one warmed, which is engine
 * commands; the shipped worlds have no optional forks at all, so they run exactly one.
 */
async function attemptEach(
	artifact: ScenarioArtifact,
	beats: readonly ScenarioBeat[],
	concessions: string[],
): Promise<{ fitted: string[]; failed: ScenarioBeat[] }> {
	const fitted: string[] = [];
	const failed: ScenarioBeat[] = [];
	for (const round of inRounds(beats)) {
		const result = await attemptRound(artifact, round, concessions);
		fitted.push(...result.fitted);
		failed.push(...result.failed);
	}
	return { fitted, failed };
}

/**
 * The beats split so that no round holds two arms of the same fork.
 *
 * First fit in the order given, which is `orderedBeats` order, so the split — and therefore the
 * result — is the same every time. Everything with no fork of its own lands in the first round.
 */
function inRounds(beats: readonly ScenarioBeat[]): ScenarioBeat[][] {
	const rounds: ScenarioBeat[][] = [];
	for (const beat of beats) {
		const clashes = (round: ScenarioBeat[]) =>
			beat.branch !== undefined && round.some((other) => other.branch === beat.branch);
		const room = rounds.find((round) => !clashes(round));
		if (room) room.push(beat);
		else rounds.push([beat]);
	}
	return rounds;
}

/**
 * One session: bring the story's state up, then try each of these beats in it.
 *
 * The main line is walked first and its own result ignored on purpose — a side errand is commonly
 * gated on a step of the story, so the state has to be brought up before any of them can be
 * reached. Whether the main line settles is the previous pass's business, and this one is only
 * ever called once that has said yes.
 */
async function attemptRound(
	artifact: ScenarioArtifact,
	beats: readonly ScenarioBeat[],
	concessions: string[],
): Promise<{ fitted: string[]; failed: ScenarioBeat[] }> {
	return await withStory(artifact, async (playing) => {
		await walkMainLine(artifact, playing, Date.now() + BUDGET_MS);

		const fitted: string[] = [];
		const failed: ScenarioBeat[] = [];
		for (const beat of beats) {
			if (await fits(playing, beat)) fitted.push(beat.id);
			else failed.push(beat);
		}
		concessions.push(...playing.walker.concessions);
		return { fitted, failed };
	});
}

async function fits(playing: Playing, beat: ScenarioBeat): Promise<boolean> {
	// An arm of a fork the *main line* took the other way. Kept, and this is the one case rounds
	// cannot help with: the walk that brings the state up is what bars it, so there is no session
	// in which this arm is the one that was chosen. It did not fail to fit — it is the road the
	// story did not take — and dropping it would delete the alternative that made the choice
	// worth making.
	if (isBarredBranch(playing.state(), beat)) return true;
	const site = playing.sites.get(beat.siteId);
	if (!site) return false;
	if (!(await openBeat(playing, beat, site))) return false;
	// A side errand whose objective sits open forever is the same fault on a smaller scale — and
	// `arcOutline` will not call a story finished while an errand it handed out is open.
	await closeWhatIsOpen(playing);
	return true;
}

/**
 * How long the whole pass may take. A wall clock, and it decides only when to stop trying.
 *
 * Shorter than settling's, because this walks a story that has already been settled over caches
 * that are already warm: what is left is engine commands.
 */
const BUDGET_MS = 30_000;

/** The first beat that is not itself a side errand and cannot open without this one. */
function waitingOn(artifact: ScenarioArtifact, id: string): string | undefined {
	const flag = `arc:${id}`;
	return artifact.arc?.beats.find(
		(beat) => !beat.optional && flagsRead(asCondition(beat.requires)).has(flag),
	)?.id;
}

/**
 * An optional beat taken out of the story, and everything that pointed at it.
 *
 * Four things point at a beat, and leaving any of them behind is worse than not dropping it at
 * all. Deliberately *not* touched: the conversations and the triggers. A conversation for
 * somebody who is still standing there is content a player can reach, and a trigger waiting on a
 * flag nothing now sets is inert rather than broken — the validator reports both, and deleting a
 * scene to tidy a report costs more than it saves.
 */
export function dropBeat(artifact: ScenarioArtifact, id: string): ScenarioArtifact {
	const arc = artifact.arc;
	if (!arc) return artifact;
	const flag = `arc:${id}`;

	const beats = arc.beats
		.filter((beat) => beat.id !== id)
		.map((beat) => {
			// A parent that had this as one of its steps. The `quest` objective naming it can never
			// tick now, and an errand waiting on a step that is gone stays in the log forever —
			// which is exactly what stops an arc from ever finishing.
			if (!beat.quest?.objectives.some((entry) => entry.kind === "quest" && entry.target === id)) {
				return beat;
			}
			return {
				...beat,
				quest: {
					...beat.quest,
					objectives: beat.quest.objectives.filter(
						(entry) => !(entry.kind === "quest" && entry.target === id),
					),
				},
			};
		});
	// An ending reached by having done this: unreachable now, and `pickEnding` takes the first
	// match in author order, so leaving it would put a dead condition ahead of a live one.
	const endings = (arc.endings ?? []).filter((ending) => !flagsRead(ending.when).has(flag));
	// What the beat hid, which nothing now asks for. Keyed by the beat, in `lowerArc`.
	const placements = (artifact.placements ?? []).filter(
		(placement) => placement.id !== `find:${id}`,
	);

	const next: ScenarioArc = { ...arc, beats };
	return {
		...artifact,
		arc: endings.length > 0 ? { ...next, endings } : omitEndings(next),
		...(placements.length > 0 ? { placements } : {}),
	};
}

/** An arc with no endings at all, rather than one whose `endings` is an empty list. */
function omitEndings(arc: ScenarioArc): ScenarioArc {
	const { endings: _endings, ...without } = arc;
	return without;
}
