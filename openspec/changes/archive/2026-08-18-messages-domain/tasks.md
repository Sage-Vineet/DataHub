## 1. Contracts
- [x] 1.1 zod schemas: messageSend (body), directMessageSend, groupCreate, groupMemberAdd, group message send; message/group responses
- [x] 1.2 Contract tests

## 2. Data layer
- [x] 2.1 Model `company_messages`, `direct_messages`, `message_groups`, `message_group_members`, `group_messages`, `group_message_reads`
- [x] 2.2 Schema test asserts the columns

## 3. Repository (Drizzle + in-memory)
- [x] 3.1 company: listConversation, send
- [x] 3.2 direct: listConversation (symmetric), send
- [x] 3.3 groups: listByCompany, listForUser, create, addMember, removeMember, listMembers, isMember
- [x] 3.4 group messages: list, send; reads: markRead (upsert), unreadCount
- [x] 3.5 In-memory adapter mirrors it all

## 4. Service
- [x] 4.1 Company/direct scoping via `canAccessCompany`; group access via membership (+ company role)
- [x] 4.2 Direct conversation is symmetric (D2); unread via watermark (D3)
- [x] 4.3 All send/list/membership operations

## 5. Router
- [x] 5.1 Company + direct + group endpoints (list/send/members/read/unread)
- [x] 5.2 helmet + pino scoped; shared `requireAuth`

## 6. Tests (≥90% on the module)
- [x] 6.1 Company conversation list/send; tenant denial
- [x] 6.2 Direct conversation symmetric list/send
- [x] 6.3 Group create/membership; member-only read/post; unread-count via watermark — real Postgres
- [x] 6.4 400 on malformed send

## 7. Gateway cutover
- [x] 7.1 Mount behind `MESSAGES_MODULE_ENABLED` (off → legacy); document the flag

## 8. Cutover & retire
- [~] 8.1 Enable in staging; parity checklist — deferred (needs a real env)
- [~] 8.2 Delete legacy message handlers after a green soak — deferred

## 9. Wrap up
- [x] 9.1 `openspec validate messages-domain --strict` passes
- [x] 9.2 typecheck + lint + test green; module coverage ≥90%
- [x] 9.3 `main` untouched; Conventional Commits; update `docs/REARCH_LOG.md`
