import type { Memory, MemoryScope, Role, ToolAccess } from "@companybot/core";
import { useCallback, useEffect, useState } from "react";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:8787";

export interface User {
	id: string;
	name: string;
	role: Role;
}

export interface Agent {
	id: string;
	name: string;
	description: string;
	model: string;
	tools: ToolAccess[];
}

export interface PluginInfo {
	id: string;
	name: string;
	description: string;
	version: string;
	installed: boolean;
	connection: { kind: string };
	tools: { name: string; description: string; roles: Role[] | null }[];
}

export type MemoryItem = Memory & { canEdit: boolean };

export async function api<T>(userId: string, path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${SERVER_URL}${path}`, {
		...init,
		headers: { "x-user-id": userId, "content-type": "application/json", ...init.headers },
	});
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
	return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Fetches `path` as `userId`, refetching when either changes. */
export function useApi<T>(userId: string, path: string) {
	const [data, setData] = useState<T>();
	const [error, setError] = useState<string>();
	const reload = useCallback(
		() =>
			api<T>(userId, path).then(
				(d) => (setData(d), setError(undefined)),
				(e: Error) => setError(e.message),
			),
		[userId, path],
	);
	useEffect(() => {
		reload();
	}, [reload]);
	return { data, error, reload };
}

export const memoryApi = {
	create: (userId: string, scope: MemoryScope, content: string) =>
		api(userId, "/memory", { method: "POST", body: JSON.stringify({ scope, content }) }),
	update: (userId: string, id: string, content: string) =>
		api(userId, `/memory/${id}`, { method: "PATCH", body: JSON.stringify({ content }) }),
	remove: (userId: string, id: string) => api(userId, `/memory/${id}`, { method: "DELETE" }),
};
