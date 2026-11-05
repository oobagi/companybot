import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { useFileUpload } from "../../upload";

// Uploads into Drive: the same upload endpoint as chat files (files.upload), then driveFiles.add
// claims each into the folder (or the top level). Progress shows where the upload started.

export type DriveUpload = { key: string; name: string; progress: number; error?: string };

/** Uploads files into a folder, reporting each one's progress until it's in Drive (then it drops off the list). */
export function useDriveUploads() {
	const upload = useFileUpload();
	const add = useMutation(api.driveFiles.add);
	const discard = useMutation(api.files.discard);
	const [pending, setPending] = useState<DriveUpload[]>([]);
	const update = (key: string, patch: Partial<DriveUpload>) => setPending((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));
	const drop = (key: string) => setPending((list) => list.filter((u) => u.key !== key));
	const start = (files: File[], parentId?: Id<"pages">) => {
		for (const file of files) {
			const key = crypto.randomUUID();
			setPending((list) => [...list, { key, name: file.name, progress: 0 }]);
			upload(file, (progress) => update(key, { progress }))
				.then((storageId) => add({ file: storageId, parentId }).catch((e: unknown) => (discard({ file: storageId }).catch(() => {}), Promise.reject(e))))
				.then(() => drop(key), (e: unknown) => update(key, { error: e instanceof Error ? e.message : String(e) }));
		}
	};
	return { pending, start, dismiss: drop };
}
