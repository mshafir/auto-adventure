import { GoogleGenAI } from "@google/genai";
import { generateObject } from "ai";
import type z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { CONFIG, ENV } from "../env.js";
import { log } from "../utils/log.js";

export async function objectGen<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
): Promise<T> {
	return objectGenVercel(prompt, schema);
}

export async function objectGenVercel<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
): Promise<T> {
	const result = await generateObject({
		model: CONFIG.model,
		temperature: ENV.temperature,
		prompt,
		schema,
	});
	log("Usage: ", result.usage);
	return result.object;
}

export async function objectGenGoogle<T>(
	prompt: string,
	schema: z.ZodSchema<T>,
) {
	const genai = new GoogleGenAI({ apiKey: ENV.googleApiKey });
	log(`Prompt: ${prompt}`);
	const response = await genai.models.generateContent({
		model: CONFIG.model.modelId,
		contents: prompt,
		config: {
			temperature: ENV.temperature,
			responseMimeType: "application/json",
			responseJsonSchema: zodToJsonSchema(schema, {
				$refStrategy: "none",
				removeAdditionalStrategy: "strict",
			}),
		},
	});
	const result = JSON.parse(response.text ?? "{}") as T;
	log(`Generated result for prompt`, response.usageMetadata);
	return result;
}
