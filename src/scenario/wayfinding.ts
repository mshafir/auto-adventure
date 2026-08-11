import { beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import type { MacroSite } from "../core/world/macro.js";
import type { SiteSpec } from "../core/world/spec.js";
import type { ScenarioArtifact } from "./artifact.js";

/**
 * Whether the player is ever told where to go.
 *
 * Its own module because two passes ask the identical question and must not answer it
 * differently. `checkWayfinding` reports a story that leaves the player guessing, and
 * `sayWhereToGoNext` appends a plain direction to one — so a repair that used a narrower
 * rule than the check would fire on a beat the check was happy with, and a wider one would
 * leave a finding standing after claiming to have fixed it.
 *
 * The fault they are both about cost a whole playthrough. Every beat opened, every errand
 * landed in the log, every flag was written and read; the player finished a scene, read
 * "the clerk who countersigned it has not been seen since", and had six towns to choose
 * between. Nothing was broken. It was simply unfollowable.
 */

export interface Journey {
	/** The beat the player is standing in when they need to know. */
	readonly from: ScenarioBeat;
	readonly to: ScenarioBeat;
	readonly destination: SiteSpec;
}

/**
 * The legs of the main line, in order.
 *
 * A *leg* rather than a beat, on the same terms as `storyWalk`: three consecutive beats in
 * one castle are one journey, and nobody needs directions to the room they are in.
 *
 * Side errands are left out. A player goes looking for one by choice, so a story that does
 * not send them there is not a story with a hole in it — and warning about every optional
 * beat in every world is how an author learns to stop reading the validator.
 */
export function journeys(artifact: ScenarioArtifact, sites: Map<number, MacroSite>): Journey[] {
	const arc = artifact.arc;
	if (!arc) return [];

	const main = orderedBeats(arc).filter((beat) => !beat.optional);
	const found: Journey[] = [];
	for (let index = 0; index < main.length - 1; index++) {
		const from = main[index] as ScenarioBeat;
		const to = main[index + 1] as ScenarioBeat;
		if (from.siteId === to.siteId) continue;
		if (!sites.has(to.siteId)) continue;
		const destination = artifact.sites[String(to.siteId)];
		if (!destination) continue;
		found.push({ from, to, destination });
	}
	return found;
}

/**
 * Whether the player knows, by the end of this beat, where they are going next.
 *
 * Four things count, and each of them is something that is actually in front of the player:
 *
 * - the name, in prose they have read — this beat's journal or errand, or an earlier one's,
 *   or the arc's own premise, or a line somebody has said to them;
 * - an objective naming the place, which puts a bearing on the map;
 * - a signpost with an arm pointing there.
 *
 * The *cumulative* reading is the important part and the first version got it wrong. Asked
 * only about the beat in hand, it fired on the hand-written Gawain scenario at the moment
 * Gawain keeps the girdle: nothing in that scene names the Green Chapel, and he was told to
 * come to it in a year and a day at the start, which is exactly how that story works. A
 * player is not told twice, and a check that demands it be said again is a check that
 * rewards padding.
 */
export function toldWhereToGo(
	artifact: ScenarioArtifact,
	journey: Journey,
	options: { readonly ignoreSigns?: boolean } = {},
): boolean {
	const { from, destination } = journey;
	const names = [destination.name, destination.shortName].filter(Boolean);

	if (!options.ignoreSigns) {
		for (const sign of artifact.signs ?? []) {
			if (sign.arms.some((arm) => arm.siteId === destination.siteId)) return true;
		}
	}

	// Everything the player has read or heard by now: the premise on the opening card, and
	// every beat up to and including this one. Not the beats after it — they have not reached
	// them, which is the whole problem being checked for.
	const arc = artifact.arc;
	const heard: string[] = [arc?.premise ?? ""];
	for (const beat of orderedBeats(arc ?? { title: "", premise: "", beats: [] })) {
		if (beat.order > from.order) continue;
		heard.push(beat.journal ?? "", beat.quest?.name ?? "", beat.quest?.description ?? "");
		for (const effect of beat.effects ?? []) {
			if (effect.t === "RecordJournal") heard.push(effect.entry.text);
			if (effect.t === "AdvanceQuest") heard.push(effect.note);
			if (effect.t === "CreateQuest") heard.push(effect.name, effect.description);
		}
		// The scene itself, which is where a character would say it out loud, and the most
		// natural place for it to be said.
		for (const node of Object.values(artifact.trees?.[beatNpcId(beat)]?.nodes ?? {})) {
			heard.push(node.speech);
		}
	}
	const said = heard.join(" ").toLowerCase();
	if (names.some((name) => said.includes(name.toLowerCase()))) return true;

	// An objective the map can mark is the other good answer: `questMarks` puts a bearing on
	// a quest with a `siteId`, so the player has somewhere to walk without being told a name.
	return (from.quest?.objectives ?? []).some(
		(objective) =>
			objective.kind === "reach" &&
			names.some((name) => objective.target.toLowerCase() === name.toLowerCase()),
	);
}
