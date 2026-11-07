import { beforeEach, expect, it, vi } from "vitest";
import { requireDictationAccess } from "../convex/dictationAccess";

const mocks = vi.hoisted(() => ({ create: vi.fn(), customer: vi.fn(), check: vi.fn() }));
vi.mock("@tinkerlandai/longplay-sdk/server", () => ({ createLongplayServer: mocks.create }));
const featureId = "11111111-1111-4111-8111-111111111111";
const env = { LONGPLAY_BILLING: "longplay", LONGPLAY_BASE_URL: "https://billing.example", LONGPLAY_SECRET_KEY: "server-only", LONGPLAY_APP_ID: "app", LONGPLAY_ENVIRONMENT: "sandbox", LONGPLAY_DICTATION_FEATURE_ID: featureId };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.create.mockReturnValue({ getOrCreateCustomer: mocks.customer, checkEntitlement: mocks.check });
	mocks.customer.mockResolvedValue({ customer: { id: "workspace-customer" } });
	mocks.check.mockResolvedValue({ check: { allowed: true, kind: "access" } });
});

it("leaves Community offline even when unrelated config exists", async () => {
	await requireDictationAccess("workspace", { LONGPLAY_SECRET_KEY: "unused" });
	expect(mocks.create).not.toHaveBeenCalled();
});

it("maps the verified workspace, supplies an explicit scope and checks the configured capability", async () => {
	await requireDictationAccess("workspace", env);
	expect(mocks.create).toHaveBeenCalledWith({ baseUrl: "https://billing.example", apiKey: "server-only", scope: { projectId: "app", environment: "sandbox" }, timeoutMs: 5000 });
	expect(mocks.customer).toHaveBeenCalledWith({ externalUserId: "companybot:workspace:workspace" });
	expect(mocks.check).toHaveBeenCalledWith({ customerId: "workspace-customer", requirement: { internal_feature_id: featureId, quantity: "1", properties: {} } });
});

it("refreshes access on every call rather than caching a previous grant", async () => {
	await requireDictationAccess("workspace", env);
	mocks.check.mockResolvedValue({ check: { allowed: false, kind: "access" } });
	await expect(requireDictationAccess("workspace", env)).rejects.toThrow("needs a plan");
	expect(mocks.check).toHaveBeenCalledTimes(2);
});

it("does not mistake a balance observation for permission to spend", async () => {
	mocks.check.mockResolvedValue({ check: { allowed: true, kind: "credit" } });
	await expect(requireDictationAccess("workspace", env)).rejects.toThrow("Could not verify");
});

it("fails closed on a service error without leaking it", async () => {
	mocks.check.mockRejectedValue(new Error("credential: secret-value"));
	await expect(requireDictationAccess("workspace", env)).rejects.toThrow("Could not verify");
	await expect(requireDictationAccess("workspace", env)).rejects.not.toThrow("secret-value");
});

it.each([{ ...env, LONGPLAY_ENVIRONMENT: "other" }, { ...env, LONGPLAY_DICTATION_FEATURE_ID: "" }, { ...env, LONGPLAY_BILLING: "unknown" }])("refuses incomplete or invalid opt-in configuration", async (config) => {
	await expect(requireDictationAccess("workspace", config)).rejects.toThrow("Could not verify");
	expect(mocks.create).not.toHaveBeenCalled();
});
