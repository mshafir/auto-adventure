import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { type CoreMessage, generateText, streamText, type ToolSet } from "ai";
import { CONFIG, ENV } from "../env.js";
import { log, logChars } from "../utils/log.js";

export async function textGen(prompt: string) {
	log(`Prompt: ${prompt}`);
	const controller = new AbortController();
	const response = streamText({
		model: CONFIG.model,
		prompt,
		abortSignal: controller.signal,
		temperature: ENV.temperature,
		providerOptions: {
			google: {
				thinkingConfig: {
					thinkingBudget: 0,
				},
			} satisfies GoogleGenerativeAIProviderOptions,
		},
	});

	let result = "";
	let lines = 0;
	for await (const chunk of response.textStream) {
		logChars(chunk);
		result += chunk;
		lines += chunk.split("\n").length;
		if (lines > 100) {
			controller.abort();
		}
	}
	log("");
	return result;
}

export async function textGenWithTools(
	messages: CoreMessage[],
	tools: ToolSet,
) {
	log(`\n>>>> Text gen with tools: ${JSON.stringify(messages, null, 2)}`);
	const response = await generateText({
		model: CONFIG.model,
		messages,
		temperature: ENV.temperature,
		tools,
		providerOptions: {
			google: {
				thinkingConfig: {
					thinkingBudget: 0,
				},
			} satisfies GoogleGenerativeAIProviderOptions,
		},
	});
	log(
		`\n\n>>>>> Response: ${JSON.stringify(
			response.response.messages,
			null,
			2,
		)}`,
	);
	return response.response.messages;
}
