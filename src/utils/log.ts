import fs from "node:fs";

/** append data to the log.txt file */
export function log(data: any, ...params: any[]) {
	fs.appendFileSync(
		"log.txt",
		`${typeof data === "string" ? data : JSON.stringify(data)} ${params.length > 0 ? JSON.stringify(params) : ""}\n`,
	);
}

export function logChars(data: string) {
	fs.appendFileSync("log.txt", data);
}
