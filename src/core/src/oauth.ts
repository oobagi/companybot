import {
	type OAuthAuthorizationServerInformation,
	type OAuthClientInformation,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthTokens,
	auth,
} from "@ai-sdk/mcp";
import type { Connector } from "./connectors";

/**
 * MCP OAuth for connectors. The AI SDK runs the protocol (discovery, dynamic client
 * registration, PKCE, refresh); this keeps what it needs to remember in one plain
 * object, so the backend can encrypt it, store it, and pick it up in another request.
 *
 * Sign-in: `startSignIn` registers a client and returns the page to open → the
 * person approves in their browser → the provider redirects to our callback →
 * `finishSignIn` exchanges the code → tokens land in `state.tokens`.
 * Agent turns: pass the provider as the transport's `authProvider`; it sends the
 * token and refreshes it on a 401. Save `state` again when `changed` is true.
 */
export interface OAuthState {
	client?: OAuthClientInformation;
	server?: OAuthAuthorizationServerInformation;
	tokens?: OAuthTokens;
	/** Only during sign-in. */
	verifier?: string;
	state?: string;
}

export class ConnectorOAuth implements OAuthClientProvider {
	/** Set when the SDK stored something new, e.g. refreshed tokens. */
	changed = false;
	/** Where to send the person to approve access. Set during sign-in. */
	authorizationUrl?: URL;

	constructor(
		public data: OAuthState,
		readonly redirectUrl: string,
		/** False during agent turns: nobody is there to sign in, so asking fails. */
		private interactive: boolean,
	) {}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Companybot",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	private save(patch: Partial<OAuthState>) {
		this.data = { ...this.data, ...patch };
		this.changed = true;
	}

	tokens = () => this.data.tokens;
	saveTokens = (tokens: OAuthTokens) => this.save({ tokens });
	clientInformation = () => this.data.client;
	saveClientInformation = (client: OAuthClientInformation) => this.save({ client });
	// Only ever set through dynamic registration, so the SDK may re-register if it's rejected.
	isClientInformationDynamicallyRegistered = () => true;
	authorizationServerInformation = () => this.data.server;
	saveAuthorizationServerInformation = (server: OAuthAuthorizationServerInformation) => this.save({ server });
	codeVerifier = () => {
		if (!this.data.verifier) throw new Error("This sign-in expired. Try connecting again.");
		return this.data.verifier;
	};
	saveCodeVerifier = (verifier: string) => this.save({ verifier });
	state = () => crypto.randomUUID();
	saveState = (state: string) => this.save({ state });
	storedState = () => this.data.state;

	invalidateCredentials = (scope: "all" | "client" | "tokens" | "verifier") => {
		if (scope === "all") this.save({ client: undefined, server: undefined, tokens: undefined, verifier: undefined });
		else if (scope === "client") this.save({ client: undefined, server: undefined });
		else if (scope === "tokens") this.save({ tokens: undefined });
		else this.save({ verifier: undefined });
	};

	redirectToAuthorization(url: URL) {
		if (!this.interactive) throw new Error("The sign-in expired. Connect the connector again in Customize → Connectors.");
		this.authorizationUrl = url;
	}

	/** What to keep after sign-in: the one-time verifier and state are done. */
	get stored(): OAuthState {
		const { verifier: _, state: __, ...rest } = this.data;
		return rest;
	}
}

/** Begins sign-in. Store `state` (encrypted) under `state.state` until the callback. */
export async function startSignIn(connector: Connector, redirectUrl: string): Promise<{ url: string; state: OAuthState }> {
	const provider = new ConnectorOAuth({}, redirectUrl, true);
	const scope = connector.auth.type === "oauth" ? connector.auth.scopes?.join(" ") : undefined;
	await auth(provider, { serverUrl: connector.mcp.url, scope });
	if (!provider.authorizationUrl || !provider.data.state) throw new Error(`${connector.name} didn't ask to sign in.`);
	return { url: provider.authorizationUrl.href, state: provider.data };
}

/** Exchanges the callback's code for tokens. Returns what to store for the connection. */
export async function finishSignIn(
	connector: Connector,
	saved: OAuthState,
	redirectUrl: string,
	callback: { code: string; state: string; issuer?: string },
): Promise<OAuthState> {
	const provider = new ConnectorOAuth(saved, redirectUrl, false);
	await auth(provider, {
		serverUrl: connector.mcp.url,
		authorizationCode: callback.code,
		callbackState: callback.state,
		callbackIssuer: callback.issuer,
	});
	return provider.stored;
}
