import { dispositionLabel, type NpcRecord } from "../../core/rules/npc.js";
import { buyPrice, type StockItem, sellPrice } from "../../core/rules/shop.js";
import { activeQuests, type GameState, itemCount } from "../../core/rules/state.js";
import type { NpcSpec, RegionSpec, SiteSpec, WorldLore } from "../../core/world/spec.js";
import type { Weather } from "../../core/world/weather.js";
import { timeOfDay } from "../../core/world/weather.js";

/**
 * Who this person is, right now, to this player.
 *
 * The prompt is rebuilt every turn from persisted memory rather than from a
 * message array that has to be kept alive, which is what lets a conversation be
 * resumed hours later and after a restart. It is also where reputation stops
 * being a number in a save file and starts changing how someone talks to you.
 */

export interface PersonaInput {
	readonly lore: WorldLore;
	readonly region?: RegionSpec;
	readonly site?: SiteSpec;
	readonly spec?: NpcSpec;
	readonly record: NpcRecord;
	readonly state: GameState;
	/** Goods this person sells, priced by the engine. */
	readonly stock?: readonly StockItem[];
	readonly weather?: Weather;
}

export function dialogueSystem(input: PersonaInput): string {
	const { record, spec, site, region, lore } = input;
	const lines: string[] = [];

	lines.push(
		`You are ${record.name}, ${record.role}${site ? ` in ${site.name}` : ""}. ` +
			"You are speaking to a traveller. Stay in character at all times.",
	);

	if (spec?.appearance) lines.push(`You look like this: ${spec.appearance}`);
	if (spec?.persona) lines.push(`How you are: ${spec.persona}`);

	lines.push(`World: ${lore.title}. ${lore.premise} The prevailing tone is ${lore.tone}.`);
	if (region) lines.push(`You live in ${region.name}: ${region.blurb} (${region.culture})`);
	if (site?.description) lines.push(`About this place: ${site.description}`);

	if (spec?.knows.length) {
		lines.push(
			`Things you know and will share if asked:\n${spec.knows.map((k) => `- ${k}`).join("\n")}`,
		);
	}
	if (site?.hooks.length) {
		lines.push(`Local troubles you are aware of:\n${site.hooks.map((h) => `- ${h}`).join("\n")}`);
	}

	if (input.stock?.length) {
		// Prices are stated up front so the NPC can quote them correctly. What the
		// player is actually charged is computed by the engine from the same
		// numbers, so an NPC who misquotes is merely wrong, not exploitable.
		const disposition = record.disposition;
		lines.push(
			"",
			"You sell these, at these prices, and nothing else:",
			...input.stock.map(
				(item) => `- ${item.name} — ${buyPrice(item.price, disposition)} gold. ${item.description}`,
			),
			`You will buy most things off a traveller at around ${Math.round(
				sellPrice(10, disposition) * 10,
			)}% of what they are worth.`,
			"To sell something, use the `buy` action naming the item; to purchase from the traveller, " +
				"use `sell`. Never state a price the list does not give.",
		);
	}

	lines.push(
		"",
		"HOW TO ANSWER",
		"- `speech` is what you say aloud. One or two sentences. Never narrate the player's actions, " +
			"never describe your own gestures in third person, never use markdown.",
		"- `choices` is what the *player* may say next, written in the player's voice, first person. " +
			"Two to four of them, each a distinct direction the conversation could go. Return an empty " +
			"list only when the conversation is genuinely over.",
		"- `actions` are things that should actually happen in the world. Use them sparingly and only " +
			"when your own words have just committed to them: do not give an item you did not offer.",
		"- Reuse the same `questId` when you advance or complete a quest you gave earlier.",
		"- You cannot see the player's inventory beyond what is listed below, and you cannot invent " +
			"what they are carrying.",
	);

	return lines.join("\n");
}

export function dialoguePrompt(input: PersonaInput, playerSaid: string | undefined): string {
	const { record, state } = input;
	const lines: string[] = [];

	lines.push(`Your feeling towards this traveller: ${dispositionLabel(record.disposition)}.`);

	if (record.totalTurns === 0) {
		lines.push("You have never met them before.");
	} else {
		lines.push(`You have spoken ${record.totalTurns} times before.`);
		if (record.summary) lines.push(`What you remember: ${record.summary}`);
		if (record.facts.length) {
			lines.push(`Things you know about them:\n${record.facts.map((f) => `- ${f}`).join("\n")}`);
		}
	}

	if (record.recentTurns.length > 0) {
		lines.push(
			"",
			"Recently:",
			...record.recentTurns.map((turn) =>
				turn.role === "player" ? `Traveller: ${turn.text}` : `You: ${turn.text}`,
			),
		);
	}

	const standing = Object.entries(state.reputation).filter(([, value]) => value !== 0);
	if (standing.length > 0) {
		lines.push(
			`Word of them has reached you: ${standing
				.map(([faction, value]) => `${faction} (${dispositionLabel(value)})`)
				.join(", ")}.`,
		);
	}

	lines.push("", playerState(state));
	if (input.weather) {
		lines.push(
			`It is ${timeOfDay(state.time.hour)}. ${input.weather.description} Mention it only if it matters.`,
		);
	}

	lines.push(
		"",
		playerSaid
			? `The traveller says: "${playerSaid}"`
			: record.totalTurns === 0
				? "They have just walked up to you. Greet them."
				: "They have come back to you. Say something that shows you remember them.",
	);

	return lines.join("\n");
}

/** The facts about the player an NPC could plausibly observe or be told. */
function playerState(state: GameState): string {
	const gold = itemCount(state, "Gold");
	const carried = state.inventory
		.filter((item) => item.name !== "Gold")
		.slice(0, 8)
		.map((item) => (item.quantity > 1 ? `${item.name} x${item.quantity}` : item.name));

	const quests = activeQuests(state)
		.slice(0, 4)
		.map(
			(quest) => `${quest.name}${quest.progress.length ? ` (${quest.progress.length} steps)` : ""}`,
		);

	const parts = [
		`They carry ${gold} gold.`,
		carried.length ? `Also carrying: ${carried.join(", ")}.` : "They carry nothing else of note.",
	];
	if (quests.length) parts.push(`They are working on: ${quests.join("; ")}.`);
	parts.push(`It is hour ${state.time.hour} of day ${state.time.day}.`);
	return parts.join(" ");
}

export const SUMMARY_SYSTEM =
	"You maintain one character's memory of one traveller. Compress, do not embellish. " +
	"Write the summary as plain prose in third person, under 120 words. Facts are short, " +
	"durable statements — what the traveller did, wanted, or promised — not pleasantries.";

export function summaryPrompt(record: NpcRecord, folding: readonly string[]): string {
	return [
		`You are ${record.name}, ${record.role}.`,
		record.summary
			? `What you remembered until now: ${record.summary}`
			: "You had not formed an impression of them yet.",
		record.facts.length ? `Known facts:\n${record.facts.map((f) => `- ${f}`).join("\n")}` : "",
		"",
		"Since then:",
		...folding,
		"",
		"Fold this into a single updated memory. `dispositionDelta` is how much this exchange should",
		"move your regard for them, from -20 to 20; use 0 if nothing much happened.",
	]
		.filter(Boolean)
		.join("\n");
}
