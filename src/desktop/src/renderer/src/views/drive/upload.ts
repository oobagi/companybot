import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useSyncExternalStore } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { useFileUpload } from "../../upload";

// Uploads into Drive: the same upload endpoint as chat files (files.upload), then driveFiles.add
// claims each into the folder (or the top level). One list for the whole app: the sidebar's + and
// a folder's screen both start uploads, the sidebar shows every one in flight, a screen shows its own.

/** `sectionId`: going into a sidebar section (top level only); the sidebar shows it there. */
export type DriveUpload = { key: string; name: string; parentId?: Id<"pages">; sectionId?: string; progress: number; error?: string };

let pending: DriveUpload[] = [];
const listeners = new Set<() => void>();
const set = (next: DriveUpload[]) => {
	pending = next;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};
const read = () => pending;

/** Uploads files into a folder, reporting each one's progress until it's in Drive (then it drops off the list). */
export function useDriveUploads() {
	const upload = useFileUpload();
	const add = useMutation(api.driveFiles.add);
	const discard = useMutation(api.files.discard);
	const list = useSyncExternalStore(subscribe, read);
	const update = (key: string, patch: Partial<DriveUpload>) => set(pending.map((u) => (u.key === key ? { ...u, ...patch } : u)));
	const drop = (key: string) => set(pending.filter((u) => u.key !== key));
	/** `section`: a sidebar section's + puts each file in it once it's in Drive (`onAdded`). */
	const start = (files: File[], parentId?: Id<"pages">, section?: { id: string; onAdded: (fileId: Id<"driveFiles">) => void }) => {
		for (const file of files) {
			const key = crypto.randomUUID();
			set([...pending, { key, name: file.name, parentId, sectionId: section?.id, progress: 0 }]);
			upload(file, (progress) => update(key, { progress }))
				.then((storageId) => add({ file: storageId, parentId }).catch((e: unknown) => (discard({ file: storageId }).catch(() => {}), Promise.reject(e))))
				.then((fileId) => (section?.onAdded(fileId), drop(key)), (e: unknown) => update(key, { error: e instanceof Error ? e.message : String(e) }));
		}
	};
	/** The uploads going into one folder (or the top level, with no `parentId`). */
	const into = (parentId?: Id<"pages">) => list.filter((u) => (u.parentId ?? null) === (parentId ?? null));
	return { pending: list, into, start, dismiss: drop };
}
