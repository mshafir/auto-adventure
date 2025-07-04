import type { GoogleGenerativeAIProviderOptions } from "@ai-sdk/google";
import { type CoreMessage, generateText, streamText, type ToolSet } from "ai";
import { CONFIG, ENV } from "../env.js";
import { log, logChars } from "../utils/log.js";

export async function textGen(prompt: string) {
	log(`Prompt: ${prompt}`);
	const response = streamText({
		model: CONFIG.model,
		prompt,
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
	for await (const chunk of response.textStream) {
		logChars(chunk);
		result += chunk;
	}
	log("");
	return result;
}

export async function textGenWithTools(
	messages: CoreMessage[],
	tools: ToolSet,
) {
	log(`Text gen with tools`, messages);
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
	log(`Response`, response.response.messages);
	return response.response.messages;
}
