import type { BuildingPlacement } from "../core/gen/features/patch.js";
import { arcOutline, beatNpcId, orderedBeats, type ScenarioBeat } from "../core/rules/arc.js";
import { asCondition, itemsRead } from "../core/rules/condition.js";
import type { DomainEffect } from "../core/rules/effects.js";
import type { Facing, GameState, QuestObjective } from "../core/rules/state.js";
import { namesMatch } from "../core/rules/surroundings.js";
import { toChunk } from "../core/world/coords.js";
import type { MacroSite } from "../core/world/macro.js";
import { buildSession } from "../session.js";
import type { ScenarioArtifact } from "./artifact.js";
import { siteIndex } from "./validate.js";

/**
 * Play the story to the end, in the real engine, and report what it took.
 *
 * The offline checks all reason *about* the artifact. This one runs it: a real session,
 * real chunks, real settlement patches, real NPC placement, the real reducer settling
 * after every command. That catches the one class nothing else can — a beat whose anchor
 * the engine never actually puts anywhere, so the person the story hangs on is not
 * standing in the town that was written for them.
 *
 * Deliberately not on the generation path. Building a session and walking a story is
 * seconds of work per scenario, and the offline pass already catches everything that can
 * be caught statically. This is the thing to run before shipping a scenario by hand.
 *
 * ## Concessions
 *
 * A walker is not a player. It cannot search a crate it has no reason to look in, or
 * work out which conversation hands over the ring. Where an objective cannot be satisfied
 * by going somewhere or speaking to somebody, it is granted outright — and *recorded*,
 * because a story that only finishes with four things handed to the player is a different
 * result from one that finishes on its own, and reporting "finished" for both would make
 * this worth nothing.
 */

export interface WalkReport {
	/** Beats that opened by being played, in the order they opened. */
	readonly opened: readonly string[];
	/** Beats that never opened. Empty is the result worth having. */
	readonly stuck: readonly string[];
	/** What had to be given rather than earned, in words. */
	readonly concessions: readonly string[];
	/** Whether `arcOutline` says the story is told. */
	readonly finished: boolean;
	/** People the engine never placed, so the walk could not reach them. */
	readonly absent: readonly string[];
	/**
	 * Errands still open at the end, and which objective of each.
	 *
	 * Reported separately from `stuck` because they are a different failure with the same
	 * symptom. Every beat can open and the story still never end: `arcOutline` will not
	 * call it finished while an errand it handed out is unclosed, so one objective the
	 * world cannot tick leaves the player at the last scene with no ending and nothing on
	 * screen to say what is missing.
	 */
	readonly unfinished: readonly string[];
}

/**
 * How many times to go round.
 *
 * Each round opens whatever it can and satisfies whatever it can, and one round is
 * enough for a straight chain of beats — this is the guard against a story that loops,
 * not a budget the walk is expected to spend.
 */
const MAX_ROUNDS = 32;

/** How many doors to open looking for one person before giving up on them. */
const INDOOR_TRIES = 12;

export async function walkTheStory(
	artifact: ScenarioArtifact,
	worldId = `walk-${artifact.id}`,
): Promise<WalkReport> {
	const arc = artifact.arc;
	if (!arc || arc.beats.length === 0)
		return {
			opened: [],
			stuck: [],
			concessions: [],
			finished: true,
			absent: [],
			unfinished: [],
		};

	const session = buildSession(
		{ worldId, seed: artifact.seed, flavour: "prebuilt", scenario: artifact },
		{ saveDebounceMs: 0 },
	);
	const { engine } = session;
	// The opening card blocks movement until it is read, which is the point of it.
	engine.dispatch({ t: "DismissCard" });

	const sites = siteIndex(artifact);
	const opened: string[] = [];
	const concessions: string[] = [];
	const absent = new Set<string>();
	const state = () => engine.getState();

	const apply = (...effects: DomainEffect[]) => engine.dispatch({ t: "ApplyEffects", effects });

	/**
	 * Read whatever the story has just put on screen.
	 *
	 * Not housekeeping. A card blocks the game until it is dismissed — deliberately, since
	 * framing that can be walked out of unread is framing nobody reads — so a walker that
	 * never dismisses one stops being able to do anything the moment a beat shows one. The
	 * symptom is precise and thoroughly misleading: conversations still *open*, but the
	 * dialogue never lands in state, so a `talk` objective sits unticked forever and the
	 * story reports as unfinishable when in fact nobody was listening.
	 */
	const readCards = () => {
		for (let guard = 0; guard < 16 && state().card; guard++) {
			engine.dispatch({ t: "DismissCard" });
		}
	};

	/**
	 * Turn to face a direction, which is what the first press of a key does.
	 *
	 * A `Move` the player is not already facing turns them and nothing else — the game's
	 * own rule, and the right one for a keyboard. A walker that dispatches one command per
	 * direction therefore spends half of them turning on the spot, which is how a room
	 * with a door in it becomes a room with no way out.
	 */
	const face = (facing: Facing) => {
		if (state().player.facing !== facing) engine.dispatch({ t: "Move", facing });
	};

	/** One actual step, in the direction given. */
	const step = (facing: Facing) => {
		face(facing);
		engine.dispatch({ t: "Move", facing });
	};

	/**
	 * Come back out, the way a player does: step off the threshold and back onto it.
	 *
	 * A doorway is crossed by *walking through it*, so there is no "leave" to dispatch —
	 * and entering leaves the player standing on the exit tile, which cannot be stepped
	 * onto from where they already are. One step in and one step back is the whole trick;
	 * the directions are tried in turn because a room's furniture decides which of them is
	 * free.
	 *
	 * Getting this wrong is quiet and expensive. Indoors the player's coordinates are
	 * interior-local and the reducer asks which place they are in about the *doorstep* they
	 * came in by — so a walker that thinks it left, teleports across the world, and carries
	 * on is reported as standing in the last town it was inside, forever. A `reach`
	 * objective for the town it is actually standing in never ticks, and the story reads as
	 * unfinishable.
	 */
	const leaveRoom = () => {
		const ways = [
			["up", "down"],
			["down", "up"],
			["left", "right"],
			["right", "left"],
		] as const;
		for (const [away, back] of ways) {
			if (!state().player.inside) return;
			step(away);
			// Checked between the two, not only around the pair. The step *away* is often the
			// one that lands on the exit — and stepping back afterwards walks straight in
			// through the door again, which looks exactly like never having left.
			if (!state().player.inside) return;
			step(back);
		}
	};

	/** Stand in a place, which is what makes the engine agree the player has been there. */
	const goTo = (site: MacroSite) => {
		// Out of doors first. Indoors the player's coordinates are interior-local, so
		// teleporting without leaving would put them at a world position while the game
		// still believes they are in a room — and every question about where they are,
		// from which town this is to which chunks to keep, answers about somewhere else.
		leaveRoom();
		// Ground first, then stand on it. The reducer settles inside the teleport — asking
		// which place this is, ticking whatever that answers — so arriving before the chunk
		// exists means arriving nowhere, and a `reach` objective for the town the player is
		// standing in stays open.
		//
		// The whole footprint, not the chunk under the player: a roster derived while some
		// of a town's ground is missing is a guess, at the limit a guess that nobody lives
		// there. Two chunks either way covers the largest site the generator makes.
		const cc = toChunk(site.site.x, site.site.y);
		engine.getChunks().prefetch(cc, 2);
		engine.populateNpcs(cc);
		apply({ t: "Teleport", x: site.site.x, y: site.site.y });
	};

	/** Every building of a settlement, the one a person was assigned to first. */
	const buildingsOf = (siteId: number, structureName?: string): BuildingPlacement[] => {
		const site = sites.get(siteId);
		if (!site) return [];
		const cc = toChunk(site.site.x, site.site.y);
		const around: BuildingPlacement[] = [];
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				around.push(...engine.getChunks().buildingsIn(cc.cx + dx, cc.cy + dy));
			}
		}
		const wanted = structureName?.toLowerCase();
		if (!wanted) return around;
		return [...around].sort(
			(a, b) => Number(b.name?.toLowerCase() === wanted) - Number(a.name?.toLowerCase() === wanted),
		);
	};

	/**
	 * Go in through a door, the way a player does: stand on the step and walk into it.
	 *
	 * Walking, not interacting. A doorway is crossed by stepping onto it — deliberately,
	 * so that a door behaves the way a door should — and `Interact` is for searching and
	 * speaking. A walker that pressed the interact key at a door stood on the step
	 * forever and reported everybody indoors as missing.
	 */
	const enterBuilding = (building: BuildingPlacement): boolean => {
		apply({ t: "Teleport", x: building.door.x, y: building.door.y + 1 });
		readCards();
		step("up");
		return state().player.inside !== undefined;
	};

	/**
	 * Find somebody the scenario put in a room, by going in and looking.
	 *
	 * An indoor character is only resolvable while the player is standing in their
	 * building, which is correct and which means a walker that never goes inside reports
	 * every one of them as missing. The building they were assigned to is tried first and
	 * the rest are tried after it, because `structureName` is matched loosely by the
	 * engine and a walk that trusted it exactly would give up on a scene that a player
	 * would find by opening the next door along.
	 */
	const findIndoors = (id: string, siteId: number, structure?: string) => {
		for (const building of buildingsOf(siteId, structure).slice(0, INDOOR_TRIES)) {
			leaveRoom();
			if (!enterBuilding(building)) continue;
			const person = engine.personById(id);
			if (person) return person;
		}
		return undefined;
	};

	const talkTo = async (
		id: string,
		indoors?: { readonly siteId: number; readonly structure?: string },
	): Promise<boolean> => {
		readCards();
		const person = indoors
			? (engine.personById(id) ?? findIndoors(id, indoors.siteId, indoors.structure))
			: engine.personById(id);
		if (!person) {
			absent.add(id);
			return false;
		}
		engine.dispatch({ t: "DialogueOpened", npcId: person.id, npcName: person.name });
		// The opening line arrives through the dialogue service, and `talked` reads the
		// turn it records — so this needs a real tick, not a zero-tick wait.
		await new Promise((resolve) => setTimeout(resolve, 20));
		engine.dispatch({ t: "CloseDialogue" });
		readCards();
		return true;
	};

	for (let round = 0; round < MAX_ROUNDS; round++) {
		let moved = false;

		for (const beat of orderedBeats(arc)) {
			if (state().flags[beat.setsFlag]) continue;
			const site = sites.get(beat.siteId);
			if (!site) continue;

			// A beat gated on carrying something opens the moment the player has it, and
			// finding it is not something a walker can do. Granted before the visit so the
			// scene plays as it would for a player who had already found it.
			for (const item of itemsRead(asCondition(beat.opensOn))) {
				if (state().inventory.some((entry) => entry.name === item)) continue;
				apply({
					t: "GrantItem",
					name: item,
					description: "Given, to walk the story.",
					quantity: 1,
				});
				concessions.push(`gave "${item}" so beat ${beat.id} could open`);
			}

			goTo(site);
			if (state().flags[beat.setsFlag]) {
				// It opened on arrival: `opensOn` was about standing here, not about talking.
				opened.push(beat.id);
				moved = true;
				continue;
			}
			await talkTo(beatNpcId(beat), roomOf(beat.siteId, beat.npcSlot));
			if (!state().flags[beat.setsFlag]) continue;
			opened.push(beat.id);
			moved = true;
		}

		for (const quest of state().quests) {
			if (quest.completed) continue;
			for (const objective of quest.objectives) {
				if (objective.done) continue;
				// Judged on whether the objective actually ticked, not on whether the attempt
				// ran. Walking to a town the errand names is always *possible*, so a walker
				// that counted the attempt as progress would keep going back there for as many
				// rounds as it has, and a story with one hole in it would cost the same as
				// thirty-two playthroughs to find out.
				const before = ticked(state());
				await satisfy(objective, quest.name);
				if (ticked(state()) > before) moved = true;
			}
		}

		if (!moved) break;
	}

	const stuck = orderedBeats(arc)
		.filter((beat) => !state().flags[beat.setsFlag])
		.filter((beat) => !barred(state(), beat))
		.map((beat) => beat.id);

	const unfinished = state()
		.quests.filter((quest) => !quest.completed)
		.map((quest) => {
			const open = quest.objectives
				.filter((objective) => !objective.done)
				.map((objective) => `${objective.kind} "${objective.target}"`);
			return `"${quest.name}" is open on ${open.join(" and ") || "nothing it can name"}`;
		});

	const finished = arcOutline(arc, state())?.finished === true;
	session.dispose();
	return { opened, stuck, concessions, finished, absent: [...absent], unfinished };

	/** The room somebody stands in, when the scenario put them in one. */
	function roomOf(
		siteId: number,
		slot: number,
	): { readonly siteId: number; readonly structure?: string } | undefined {
		const npc = artifact.sites[String(siteId)]?.npcs.find((person) => person.slot === slot);
		if (!npc?.indoors) return undefined;
		return { siteId, ...(npc.structureName ? { structure: npc.structureName } : {}) };
	}

	/** Do the thing an objective asks for, or hand it over and say so. */
	async function satisfy(objective: QuestObjective, questName: string): Promise<boolean> {
		if (objective.kind === "quest") return false;
		if (objective.kind === "reach") {
			const target = [...sites.values()].find((site) =>
				namesMatch(artifact.sites[String(site.id)]?.name ?? "", objective.target),
			);
			if (!target) return false;
			goTo(target);
			return true;
		}
		if (objective.kind === "talk") {
			const found = Object.values(artifact.sites).flatMap((spec) =>
				spec.npcs
					.filter((npc) => namesMatch(npc.name, objective.target))
					.map((npc) => ({ spec, npc })),
			);
			const person = found[0];
			if (!person) return false;
			const site = sites.get(person.spec.siteId);
			if (site) goTo(site);
			return talkTo(
				`npc:${person.spec.siteId >>> 0}:${person.npc.slot}`,
				roomOf(person.spec.siteId, person.npc.slot),
			);
		}
		if (objective.kind === "have") {
			if (state().inventory.some((entry) => entry.name === objective.target)) return false;
			apply({
				t: "GrantItem",
				name: objective.target,
				description: "Given, to walk the story.",
				quantity: objective.quantity ?? 1,
			});
			concessions.push(`gave "${objective.target}" to close "${questName}"`);
			return true;
		}
		if (state().flags[objective.target]) return false;
		apply({ t: "SetFlag", key: objective.target, value: true });
		concessions.push(`set "${objective.target}" to close "${questName}"`);
		return true;
	}
}

/**
 * Whether this beat is an arm of a fork that went the other way.
 *
 * Excluded from `stuck`, because it is not stuck: the player chose, and choosing is what
 * bars it. Counting it would report every fork as an unfinishable story.
 */
/** How much of the errand log is actually done, as one number to compare against. */
function ticked(state: GameState): number {
	return state.quests.reduce(
		(total, quest) => total + quest.objectives.filter((objective) => objective.done).length,
		0,
	);
}

function barred(state: GameState, beat: ScenarioBeat): boolean {
	if (beat.branch === undefined) return false;
	const taken = state.flags[`arc:branch:${beat.branch}`];
	return typeof taken === "string" && taken !== beat.id;
}
