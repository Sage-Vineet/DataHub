## Why

`messages` is the in-app communication domain: per-company conversations, 1:1 direct messages, and
topic message-groups with membership and unread tracking. It rounds out the `uploads/requests/
messages` cutover band and consolidates the messaging rules in one typed place.

**Cutover-order domain:** `messages` (per `docs/MODERNIZATION_PLAN.md` §5).

## What Changes

- **`packages/contracts`** — zod schemas for sending a message (company/direct/group), group create,
  group membership, and the message/group responses.
- **`packages/db`** — model `company_messages`, `direct_messages`, `message_groups`,
  `message_group_members`, `group_messages`, `group_message_reads`.
- **`apps/api/src/modules/messages`** — router + service + repository (Drizzle + in-memory) +
  contract + tests. Ports: company conversation list/send, direct conversation list/send, group
  list (per-company + per-user), group create, membership add/remove/list, group message list/send,
  mark-read, and unread-count.
- **Cross-domain via ports** — none new; company scoping reuses `canAccessCompany`; group access is
  membership-based.
- **Gateway cutover** — flip the message routes behind `MESSAGES_MODULE_ENABLED`.

## Capabilities

### New Capabilities
- `messages`: in-app messaging as observable behavior — tenant-scoped company conversations, 1:1
  direct messages, and membership-scoped message-groups with unread tracking.

## Impact

- **New code:** `packages/contracts` (message schemas), `packages/db` (six message tables),
  `apps/api/src/modules/messages/*`, gateway routing entry.
- **Data:** same Postgres via Drizzle — no migration.
- **Runtime behavior:** unchanged message contracts; the dual path is dropped.
- **Branch:** `ba/rearch`; `main` frozen. Legacy message handlers retired after a green soak.

## Non-goals

- **Auto-creation of deal-team/broker-client groups** — the heuristic stays on legacy for now; this
  module manages explicit groups + membership + messaging.
- **Thread/contacts aggregations** (`/messages/threads`, `/my-direct-contacts`) — deferred; the core
  conversation + group endpoints migrate first.
- **buyer_groups** management — a separate concern.
- No frontend changes.
