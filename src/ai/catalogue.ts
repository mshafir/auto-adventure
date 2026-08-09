/**
 * Which models a world can be written with, and what they cost.
 *
 * Every id here is a Vercel AI Gateway slug, which is the only kind of name this
 * game knows: `client.ts` hands the string straight to the AI SDK and the gateway
 * decides whose datacentre it lands in. Adding a provider is therefore a row in
 * this table, not a code change — and the prices are real numbers off the
 * gateway's own catalogue rather than each vendor's pricing page, because the
 * gateway is who actually bills for this.
 *
 * Each entry names *two* models, not one. The game makes two very different kinds
 * of call: a lot of small structured ones whose output nobody ever reads (a
 * settlement's shape, a person's trade, a summary), and rather fewer prose ones
 * the player reads every word of. Running both on the model good enough for the
 * second costs several times what the world is worth, and running both on the
 * model cheap enough for the first is visible in the writing. So a choice here is
 * a *pair*, and the row is named after the half you can see.
 */

export interface ModelPrice {
	/** US dollars per million input tokens. */
	readonly input: number;
	/** US dollars per million output tokens. */
	readonly output: number;
}

export interface ModelChoice {
	/** Stable; what gets written into settings and onto a generate request. */
	readonly id: string;
	/** The name of the prose model, which is the one worth recognising. */
	readonly label: string;
	readonly provider: string;
	/** True where the weights are published and the model can be run elsewhere. */
	readonly openWeights?: boolean;
	/** High-volume structured work: the director, and summaries. */
	readonly fast: { readonly model: string; readonly price: ModelPrice };
	/** Prose the player reads: dialogue, and the world's lore. */
	readonly prose: { readonly model: string; readonly price: ModelPrice };
	/** One line for the settings page, saying what the trade is. */
	readonly note: string;
}

/**
 * Prices as published by the gateway on 2026-08-07, in dollars per million tokens.
 *
 * They will drift, and a stale number here is a number that misleads rather than
 * one that breaks: nothing is charged against this table, it only orders the list
 * and draws the multiplier. Worth re-reading off `GET /v1/models` when a row
 * starts looking wrong.
 *
 * Every model here has been asked for an object and has answered in the schema,
 * six times out of six — see `catalogue-live.test.ts`, which is the only thing
 * that can check it. That bar removed more candidates than price did, and none of
 * them announced themselves: the game never crashes on a malformed answer, because
 * `structured` returns undefined and every caller falls back to procedural
 * generation. A flaky model is therefore not an error anybody sees. It is a world
 * that quietly comes out with none of the authored names in it, several minutes
 * and several hundred calls after somebody chose to pay for authored ones. What
 * that cost, on a first pass at this table:
 *
 * - `openai/gpt-oss-20b` — spends thirty seconds and returns unparseable output.
 * - `openai/gpt-oss-120b`, `zai/glm-4.7`, `zai/glm-4.6` — answer in the schema
 *   between one and two times in six. All three are good writers and all three are
 *   unusable here; GLM survives on this list only as its Flash model.
 * - `alibaba/qwen3.5-flash` and `-plus` — reject every structured call outright
 *   ("'messages' must contain the word 'json'"). Meeting that would mean editing
 *   the system prompt of every authoring pass to suit one provider, which is a
 *   worse trade than one fewer row. Worth retrying if it changes.
 *
 * The bar is not "a good model". It is "a good model that can be relied on to
 * answer in a schema", and the second half is the part that has to be measured.
 */
export const CATALOGUE: readonly ModelChoice[] = [
	{
		id: "glm",
		label: "GLM-4.7 Flash",
		provider: "Z.ai (open weights)",
		openWeights: true,
		// One small model throughout, and deliberately: the full-size GLM-4.7 writes
		// better prose and answers in the requested schema about one time in six,
		// which is not a trade this game can make. See the note above the table.
		fast: { model: "zai/glm-4.7-flash", price: { input: 0.07, output: 0.4 } },
		prose: { model: "zai/glm-4.7-flash", price: { input: 0.07, output: 0.4 } },
		note: "The cheapest way to see a world get written, and quick with it. Prose is plainer than the rest of this list; the towns and the people are as real either way.",
	},
	{
		id: "deepseek",
		label: "DeepSeek V3.2",
		provider: "DeepSeek (open weights)",
		openWeights: true,
		fast: { model: "deepseek/deepseek-v3.2", price: { input: 0.28, output: 0.42 } },
		prose: { model: "deepseek/deepseek-v3.2", price: { input: 0.28, output: 0.42 } },
		note: "One model for both jobs, priced almost the same for what it reads and what it writes — so a talkative world costs about what a terse one does.",
	},
	{
		id: "gpt-5-mini",
		label: "GPT-5 mini",
		provider: "OpenAI",
		fast: { model: "openai/gpt-5-nano", price: { input: 0.05, output: 0.4 } },
		prose: { model: "openai/gpt-5-mini", price: { input: 0.25, output: 2.0 } },
		note: "Nano does the bookkeeping and mini does the writing. Holds a long brief well, which shows up as a story that remembers its own beginning.",
	},
	{
		id: "gemini-2.5",
		label: "Gemini 2.5 Flash",
		provider: "Google",
		fast: { model: "google/gemini-2.5-flash-lite", price: { input: 0.1, output: 0.4 } },
		prose: { model: "google/gemini-2.5-flash", price: { input: 0.3, output: 2.5 } },
		note: "What the game has always used, and what every other row here is priced against. Fast enough that a live world keeps up with walking.",
	},
	{
		id: "gemini-3",
		label: "Gemini 3 Flash",
		provider: "Google",
		fast: { model: "google/gemini-3.1-flash-lite", price: { input: 0.25, output: 1.5 } },
		prose: { model: "google/gemini-3-flash", price: { input: 0.5, output: 3.0 } },
		note: "The same shape as the default, a generation newer. Noticeably better at holding a plot together across a long world.",
	},
	{
		id: "claude-haiku",
		label: "Claude Haiku 4.5",
		provider: "Anthropic",
		fast: { model: "anthropic/claude-haiku-4.5", price: { input: 1.0, output: 5.0 } },
		prose: { model: "anthropic/claude-haiku-4.5", price: { input: 1.0, output: 5.0 } },
		note: "One model throughout. Writes people who sound like people; the small model doing the bookkeeping is the same expensive one, which is most of why this costs what it does.",
	},
	{
		id: "claude-sonnet",
		label: "Claude Sonnet 5",
		provider: "Anthropic",
		fast: { model: "anthropic/claude-haiku-4.5", price: { input: 1.0, output: 5.0 } },
		prose: { model: "anthropic/claude-sonnet-5", price: { input: 2.0, output: 10.0 } },
		note: "The best writing on offer here and by some way the most expensive. Worth it for a world you intend to keep.",
	},
];

/** The one every other row is priced against, and the one used when nothing is chosen. */
export const DEFAULT_MODEL_SET = "gemini-2.5";

export function modelChoice(id: string | undefined): ModelChoice {
	return CATALOGUE.find((entry) => entry.id === id) ?? defaultChoice();
}

export function defaultChoice(): ModelChoice {
	// Non-null by construction: DEFAULT_MODEL_SET names a row above, and the test
	// suite asserts it, so the fallback is only here to satisfy the type.
	return CATALOGUE.find((entry) => entry.id === DEFAULT_MODEL_SET) ?? (CATALOGUE[0] as ModelChoice);
}

/**
 * Roughly what a world on this pair costs, as one number.
 *
 * Two thirds weight on the cheap model because that is roughly the share of calls
 * it takes — one per region, one per place, one per summary — against one prose
 * call per person who can be spoken to. Input and output are averaged rather than
 * modelled, because the ratio between them depends on how much of the world is
 * already written when a call goes out, which nothing knows in advance.
 *
 * Only ever used as a ratio against the default. As an absolute it means nothing,
 * and it is not exported for that reason.
 */
function blended(choice: ModelChoice): number {
	const average = (price: ModelPrice) => (price.input + price.output) / 2;
	return 0.65 * average(choice.fast.price) + 0.35 * average(choice.prose.price);
}

/**
 * What this choice costs relative to the default, as "0.3×" or "6.6×".
 *
 * A multiplier rather than a dollar figure, because a dollar figure would need a
 * token count to multiply, and the honest token count for "a world" is a range
 * three times as wide as the difference between two adjacent rows here. What a
 * player actually wants to know is whether this one is dearer than the one above
 * it and by how much, and that survives the prices drifting.
 */
export function costRatio(choice: ModelChoice): number {
	const base = blended(defaultChoice());
	return base > 0 ? blended(choice) / base : 1;
}

export function costLabel(choice: ModelChoice): string {
	const ratio = costRatio(choice);
	if (choice.id === DEFAULT_MODEL_SET) return "1× — the default";
	return `${ratio < 10 ? ratio.toFixed(1) : ratio.toFixed(0)}× the default`;
}

/** `$0.30 in / $2.50 out per million tokens`, for the paragraph under a row. */
export function priceLine(price: ModelPrice): string {
	return `$${price.input.toFixed(2)} in / $${price.output.toFixed(2)} out per Mtok`;
}
