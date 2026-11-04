import { type OAuthState, findConnector, finishSignIn } from "@companybot/core";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { decrypt, encrypt } from "./crypto";
import { oauthRedirectUrl } from "./connectors";

/**
 * GET /oauth/callback: where a connector's sign-in page sends the person back.
 * Exchanges the code for tokens and saves the connection. The app updates live,
 * so this page only needs to say it worked.
 */
export const callback = httpAction(async (ctx, request) => {
	const params = new URL(request.url).searchParams;
	const state = params.get("state");
	const flow = state ? await ctx.runMutation(internal.connectors.takeOAuthFlow, { state }) : null;
	// Each sign-in names the membership and install it started under; older ones can't be checked, so they're refused.
	const { workspaceId, memberId, connectorInstallId } = flow ?? {};
	if (!state || !flow || !workspaceId || !memberId || !connectorInstallId) return page("This sign-in link expired.", "Go back to Companybot and connect again.");
	const connector = findConnector(flow.connectorId);
	if (!connector) return page("That connector isn't available anymore.");
	if (params.get("error")) {
		return page(`${connector.name} didn't connect.`, params.get("error_description") ?? "Access was denied.");
	}
	const code = params.get("code");
	if (!code) return page(`${connector.name} didn't connect.`, "The sign-in didn't return a code.");

	try {
		const oauth = await finishSignIn(connector, await decrypt<OAuthState>(flow.data), oauthRedirectUrl(), {
			code,
			state,
			issuer: params.get("iss") ?? undefined,
		});
		// saveConnection re-checks that this person may still connect it, under that membership and install.
		await ctx.runMutation(internal.connectors.saveConnection, {
			userId: flow.userId,
			workspaceId,
			memberId,
			connectorInstallId,
			connectorId: connector.id,
			credentials: await encrypt({ type: "oauth", oauth }),
		});
	} catch (e) {
		return page(`${connector.name} didn't connect.`, e instanceof Error ? e.message : String(e));
	}
	return page(`${connector.name} is connected.`, "You can close this tab and go back to Companybot.");
});

const escape = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, detail = "") {
	const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title>
<body style="font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#171717">
<main style="max-width:28rem;text-align:center"><h1 style="font-size:1.25rem;font-weight:600">${escape(title)}</h1><p style="color:#737373">${escape(detail)}</p></main>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
