/** Configuration checks only, not a claim that a provider or hosted app has been tested. */
function appUrl(raw: string | undefined): URL | null {
	try {
		if (!raw) return null;
		const url = new URL(raw);
		if (url.username || url.password || url.hash) return null;
		if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return null;
		return url;
	} catch { return null; }
}

export function integrationEndpoint() {
	const url = appUrl(process.env.CONVEX_SITE_URL);
	return url && url.pathname === "/" && !url.search ? url.origin : null;
}

export const consentAppUrl = () => appUrl(process.env.INTEGRATION_APP_URL)?.href ?? null;

export function connectionEncryptionConfigured() {
	try { return atob(process.env.CONNECTIONS_KEY ?? "").length === 32; }
	catch { return false; }
}

export function connectorSetupProblem(auth: "none" | "api_key" | "oauth") {
	if (auth === "none") return null;
	if (!connectionEncryptionConfigured()) return "Connection setup required. Ask your Companybot administrator to configure secure credential storage, then try connecting again.";
	if (auth === "oauth" && !integrationEndpoint()) return "Browser sign-in setup required. Ask your Companybot administrator to configure the callback address, then try connecting again.";
	return null;
}
