import { createGoogleGenerativeAI } from "@ai-sdk/google";
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();

export const env = {
	worldName: process.env.WORLD_NAME ?? "default",
	googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
	googleAI: createGoogleGenerativeAI(),
};
