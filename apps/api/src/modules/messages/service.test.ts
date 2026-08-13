import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { messages as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError } from "../../shared/errors.js";
import { InMemoryMessagesRepository } from "./repository.memory.js";
import { MessagesService } from "./service.js";

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryMessagesRepository();
  return { repo, service: new MessagesService({ repo }) };
}
const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(), name: "U", email: "u@x.com", role: "broker", company_id: null, status: "active", company_ids: [COMPANY], ...over,
});

describe("MessagesService — company + direct", () => {
  it("posts/reads a company conversation and denies cross-tenant", async () => {
    const { service } = make();
    const user = session();
    await service.companySend(user, COMPANY, "hello team");
    expect((await service.companyList(user, COMPANY)).map((m) => m.body)).toEqual(["hello team"]);
    await expect(service.companyList(session({ role: "buyer", company_ids: [OTHER] }), COMPANY)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("direct conversation is symmetric", async () => {
    const { service } = make();
    const a = session();
    const b = session();
    await service.directSend(a, COMPANY, b.id, "hi B");
    await service.directSend(b, COMPANY, a.id, "hi A");
    const asA = await service.directList(a, COMPANY, b.id);
    const asB = await service.directList(b, COMPANY, a.id);
    expect(asA.map((m) => m.body)).toEqual(["hi B", "hi A"]);
    expect(asB.map((m) => m.body)).toEqual(["hi B", "hi A"]);
  });
});

describe("MessagesService — groups", () => {
  it("creates a group (creator is a member), manages membership, and restricts to members", async () => {
    const { service } = make();
    const broker = session();
    const group = await service.createGroup(broker, COMPANY, contracts.groupCreate.parse({ name: "Deal Team", group_type: "deal_team" }));
    expect(group.auto_created).toBe(false);
    expect(await service.listMembers(broker, group.id)).toContain(broker.id);

    // A non-member client cannot read the group.
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    await expect(service.groupMessages(client, group.id)).rejects.toBeInstanceOf(ForbiddenError);

    // Add the client → now a member → can read/post.
    await service.addMember(broker, group.id, client.id);
    await service.sendGroupMessage(client, group.id, "hi from client");
    expect((await service.groupMessages(client, group.id)).length).toBe(1);

    // A client cannot create a group.
    await expect(service.createGroup(client, COMPANY, contracts.groupCreate.parse({ name: "x", group_type: "deal_team" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("unread-count follows the read watermark", async () => {
    const { service } = make();
    const a = session();
    const b = session();
    const group = await service.createGroup(a, COMPANY, contracts.groupCreate.parse({ name: "G", group_type: "broker_internal", member_ids: [b.id] }));

    await service.sendGroupMessage(a, group.id, "m1");
    await service.sendGroupMessage(a, group.id, "m2");
    expect((await service.unreadCount(b, group.id)).unread).toBe(2); // b hasn't read, and didn't send them
    expect((await service.unreadCount(a, group.id)).unread).toBe(0); // a sent them → not unread for a

    await service.markRead(b, group.id);
    expect((await service.unreadCount(b, group.id)).unread).toBe(0);

    await service.sendGroupMessage(a, group.id, "m3");
    expect((await service.unreadCount(b, group.id)).unread).toBe(1);
  });
});
