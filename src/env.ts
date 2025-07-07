import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();

export const ENV = {
	worldName: process.env.WORLD_NAME ?? "default",
	googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
	thinkingBudget: process.env.THINKING_BUDGET
		? Number(process.env.THINKING_BUDGET)
		: null,
	temperature: process.env.TEMPERATURE
		? Number(process.env.TEMPERATURE)
		: undefined,
	googleAI: createGoogleGenerativeAI(),
};

export const openai = createOpenAI({
	// custom settings, e.g.
	compatibility: "strict", // strict mode, enable when using the OpenAI API
});

export const CONFIG = {
	model: google("gemini-2.5-flash"),
	// model: google("gemini-2.5-pro"),
	// model: openai("gpt-4.1-mini"),
};
