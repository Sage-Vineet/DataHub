## Context

See `proposal.md`. Legacy splits messaging across `messages.js` (company + direct), `messageGroups.js`
(groups + group messages + read tracking), on `company_messages`, `direct_messages`, `message_groups`,
`message_group_members`, `group_messages`, `group_message_reads`. We keep behavior and drop the dual path.

## Goals / Non-Goals

**Goals:** parity for company/direct/group messaging + membership + unread tracking; tenant scoping.

**Non-Goals:** auto-created groups; thread/contacts aggregations; buyer_groups.

## Decisions

### D1 — Blueprint + scoping
`modules/messages/` follows the blueprint. Company + direct conversations scope on the path
`:companyId` via `canAccessCompany`. Group access is **membership-based**: a caller must be a member
of the group (or an admin/broker on the group's company) to read/post.

### D2 — Direct conversation is symmetric
A direct conversation between A and B in a company is the union of `(sender=A,recipient=B)` and
`(sender=B,recipient=A)`, ordered by time. Sending records `(sender=viewer, recipient=other)`.

### D3 — Unread tracking via a read watermark
`group_message_reads (group_id, user_id, last_read_at)` is a per-user watermark. Mark-read upserts
`last_read_at = now()`; unread-count = group messages newer than the watermark not sent by the viewer.

### D4 — Explicit groups only
Group create/membership are explicit here (`auto_created` defaults false for module-created groups).
Auto-creation stays on legacy (non-goal).

## Risks / Trade-offs

- **Group authorization** → membership + company-role check; a non-member broker/admin on the same
  company may still manage (parity); test the allow/deny paths.
- **Unread-count semantics** → watermark-based (messages after last_read_at, excluding own); simple and
  matches the legacy intent.

## Migration Plan

1. Contracts + `packages/db` (six message tables); reconcile via `db:pull`.
2. Repository (Drizzle + in-memory): company/direct conversations, groups, membership, group messages, reads.
3. Service (scoping + membership + unread) + router; tests ≥90%.
4. Mount behind `MESSAGES_MODULE_ENABLED`; soak; delete legacy message handlers.
- **Rollback:** flag off → legacy serves the routes.

## Open Questions

- Confirm the group-authorization rule (member-only vs company-role) against prod behavior before cutover.
