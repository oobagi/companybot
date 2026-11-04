import { createLongplayServer } from "@tinkerlandai/longplay-sdk/server";
import { ConvexError } from "convex/values";
import { z } from "zod";

const configSchema = z.object({
	baseUrl: z.url(),
	apiKey: z.string().min(1),
	projectId: z.string().min(1),
	environment: z.enum(["sandbox", "live"]),
	featureId: z.uuid(),
});
type Client = Pick<ReturnType<typeof createLongplayServer>, "getOrCreateCustomer" | "checkEntitlement">;

/** Cloud-only pilot: a fresh access check before audio leaves for the AI Gateway. */
export async function requireDictationAccess(
	workspaceId: string,
	env: Record<string, string | undefined> = process.env,
	createClient: (options: Parameters<typeof createLongplayServer>[0]) => Client = createLongplayServer,
) {
	// Community/self-hosted deployments make no billing requests.
	if (!env.LONGPLAY_BILLING) return;
	let allowed: boolean;
	try {
		if (env.LONGPLAY_BILLING !== "longplay" || !workspaceId) throw new Error("Invalid billing configuration");
		const config = configSchema.parse({
			baseUrl: env.LONGPLAY_BASE_URL,
			apiKey: env.LONGPLAY_SECRET_KEY,
			projectId: env.LONGPLAY_APP_ID,
			environment: env.LONGPLAY_ENVIRONMENT,
			featureId: env.LONGPLAY_DICTATION_FEATURE_ID,
		});
		const client = createClient({ baseUrl: config.baseUrl, apiKey: config.apiKey, scope: { projectId: config.projectId, environment: config.environment }, timeoutMs: 5000 });
		// The caller has already resolved membership; never accept a browser-selected Customer.
		const { customer } = await client.getOrCreateCustomer({ externalUserId: `companybot:workspace:${workspaceId}` });
		const { check } = await client.checkEntitlement({ customerId: customer.id, requirement: { internal_feature_id: config.featureId, quantity: "1", properties: {} } });
		// A read-only check cannot reserve metered/credit balances. This pilot is access-only.
		if (check.kind !== "access") throw new Error("Dictation requires an access Feature");
		allowed = check.allowed;
	} catch {
		// No silent free access on an outage, and no provider/configuration secrets in the error.
		throw new ConvexError("Could not verify your workspace's dictation access. Please try again.");
	}
	if (!allowed) throw new ConvexError("Your workspace needs a plan with voice dictation. Ask its owner to manage the plan.");
}
