import { useSyncExternalStore } from "react";

// A tiny hash router. Each screen has a path ("/customize/connectors/night-owl");
// navigate() pushes a history entry, so back (button, mouse, swipe) returns to the
// screen before. Hash-based so it works from the packaged app's file:// page.

const read = () => window.location.hash.slice(1) || "/chat";

const subscribe = (onChange: () => void) => {
	window.addEventListener("hashchange", onChange);
	return () => window.removeEventListener("hashchange", onChange);
};

/** A pasted link can hold a bad escape; the segment then stands as written. */
const decode = (segment: string) => {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
};

/** The current path, split into segments: "/customize/connectors" → ["customize", "connectors"]. */
export function useRoute(): string[] {
	const path = useSyncExternalStore(subscribe, read);
	return path.split("/").filter(Boolean).map(decode);
}

const pathOf = (segments: string[]) => `/${segments.map(encodeURIComponent).join("/")}`;

export function navigate(...segments: string[]) {
	const path = pathOf(segments);
	if (path !== read()) window.location.hash = path;
}

/** Goes to a screen in place of the current one: for a redirect, so back never returns to a path that only redirects again. */
export function redirect(...segments: string[]) {
	const path = pathOf(segments);
	if (path === read()) return;
	window.history.replaceState(null, "", `#${path}`);
	window.dispatchEvent(new HashChangeEvent("hashchange"));
}
