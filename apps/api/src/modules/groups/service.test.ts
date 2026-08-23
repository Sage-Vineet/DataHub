import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryGroupsRepository } from "./repository.memory.js";
import { GroupsService } from "./service.js";

/**
 * Buyer groups.
 *
 * The behaviour worth pinning is the authorization order — a caller with no
 * access to the owning company must not be able to tell a real group id from a
 * fabricated one — and the response shape, which is snake_case because the SPA
 * reads `member_count` and `member_ids` directly.
 */

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function make() {
  const repo = new InMemoryGroupsRepository();
  return { repo, service: new GroupsService({ repo }) };
}

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

describe("listing", () => {
  it("returns an empty list rather than failing when there are no groups", async () => {
    const { service } = make();
    expect(await service.list(session(), COMPANY)).toEqual([]);
  });

  it("lists a company's groups newest first, with members resolved", async () => {
    const { repo, service } = make();
    const user = session();
    const older = await service.create(user, COMPANY, { name: "Older" });
    const newer = await service.create(user, COMPANY, { name: "Newer" });
    // createdAt is generated per insert; force a deterministic order.
    repo.seed({ ...(await repo.getById(older.id))!, createdAt: "2020-01-01T00:00:00.000Z" });
    repo.seed({ ...(await repo.getById(newer.id))!, createdAt: "2030-01-01T00:00:00.000Z" });
    await repo.addMember(newer.id, "user-1");
    await repo.addMember(newer.id, "user-2");

    const list = await service.list(user, COMPANY);

    expect(list.map((g) => g.name)).toEqual(["Newer", "Older"]);
    expect(list[0]!.member_count).toBe(2);
    expect(list[0]!.member_ids.sort()).toEqual(["user-1", "user-2"]);
    // A group with no members reports zero, not undefined — the SPA renders it.
    expect(list[1]!.member_count).toBe(0);
    expect(list[1]!.member_ids).toEqual([]);
  });

  it("does not leak another company's groups", async () => {
    const { service } = make();
    await service.create(session(), COMPANY, { name: "Ours" });
    expect(await service.list(session({ company_ids: [COMPANY, OTHER] }), OTHER)).toEqual([]);
  });

  it("refuses a company the caller is not associated with", async () => {
    const { service } = make();
    await expect(service.list(session(), OTHER)).rejects.toThrow(ForbiddenError);
  });

  it("lets an admin read any company", async () => {
    const { service } = make();
    await service.create(session(), COMPANY, { name: "Ours" });
    const admin = session({ role: "admin", company_ids: [] });
    expect((await service.list(admin, COMPANY)).map((g) => g.name)).toEqual(["Ours"]);
  });
});

describe("creating", () => {
  it("returns the snake_case shape the SPA reads", async () => {
    const { service } = make();
    const created = await service.create(session(), COMPANY, { name: "Buyers", description: "core" });

    expect(created).toMatchObject({
      company_id: COMPANY,
      name: "Buyers",
      description: "core",
      member_ids: [],
      member_count: 0,
    });
    expect(created.id).toBeTruthy();
    expect(created.created_at).toBeTruthy();
  });

  it("requires a name", async () => {
    const { service } = make();
    await expect(service.create(session(), COMPANY, {})).rejects.toThrow(BadRequestError);
    // Whitespace is not a name.
    await expect(service.create(session(), COMPANY, { name: "   " })).rejects.toThrow(BadRequestError);
  });

  it("tolerates a missing body", async () => {
    const { service } = make();
    await expect(service.create(session(), COMPANY, undefined)).rejects.toThrow(BadRequestError);
  });

  it("collapses a blank description to null, so cleared and unset are one state", async () => {
    const { service } = make();
    const created = await service.create(session(), COMPANY, { name: "N", description: "  " });
    expect(created.description).toBeNull();
  });

  it("refuses a company the caller cannot access", async () => {
    const { service } = make();
    await expect(service.create(session(), OTHER, { name: "N" })).rejects.toThrow(ForbiddenError);
  });
});

describe("updating", () => {
  it("changes name and description", async () => {
    const { service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "Old", description: "was" });

    const updated = await service.update(user, group.id, { name: "New", description: "now" });

    expect(updated).toMatchObject({ id: group.id, name: "New", description: "now" });
  });

  it("keeps the member list on the updated response", async () => {
    const { repo, service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });
    await repo.addMember(group.id, "user-1");

    expect((await service.update(user, group.id, { name: "G2" })).member_count).toBe(1);
  });

  it("404s an unknown group", async () => {
    const { service } = make();
    await expect(service.update(session(), randomUUID(), { name: "N" })).rejects.toThrow(NotFoundError);
  });

  it("still requires a name", async () => {
    const { service } = make();
    const group = await service.create(session(), COMPANY, { name: "G" });
    await expect(service.update(session(), group.id, {})).rejects.toThrow(BadRequestError);
  });

  it("403s a group belonging to another company", async () => {
    const { service } = make();
    const group = await service.create(session(), COMPANY, { name: "G" });
    const outsider = session({ company_ids: [OTHER] });
    await expect(service.update(outsider, group.id, { name: "N" })).rejects.toThrow(ForbiddenError);
  });
});

describe("deleting", () => {
  it("removes the group and its memberships", async () => {
    const { repo, service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });
    await repo.addMember(group.id, "user-1");

    await service.remove(user, group.id);

    expect(await repo.getById(group.id)).toBeNull();
    expect(await repo.listMembers(group.id)).toEqual([]);
  });

  it("404s an unknown group", async () => {
    const { service } = make();
    await expect(service.remove(session(), randomUUID())).rejects.toThrow(NotFoundError);
  });

  it("403s another company's group", async () => {
    const { service } = make();
    const group = await service.create(session(), COMPANY, { name: "G" });
    await expect(service.remove(session({ company_ids: [OTHER] }), group.id)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe("membership", () => {
  it("adds, lists and removes a member", async () => {
    const { service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });

    const added = await service.addMember(user, group.id, { user_id: "user-1" });
    expect(added).toMatchObject({ group_id: group.id, user_id: "user-1" });

    expect((await service.listMembers(user, group.id)).map((m) => m.user_id)).toEqual(["user-1"]);

    await service.removeMember(user, group.id, "user-1");
    expect(await service.listMembers(user, group.id)).toEqual([]);
  });

  it("treats a repeat add as a no-op rather than an error", async () => {
    // The table's primary key is (group_id, user_id). Legacy surfaced the insert
    // conflict to the caller as a 500; adding someone twice is not a failure.
    const { service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });

    await service.addMember(user, group.id, { user_id: "user-1" });
    await service.addMember(user, group.id, { user_id: "user-1" });

    expect(await service.listMembers(user, group.id)).toHaveLength(1);
  });

  it("requires a user_id", async () => {
    const { service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });
    await expect(service.addMember(user, group.id, {})).rejects.toThrow(BadRequestError);
  });

  it("404s removing someone who is not a member", async () => {
    const { service } = make();
    const user = session();
    const group = await service.create(user, COMPANY, { name: "G" });
    await expect(service.removeMember(user, group.id, "nobody")).rejects.toThrow(NotFoundError);
  });

  it("404s membership calls against an unknown group", async () => {
    const { service } = make();
    const user = session();
    const missing = randomUUID();
    await expect(service.listMembers(user, missing)).rejects.toThrow(NotFoundError);
    await expect(service.addMember(user, missing, { user_id: "u" })).rejects.toThrow(NotFoundError);
    await expect(service.removeMember(user, missing, "u")).rejects.toThrow(NotFoundError);
  });

  it("403s membership calls on another company's group", async () => {
    const { service } = make();
    const group = await service.create(session(), COMPANY, { name: "G" });
    const outsider = session({ company_ids: [OTHER] });

    await expect(service.listMembers(outsider, group.id)).rejects.toThrow(ForbiddenError);
    await expect(service.addMember(outsider, group.id, { user_id: "u" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(service.removeMember(outsider, group.id, "u")).rejects.toThrow(ForbiddenError);
  });

  it("answers 404 before 403 for an id that does not exist", async () => {
    // Otherwise the pair of responses is an oracle: 403 would mean "this id is
    // real, just not yours", which is exactly what an outsider wants to learn.
    const { service } = make();
    await expect(
      service.listMembers(session({ company_ids: [OTHER] }), randomUUID()),
    ).rejects.toThrow(NotFoundError);
  });
});
