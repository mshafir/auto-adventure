import { z } from "zod";
import { cappedInt, cappedList, cappedText } from "../limits.js";

/**
 * What an NPC is allowed to do in one turn.
 *
 * The old design gave the model tools whose `execute` wrote straight into the
 * store — which is how a stale snapshot could clobber a tool's write, and why a
 * second identical item pickup was silently dropped by a text-matching dedup
 * hack. Here the model produces *data*: a line of speech, some choices, and a
 * list of requested actions. Nothing is applied until a pure function has
 * turned it into `DomainEffect[]`.
 *
 * The action shape is deliberately flat rather than a discriminated union.
 * Structured-output support for unions varies by provider, and a flat object
 * with nullable fields is validated just as strictly one level up, in
 * `mapActions`, where it can be unit-tested against recorded malformed input.
 */

export const ACTION_KINDS = [
	"giveItem",
	"takeItem",
	"adjustGold",
	"createQuest",
	"advanceQuest",
	"completeQuest",
	"setFlag",
	"adjustDisposition",
	"recordJournal",
	"heal",
	"adjustReputation",
	// Trade: name the item, not the price. What it costs is the engine's call.
	"buy",
	"sell",
] as const;

export const OBJECTIVE_KINDS = ["reach", "talk", "have", "flag"] as const;

export const ObjectiveSchema = z.object({
	kind: z.enum(OBJECTIVE_KINDS),
	target: cappedText(80).describe(
		"Item name for 'have', NPC name for 'talk', place name for 'reach', flag key.",
	),
	quantity: cappedInt(1, 99).nullable(),
});

export const ActionSchema = z.object({
	kind: z.enum(ACTION_KINDS),
	item: cappedText(60).nullable().describe("Item name, for giveItem and takeItem."),
	description: cappedText(200).nullable(),
	quantity: cappedInt(-9999, 9999).nullable(),
	questId: cappedText(60)
		.nullable()
		.describe("Short stable slug, reused when advancing or completing the same quest."),
	questName: cappedText(80).nullable(),
	note: cappedText(240).nullable(),
	objectives: cappedList(ObjectiveSchema, 3).nullable(),
	key: cappedText(60).nullable().describe("Flag key, or faction name for adjustReputation."),
	value: cappedText(60).nullable(),
});

export const DialogueTurnSchema = z.object({
	speech: cappedText(500).describe("What they say. One or two sentences, in their voice."),
	choices: cappedList(cappedText(90), 4).describe(
		"What the player may say next, in the player's voice. Two to four, or none to end the conversation.",
	),
	actions: cappedList(ActionSchema, 3),
	endsConversation: z.boolean(),
});

export const NpcSummarySchema = z.object({
	summary: cappedText(700).describe(
		"Everything worth remembering about this relationship, in prose.",
	),
	newFacts: cappedList(cappedText(120), 4).describe(
		"Durable things they learned about the player.",
	),
	dispositionDelta: cappedInt(-20, 20),
});

export type DialogueTurnResponse = z.infer<typeof DialogueTurnSchema>;
export type ActionResponse = z.infer<typeof ActionSchema>;
export type NpcSummaryResponse = z.infer<typeof NpcSummarySchema>;
