/**
 * GraphQL documents verified against the live Buffer schema (introspection, 2026-09-13).
 * Read-only. Only fields BrandPulse needs are selected (no emails, no author data).
 */

const POST_CORE = `id channelId status dueAt sentAt shareMode isCustomScheduled schedulingType via createdAt updatedAt`;
const POST_META = `metadata {
  __typename
  ... on InstagramPostMetadata { type }
  ... on TiktokPostMetadata { type title }
  ... on YoutubePostMetadata { type title }
}`;
const PAGE_INFO = `pageInfo { hasNextPage endCursor }`;

export const ACCOUNT_QUERY = `query BrandPulseAccount {
  account {
    id
    name
    timezone
    organizations { id name channelCount limits { channels scheduledPosts members } }
  }
}`;

const CHANNEL_FIELDS = `id name displayName service serviceId type timezone avatar externalLink
  isQueuePaused isDisconnected isLocked allowedActions
  postingSchedule { day paused times }`;

/**
 * VERIFIED PROVIDER DEFECT (2026-09-13): a status filter that includes `needs_approval` together with other
 * statuses silently returns zero posts (no error). Pending posts and approvals are therefore queried separately,
 * and a status-agnostic `upcoming` listing cross-checks the result in the same request.
 */
const PENDING_FILTER = `filter: { status: [scheduled, sending] }, sort: [{ field: dueAt, direction: asc }]`;

/**
 * One request per organization: channels, first page of pending posts, approvals, a status-agnostic upcoming
 * cross-check, recent failures and recently sent posts (so a post that just published is not mistaken for a
 * disappeared one).
 */
export const ORG_QUEUE_QUERY = `query BrandPulseQueue($org: OrganizationId!, $errorsSince: DateTime!, $sentSince: DateTime!, $upcomingSince: DateTime!) {
  channels(input: { organizationId: $org }) { ${CHANNEL_FIELDS} }
  pending: posts(first: 100, input: { organizationId: $org, ${PENDING_FILTER} }) {
    edges { node { ${POST_CORE} ${POST_META} text } }
    ${PAGE_INFO}
  }
  approvals: posts(first: 100, input: { organizationId: $org, filter: { status: [needs_approval] } }) {
    edges { node { ${POST_CORE} ${POST_META} text } }
    ${PAGE_INFO}
  }
  upcoming: posts(first: 100, input: { organizationId: $org, filter: { dueAt: { start: $upcomingSince } }, sort: [{ field: dueAt, direction: asc }] }) {
    edges { node { ${POST_CORE} ${POST_META} } }
    ${PAGE_INFO}
  }
  failed: posts(first: 50, input: { organizationId: $org, filter: { status: [error], dueAt: { start: $errorsSince } }, sort: [{ field: dueAt, direction: desc }] }) {
    edges { node { ${POST_CORE} ${POST_META} text error { message } } }
    ${PAGE_INFO}
  }
  recentSent: posts(first: 100, input: { organizationId: $org, filter: { status: [sent], dueAt: { start: $sentSince } }, sort: [{ field: dueAt, direction: desc }] }) {
    edges { node { ${POST_CORE} ${POST_META} externalLink } }
    ${PAGE_INFO}
  }
}`;

export const PENDING_PAGE_QUERY = `query BrandPulsePendingPage($org: OrganizationId!, $after: String) {
  pending: posts(first: 100, after: $after, input: { organizationId: $org, ${PENDING_FILTER} }) {
    edges { node { ${POST_CORE} ${POST_META} text } }
    ${PAGE_INFO}
  }
}`;

/** Sent posts with lifetime metrics (Buffer refreshes metrics about once per day). */
export const PUBLISHED_PAGE_QUERY = `query BrandPulsePublished($org: OrganizationId!, $since: DateTime!, $after: String) {
  published: posts(first: 100, after: $after, input: { organizationId: $org, filter: { status: [sent], dueAt: { start: $since } }, sort: [{ field: dueAt, direction: desc }] }) {
    edges { node {
      ${POST_CORE} ${POST_META}
      text externalLink metricsUpdatedAt
      metrics { type unit value }
      assets { thumbnail }
      tags { name }
    } }
    ${PAGE_INFO}
  }
}`;
