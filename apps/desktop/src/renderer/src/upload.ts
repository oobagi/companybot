import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { FILE_MAX_BYTES, fileError } from "@companybot/core/files";
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

/**
 * Uploads a file for a message (files.ts), signed in, reporting progress from 0 to 1, and returns its
 * storage id for `messages.send` to claim. Checked here first by its bytes; the backend checks again.
 */
export function useFileUpload() {
	const endpoint = useQuery(api.files.uploadEndpoint);
	const token = useAuthToken();
	const workspace = useWorkspace();
	return async (file: File, onProgress: (done: number) => void): Promise<Id<"_storage">> => {
		const error = file.size > FILE_MAX_BYTES ? fileError(new Uint8Array(), file.name, file.size) : fileError(new Uint8Array(await file.arrayBuffer()), file.name);
		if (error) throw new Error(error);
		if (!endpoint || !token || !workspace) throw new Error("Still connecting. Try again in a moment.");
		// fetch can't report upload progress; XMLHttpRequest can.
		return new Promise((resolve, reject) => {
			const failed = "The upload didn't go through. Try again.";
			const xhr = new XMLHttpRequest();
			xhr.open("POST", `${endpoint}?${new URLSearchParams({ workspaceId: workspace.id, name: file.name })}`);
			xhr.setRequestHeader("Authorization", `Bearer ${token}`);
			xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
			xhr.onload = () => {
				let body: { storageId?: Id<"_storage">; error?: string } | null = null;
				try {
					body = JSON.parse(xhr.responseText);
				} catch {}
				if (xhr.status === 200 && body?.storageId) resolve(body.storageId);
				else reject(new Error(body?.error ?? failed));
			};
			xhr.onerror = () => reject(new Error(failed));
			xhr.send(file);
		});
	};
}
