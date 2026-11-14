import { api } from "@companybot/backend/convex/_generated/api";
import { ConvexError } from "convex/values";

export { api };

/** Turns a Convex error into a message people can read. */
export function errorMessage(e: unknown): string {
	if (e instanceof ConvexError) {
		const data = e.data as unknown;
		if (typeof data === "string") return data;
		if (data && typeof data === "object" && "message" in data) return String(data.message);
	}
	return e instanceof Error ? e.message : String(e);
}
