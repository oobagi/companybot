import { useQuery } from "../../convex";
import { api } from "../../api";

// "Folders on top" (Settings → Your preferences, `preferences.foldersFirst`, off by default): Drive shows
// each level's and section's folders above its pages and files, each keeping their order, as Finder can.

/** `rows` with the folders ahead of the rest, each in the order they came. */
export function foldersFirst<T>(rows: readonly T[], isFolder: (row: T) => boolean): T[] {
	const folders = rows.filter(isFolder);
	return folders.length && folders.length < rows.length ? [...folders, ...rows.filter((row) => !isFolder(row))] : [...rows];
}

/** Whether this person keeps folders on top. */
export function useFoldersFirst() {
	return useQuery(api.preferences.get)?.foldersFirst ?? false;
}
