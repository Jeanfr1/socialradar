/**
 * Provider-neutral contracts. Provider adapters (src/server/providers/<provider>/) map raw API
 * responses into these shapes. Nothing in here may carry credentials.
 */
import type { Platform, Weekday } from "@/domain/types";

export type ProviderErrorCode =
  | "unauthorized" // invalid, revoked or expired credential — not retryable
  | "forbidden" // credential valid but lacks permission — not retryable
  | "not_found"
  | "rate_limited" // retryable after retryAfterMs
  | "upstream" // provider 5xx / UPSTREAM_SERVER_ERROR — retryable
  | "network" // transport failure / timeout — retryable
  | "invalid_response" // schema drift or unparseable payload — not retryable without code change
  | "quota_reserved"; // BrandPulse refused to spend quota reserved for existing automations — retry later

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  constructor(code: ProviderErrorCode, message: string, opts: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = code === "rate_limited" || code === "upstream" || code === "network" || code === "quota_reserved";
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export type CredentialValidationResult =
  | { ok: true; externalAccountId: string; externalAccountName: string; organizations: ProviderOrganization[] }
  | { ok: false; code: ProviderErrorCode; message: string };

export interface ProviderOrganization {
  externalId: string;
  name: string;
  channelCount: number;
  limits: Record<string, number>;
}

export interface RateLimitWindow {
  name: string; // e.g. "100-in-15min"
  limit: number;
  remaining: number;
  resetAt: string; // ISO
  windowSeconds: number;
}

export interface ProviderChannel {
  externalChannelId: string;
  organizationExternalId: string;
  platform: Platform;
  service: string;
  platformAccountId: string;
  channelType: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  timezone: string;
  isQueuePaused: boolean;
  isDisconnected: boolean;
  isLocked: boolean;
  canViewInsights: boolean;
  postingSchedule: { day: Weekday; paused: boolean; times: string[] }[];
}

export type CanonicalPostStatus = "draft" | "needs_approval" | "scheduled" | "sending" | "sent" | "error";

export interface ProviderMetric {
  /** Canonical metric key (see src/domain/metrics.ts), or null when the provider type is not mapped. */
  key: string | null;
  providerType: string;
  unit: string;
  value: number;
}

export interface ProviderPost {
  externalPostId: string;
  externalChannelId: string;
  status: CanonicalPostStatus;
  dueAt: Date | null;
  sentAt: Date | null;
  shareMode: string | null;
  schedulingType: string | null;
  isCustomScheduled: boolean | null;
  via: string | null;
  format: string | null;
  text: string | null;
  title: string | null;
  externalUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  providerTags: string[];
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  metricsUpdatedAt: Date | null;
  /** Null when the provider did not include a metrics list (e.g. not sent yet). */
  metrics: ProviderMetric[] | null;
}
