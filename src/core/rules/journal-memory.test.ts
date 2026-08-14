import { describe, expect, it } from "vitest";
import { reduce, type WorldProbe } from "./reduce.js";
import { createInitialState, type GameState } from "./state.js";

/*
 * What the game told you, an hour later.
 *
 * Every direction this game gives arrives in one of two places — a full screen of prose, or
 * somebody's mouth — and both used to be gone the moment they were dismissed. The journal
 * held one line written by the author, which is the right thing in a list and no help at all
 * when the player has forgotten which of three names the ferryman said to ask for.
 */

const world: WorldProbe = {
	isPassable: () => true,
	isLoaded: () => true,
	npcAt: () => undefined,
};

function start(): GameState {
	return createInitialState({ id: "w", name: "W", seed: 1, createdAt: "" }, { x: 0, y: 0 });
}

const CARD = {
	id: "opening",
	title: "The Sandflat Shore",
	subtitle: "late mediaeval",
	sections: [
		{ heading: "Where you are", body: "A coast of shallow water and long tides." },
		{ heading: "Where to start", body: "Wenthollow lies north. Ask for Ilse Wentworth." },
	],
} as const;

describe("a card the player has read", () => {
	it("goes into the journal, in full", () => {
		const { state } = reduce(
			start(),
			{ t: "ApplyEffects", effects: [{ t: "ShowCard", card: CARD }] },
			world,
		);
		const entry = state.journal.at(-1);
		expect(entry?.text).toBe("The Sandflat Shore — late mediaeval");
		expect(entry?.detail).toEqual([
			"Where you are: A coast of shallow water and long tides.",
			"Where to start: Wenthollow lies north. Ask for Ilse Wentworth.",
		]);
	});

	it("is written once, however many times it is raised", () => {
		// `ShowCard` refuses a card already read, so reaching the journal at all means this is
		// the first time — but a beat re-applied after a partial save raises it again.
		let state = reduce(
			start(),
			{ t: "ApplyEffects", effects: [{ t: "ShowCard", card: CARD }] },
			world,
		).state;
		state = reduce(state, { t: "DismissCard" }, world).state;
		state = reduce(
			state,
			{ t: "ApplyEffects", effects: [{ t: "ShowCard", card: CARD }] },
			world,
		).state;
		expect(state.journal.filter((entry) => entry.source === "card:opening")).toHaveLength(1);
	});

	it("keeps a card with nothing in it out of the journal, as it keeps it off the screen", () => {
		const empty = { id: "nothing", title: "Nothing", sections: [] };
		const { state } = reduce(
			start(),
			{ t: "ApplyEffects", effects: [{ t: "ShowCard", card: empty }] },
			world,
		);
		expect(state.journal).toEqual([]);
	});
});

describe("a conversation that moved the story on", () => {
	/** A state with a beat's clue already in the journal and a conversation open on it. */
	function midConversation(): GameState {
		const base = start();
		return {
			...base,
			journal: [
				{
					tick: base.time.tick,
					kind: "event",
					text: "Ask Rell at Ash Hollow.",
					source: "arc:ask-the-ferryman",
				},
			],
			dialogue: {
				npcId: "npc:1:0",
				npcName: "Ilse Wentworth",
				lines: [
					{ speaker: "Ilse Wentworth", text: "Ferry's not running." },
					{ speaker: "You", text: "What happened?" },
					{ speaker: "Ilse Wentworth", text: "Go east and ask Rell." },
				],
				cursor: 2,
				choiceIndex: 0,
				pending: false,
			},
		};
	}

	it("keeps what was said under the clue it produced", () => {
		const { state } = reduce(midConversation(), { t: "CloseDialogue" }, world);
		expect(state.journal.at(-1)?.detail).toEqual([
			"Ilse Wentworth: Ferry's not running.",
			"You: What happened?",
			"Ilse Wentworth: Go east and ask Rell.",
		]);
		// The summary is untouched: it is what the list shows, and the author wrote it.
		expect(state.journal.at(-1)?.text).toBe("Ask Rell at Ash Hollow.");
	});

	it("says nothing about a conversation that opened no beat", () => {
		// Ordinary chat. A villager with nothing to do with the story never wrote an entry, so
		// there is nowhere for their words to go — which is the point, not a limitation.
		const chat: GameState = { ...midConversation(), journal: [] };
		const { state } = reduce(chat, { t: "CloseDialogue" }, world);
		expect(state.journal).toEqual([]);
	});

	it("does not overwrite words already kept", () => {
		const twice = midConversation();
		const once = reduce(twice, { t: "CloseDialogue" }, world).state;
		const again = reduce(
			{ ...once, dialogue: twice.dialogue },
			{ t: "CloseDialogue" },
			world,
		).state;
		expect(again.journal.at(-1)?.detail).toEqual(once.journal.at(-1)?.detail);
	});

	it("attaches nothing when nobody said anything", () => {
		const silent: GameState = {
			...midConversation(),
			dialogue: {
				...(midConversation().dialogue as NonNullable<GameState["dialogue"]>),
				lines: [],
			},
		};
		const { state } = reduce(silent, { t: "CloseDialogue" }, world);
		expect(state.journal.at(-1)?.detail).toBeUndefined();
	});
});
