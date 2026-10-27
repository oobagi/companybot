import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { imageError } from "@companybot/core/images";
import { api } from "./api";
import { useMutation } from "./convex";

/**
 * Uploads a file to Convex storage and returns its id, for a mutation to keep. `check` says
 * why a file won't do (pictures by default); the backend checks again.
 */
export function useUpload(check: (file: File) => string | undefined = imageError) {
	const uploadUrl = useMutation(api.images.uploadUrl);
	return async (file: File): Promise<Id<"_storage">> => {
		const error = check(file);
		if (error) throw new Error(error);
		const response = await fetch(await uploadUrl(), { method: "POST", headers: { "Content-Type": file.type }, body: file }).catch(() => null);
		if (!response?.ok) throw new Error("The upload didn't go through. Try again.");
		return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
	};
}
