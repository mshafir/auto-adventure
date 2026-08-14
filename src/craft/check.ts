import { storyNpcIds } from "../core/rules/arc.js";
import { scenePacingProblems } from "../core/rules/scene-check.js";
import { sitesInside } from "../core/world/macro.js";
import { npcId } from "../core/world/spec.js";
import { ChunkManager } from "../engine/chunk-manager.js";
import { NpcDirectory } from "../engine/npc-directory.js";
import { stageScene } from "../engine/scene-staging.js";
import { createWorldView } from "../engine/world-view.js";
import { artifactWorld, type ScenarioArtifact } from "../scenario/artifact.js";
import { checkCompleteness } from "../scenario/completeness.js";
import { checkInvariants } from "../scenario/invariants.js";
import { type Finding, siteIndex, validateArtifact } from "../scenario/validate.js";
import { walkTheStory } from "../scenario/walk.js";
import { journeys, toldWhereToGo } from "../scenario/wayfinding.js";
import { type Args, CraftError } from "./args.js";
import { openWorkspace, structuralProblems } from "./workspace.js";
import { requireId } from "./world.js";

/**
 * Everything that can be known about a scenario without playing it, and then playing it.
 *
 * Two commands rather than one because they answer different questions and cost different
 * amounts. `check` reasons about the files and the world they were written against — fast,
 * deterministic, run after every edit. `playtest` builds a real session and walks the story
 * through the real engine, which is the only way to find out that the person a beat hangs on
 * is not actually standing in the town written for them.
 */

export function craftCheck(args: Args, out: (line: string) => void): void {
	const workspace = openWorkspace(requireId(args, "check"));
	args.refuseUnknown();
	const artifact = workspace.artifact;

	const errors: string[] = [];
	const warnings: string[] = [];

	for (const problem of structuralProblems(artifact)) errors.push(problem);
	for (const finding of validateArtifact(artifact)) collect(finding, errors, warnings);
	for (const finding of checkCompleteness(artifact)) collect(finding, errors, warnings);
	for (const violation of checkInvariants(artifact).violations) {
		errors.push(`${violation.invariant} at ${violation.where}: ${violation.detail}`);
	}
	errors.push(...improvisationProblems(artifact));
	errors.push(...stagingProblems(artifact));
	warnings.push(...wayfindingProblems(artifact));
	// A warning rather than an error, because a scene that goes by too fast is dull rather
	// than broken — and dullness is the one fault the whole review pass exists to find, so
	// the part of it a machine can see is worth saying out loud.
	for (const scene of Object.values(artifact.scenes ?? {})) {
		warnings.push(...scenePacingProblems(scene));
	}

	for (const error of errors) out(`error  ${error}`);
	for (const warning of warnings) out(`warn   ${warning}`);

	if (errors.length === 0 && warnings.length === 0) {
		out(`"${artifact.id}" is clean`);
		out(`next: craft playtest ${artifact.id}`);
		return;
	}
	out("");
	out(`${errors.length} error(s), ${warnings.length} warning(s)`);
	if (errors.length > 0) throw new CraftError(`"${artifact.id}" has errors`, 1);
}

function collect(finding: Finding, errors: string[], warnings: string[]): void {
	(finding.severity === "error" ? errors : warnings).push(finding.message);
}

/**
 * Nobody the story hangs on may improvise.
 *
 * The rule the `--live` flag exists to be checked against, and the one that makes live
 * conversation safe in an authored world. Talking to a story anchor *is* the story moving —
 * the beat has opened, the errand is in the log — and a model asked to greet the player
 * writes a fine line about the weather while the thing it was meant to hand over goes
 * unmentioned. The runtime refuses anyway; this says so at authoring time, where it can be
 * fixed, rather than leaving an author with a flag that quietly does nothing.
 */
function improvisationProblems(artifact: ScenarioArtifact): string[] {
	const anchors = storyNpcIds(artifact.arc);
	const problems: string[] = [];
	for (const site of Object.values(artifact.sites)) {
		for (const npc of site.npcs) {
			const id = npcId(site.siteId, npc.slot);
			if (npc.live && anchors.has(id)) {
				problems.push(
					`${npc.name} (${id}) anchors the story and is marked --live; a beat cannot be handed over by a model`,
				);
			}
			if (npc.treeAlias && !artifact.trees?.[npc.treeAlias]) {
				problems.push(
					`${npc.name} speaks with ${npc.treeAlias}'s words, and nobody has written them`,
				);
			}
		}
	}
	return problems;
}

/**
 * Every cutscene, staged against the real world.
 *
 * The check that could not exist before the engine could stage one: it builds the ground, the
 * settlements and the roster, and asks each scene whether its points resolve and its walks
 * connect. A scene that cannot be staged never opens at play time, so its trigger stays
 * unfired and the chapter it was going to turn never turns — silently.
 */
function stagingProblems(artifact: ScenarioArtifact): string[] {
	const scenes = Object.entries(artifact.scenes ?? {});
	if (scenes.length === 0) return [];

	const world = artifactWorld(artifact);
	const chunks = new ChunkManager({
		world,
		capacity: 512,
		bounds: artifact.bounds,
		specFor: (site) => artifact.sites[String(site.id)]?.settlement,
		...(artifact.terraform ? { terraform: artifact.terraform } : {}),
	});
	const view = createWorldView({
		seed: artifact.seed,
		chunkAt: (cx, cy) => chunks.get(cx, cy),
		revision: () => chunks.revision,
	});
	const sites = sitesInside(world, artifact.bounds);
	const people = new NpcDirectory(chunks, (id) => artifact.sites[String(id)]);

	// Build the ground around every claimed town before asking, since a walk is searched over
	// tiles that have to exist to be passable.
	for (const site of sites.values()) {
		if (!artifact.sites[String(site.id)]) continue;
		chunks.prefetch({ cx: site.mx, cy: site.my }, 1);
	}
	people.populate([...sites.values()]);

	const problems: string[] = [];
	for (const [id, scene] of scenes) {
		const { problems: found } = stageScene(scene, {
			world,
			bounds: artifact.bounds,
			siteSpec: (siteId) => artifact.sites[String(siteId)],
			isPassable: (x, y) => view.isPassable(x, y),
			player: artifact.spawn,
			npcAt: (who) => {
				const person = people.byNpcId(who);
				return person ? { x: person.x, y: person.y } : undefined;
			},
		});
		for (const problem of found) problems.push(`scene "${id}": ${problem}`);
	}
	return problems;
}

/** Legs of the story the player is never told the direction of. Worth saying, not fatal. */
function wayfindingProblems(artifact: ScenarioArtifact): string[] {
	if (!artifact.arc) return [];
	const legs = journeys(artifact, siteIndex(artifact));
	return legs
		.filter((leg) => !toldWhereToGo(artifact, leg))
		.map(
			(leg) =>
				`nothing tells the player to go to ${leg.destination.name} after "${leg.from.id}" — "craft signposts" puts up boards`,
		);
}

export async function craftPlaytest(args: Args, out: (line: string) => void): Promise<void> {
	const workspace = openWorkspace(requireId(args, "playtest"));
	args.refuseUnknown();
	const artifact = workspace.artifact;
	if (!artifact.arc) {
		out(`"${artifact.id}" has no story, so there is nothing to walk`);
		return;
	}

	const walk = await walkTheStory(artifact, `craft-playtest-${artifact.id}`);

	out(`walked ${walk.opened.length} of ${artifact.arc.beats.length} beat(s)`);
	for (const given of walk.concessions) out(`  given  ${given}`);
	for (const missing of walk.absent) out(`  absent ${missing}`);
	for (const stuck of walk.stuck) out(`  stuck  ${stuck}`);
	for (const open of walk.unfinished) out(`  open   ${open}`);

	if (!walk.finished) {
		throw new CraftError(
			`"${artifact.id}" does not reach its ending. The lines above say where it stops.`,
		);
	}
	out(
		`"${artifact.id}" plays to the end${walk.concessions.length ? `, with ${walk.concessions.length} hand-out(s)` : ""}`,
	);
}
