import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { ForegroundColor, type ForegroundColorName } from "chalk";
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();

export const ENV = {
	worldName: process.env.WORLD_NAME ?? "default",
	googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
	temperature: process.env.TEMPERATURE ? Number(process.env.TEMPERATURE) : 1,
	googleAI: createGoogleGenerativeAI(),
};

export const openai = createOpenAI({
	// custom settings, e.g.
	compatibility: "strict", // strict mode, enable when using the OpenAI API
});

export const CONFIG = {
	model: google("gemini-2.5-flash"),
	// model: openai("gpt-4.1-mini"),

	colorMap: {
		// x: "black",
		X: "blackBright",
		b: "blue",
		B: "blueBright",
		c: "cyan",
		C: "cyanBright",
		g: "green",
		G: "greenBright",
		m: "magenta",
		M: "magentaBright",
		r: "red",
		R: "redBright",
		w: "white",
		y: "yellow",
		Y: "yellowBright",
	} satisfies Record<string, ForegroundColorName>,

	nonWalkableSymbols: [
		"█",
		"━",
		"┃",
		"┏",
		"┓",
		"┗",
		"┛",
		"┣",
		"┫",
		"┳",
		"┻",
		"╋",
		"●",
	],
};
