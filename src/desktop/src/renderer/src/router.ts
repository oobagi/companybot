import { useSyncExternalStore } from "react";

// A tiny hash router. Each screen has a path ("/customize/connectors/night-owl");
// navigate() pushes a history entry, so back (button, mouse, swipe) returns to the
// screen before. Hash-based so it works from the packaged app's file:// page.

const read = () => window.location.hash.slice(1) || "/chat";

const subscribe = (onChange: () => void) => {
	window.addEventListener("hashchange", onChange);
	return () => window.removeEventListener("hashchange", onChange);
};

/** The current path, split into segments: "/customize/connectors" → ["customize", "connectors"]. */
export function useRoute(): string[] {
	const path = useSyncExternalStore(subscribe, read);
	return path.split("/").filter(Boolean).map(decodeURIComponent);
}

export function navigate(...segments: string[]) {
	const path = `/${segments.map(encodeURIComponent).join("/")}`;
	if (path !== read()) window.location.hash = path;
}
