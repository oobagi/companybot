import { api } from "@companybot/backend/convex/_generated/api";
import { ConvexError } from "convex/values";

export { api };

/** Turns a Convex error into a message people can read. */
export const errorMessage = (e: unknown) =>
	e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message : String(e);
