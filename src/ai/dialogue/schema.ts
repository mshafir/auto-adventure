import { z } from "zod";

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
	target: z
		.string()
		.max(80)
		.describe("Item name for 'have', NPC name for 'talk', place name for 'reach', flag key."),
	quantity: z.number().int().min(1).max(99).nullable(),
});

export const ActionSchema = z.object({
	kind: z.enum(ACTION_KINDS),
	item: z.string().max(60).nullable().describe("Item name, for giveItem and takeItem."),
	description: z.string().max(200).nullable(),
	quantity: z.number().int().min(-9999).max(9999).nullable(),
	questId: z
		.string()
		.max(60)
		.nullable()
		.describe("Short stable slug, reused when advancing or completing the same quest."),
	questName: z.string().max(80).nullable(),
	note: z.string().max(240).nullable(),
	objectives: z.array(ObjectiveSchema).max(3).nullable(),
	key: z.string().max(60).nullable().describe("Flag key, or faction name for adjustReputation."),
	value: z.string().max(60).nullable(),
});

export const DialogueTurnSchema = z.object({
	speech: z.string().max(500).describe("What they say. One or two sentences, in their voice."),
	choices: z
		.array(z.string().max(90))
		.max(4)
		.describe(
			"What the player may say next, in the player's voice. Two to four, or none to end the conversation.",
		),
	actions: z.array(ActionSchema).max(3),
	endsConversation: z.boolean(),
});

export const NpcSummarySchema = z.object({
	summary: z
		.string()
		.max(700)
		.describe("Everything worth remembering about this relationship, in prose."),
	newFacts: z
		.array(z.string().max(120))
		.max(4)
		.describe("Durable things they learned about the player."),
	dispositionDelta: z.number().int().min(-20).max(20),
});

export type DialogueTurnResponse = z.infer<typeof DialogueTurnSchema>;
export type ActionResponse = z.infer<typeof ActionSchema>;
export type NpcSummaryResponse = z.infer<typeof NpcSummarySchema>;
