import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { imageError, imageHeadBytes } from "@companybot/core/images";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "./api";
import { useQuery, useWorkspace } from "./convex";

/**
 * Uploads a picture to the backend's upload endpoint, signed in, and returns its storage id
 * for a mutation to claim (`images.set`). Checked here first by its bytes; the backend checks again.
 */
export function useUpload() {
	const endpoint = useQuery(api.images.uploadEndpoint);
	const token = useAuthToken();
	const workspace = useWorkspace();
	return async (file: File): Promise<Id<"_storage">> => {
		const error = imageError(new Uint8Array(await file.slice(0, imageHeadBytes).arrayBuffer()), file.size);
		if (error) throw new Error(error);
		if (!endpoint || !token) throw new Error("Still connecting. Try again in a moment.");
		const url = workspace ? `${endpoint}?workspaceId=${workspace.id}` : endpoint;
		const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: file }).catch(() => null);
		const body = (await response?.json().catch(() => null)) as { storageId?: Id<"_storage">; error?: string } | null;
		if (!response?.ok || !body?.storageId) throw new Error(body?.error ?? "The upload didn't go through. Try again.");
		return body.storageId;
	};
}
