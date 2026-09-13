import { ProviderError, type CredentialValidationResult } from "@/server/providers/types";
import { mapOrganization, type RawOrganization } from "./adapter";
import { BufferClient } from "./client";
import { ACCOUNT_QUERY } from "./queries";

interface AccountQueryData {
  account: { id: string; name: string | null; timezone: string | null; organizations: RawOrganization[] };
}

/** Minimal read-only request (1 quota unit) proving the key works and listing its organizations. */
export async function validateBufferCredential(
  secret: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<CredentialValidationResult> {
  try {
    const client = new BufferClient({ token: secret.trim(), fetchImpl: deps.fetchImpl, maxRetries: 2 });
    const data = await client.query<AccountQueryData>(ACCOUNT_QUERY);
    return {
      ok: true,
      externalAccountId: data.account.id,
      externalAccountName: data.account.name?.trim() || `Buffer account …${data.account.id.slice(-6)}`,
      organizations: data.account.organizations.map(mapOrganization),
    };
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError("network", "Buffer validation failed");
    return { ok: false, code: e.code, message: e.message };
  }
}
