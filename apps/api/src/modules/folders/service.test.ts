import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { folders as contracts, type SessionUser } from "@datahub/contracts";
import { ForbiddenError, HttpError } from "../../shared/errors.js";
import { EXPECTED_FOLDER_COUNT } from "./hierarchy.js";
import { InMemoryFoldersRepository } from "./repository.memory.js";
import { FoldersService } from "./service.js";
import type { FileLinkPort, FolderRecord, GroupRefPort } from "./ports.js";

class FakeFileLink implements FileLinkPort {
  linked = new Set<string>();
  async assertFolderDeletable(folderId: string) {
    if (this.linked.has(folderId)) throw new HttpError(409, "linked");
  }
}
class FakeGroups implements GroupRefPort {
  known = new Set<string>();
  async exists(groupId: string) {
    return this.known.has(groupId);
  }
}

function makeService() {
  const repo = new InMemoryFoldersRepository();
  const fileLink = new FakeFileLink();
  const groups = new FakeGroups();
  return { repo, fileLink, groups, service: new FoldersService({ repo, fileLink, groups }) };
}

const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@example.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

function seedFolder(repo: InMemoryFoldersRepository, over: Partial<FolderRecord> = {}): FolderRecord {
  return repo.seed({
    id: randomUUID(),
    companyId: COMPANY,
    parentId: null,
    name: "F",
    color: null,
    createdBy: randomUUID(),
    archivedAt: null,
    ...over,
  });
}

describe("FoldersService — tree, archive filter, tenant guard", () => {
  it("builds a parent/child tree and filters archived", async () => {
    const { repo, service } = makeService();
    const root = seedFolder(repo, { name: "Root" });
    seedFolder(repo, { name: "Child", parentId: root.id });
    seedFolder(repo, { name: "Old", archivedAt: new Date(0).toISOString() });

    const tree = await service.tree(session(), COMPANY, false);
    expect(tree).toHaveLength(1); // only the live root
    expect(tree[0]!.children.map((c) => c.name)).toEqual(["Child"]);

    const withArchived = await service.list(session(), COMPANY, true);
    expect(withArchived.map((f) => f.name).sort()).toEqual(["Child", "Old", "Root"]);
  });

  it("denies a user who cannot access the company", async () => {
    const { service } = makeService();
    await expect(
      service.list(session({ role: "buyer", company_ids: [OTHER] }), COMPANY, false),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("FoldersService — create / update / move / archive", () => {
  it("creates (nested), updates, moves, archives and restores", async () => {
    const { repo, service } = makeService();
    const parent = await service.create(session(), COMPANY, contracts.folderCreate.parse({ name: "Parent" }));
    const child = await service.create(session(), COMPANY, contracts.folderCreate.parse({ name: "Child", parent_id: parent.id }));
    expect(child.parent_id).toBe(parent.id);
    expect(child.created_by).toBeTruthy();

    const renamed = await service.update(session(), child.id, contracts.folderUpdate.parse({ name: "Renamed" }));
    expect(renamed.name).toBe("Renamed");

    const moved = await service.move(session(), child.id, null);
    expect(moved.parent_id).toBeNull();

    const archived = await service.archive(session(), child.id);
    expect(archived.archived_at).not.toBeNull();
    const restored = await service.unarchive(session(), child.id);
    expect(restored.archived_at).toBeNull();
    void repo;
  });
});

describe("FoldersService — protected delete (D3)", () => {
  it("rejects a linked folder with 409 and deletes an unlinked one", async () => {
    const { repo, fileLink, service } = makeService();
    const linked = seedFolder(repo, { name: "Linked" });
    const free = seedFolder(repo, { name: "Free" });
    fileLink.linked.add(linked.id);

    await expect(service.delete(session(), linked.id)).rejects.toMatchObject({ status: 409 });
    expect(await repo.getById(linked.id)).not.toBeNull(); // untouched

    await service.delete(session(), free.id);
    expect(await repo.getById(free.id)).toBeNull();
  });
});

describe("FoldersService — idempotent provisioning (D2)", () => {
  it("creates the standard set and makes no duplicates when run twice", async () => {
    const { repo, service } = makeService();
    await service.ensureDefaultFolders(COMPANY, randomUUID());
    await service.ensureDefaultFolders(COMPANY, randomUUID());
    expect(await repo.countByCompany(COMPANY)).toBe(EXPECTED_FOLDER_COUNT);
    expect(await service.needsProvisioning(COMPANY)).toBe(false);
  });
});

describe("FoldersService — access grants (D4)", () => {
  it("lets a broker grant to a user, validates group existence, and blocks non-privileged", async () => {
    const { repo, groups, service } = makeService();
    const folder = seedFolder(repo);
    const broker = session({ role: "broker" });

    const grant = await service.createAccess(broker, folder.id, contracts.folderAccessCreate.parse({ user_id: randomUUID(), can_write: true }));
    expect(grant.can_read).toBe(true);
    expect(grant.can_write).toBe(true);

    // Unknown group rejected; known group accepted.
    const groupId = randomUUID();
    await expect(
      service.createAccess(broker, folder.id, contracts.folderAccessCreate.parse({ group_id: groupId })),
    ).rejects.toMatchObject({ status: 400 });
    groups.known.add(groupId);
    const groupGrant = await service.createAccess(broker, folder.id, contracts.folderAccessCreate.parse({ group_id: groupId }));
    expect(groupGrant.group_id).toBe(groupId);

    // A client/buyer cannot manage access.
    const client = session({ role: "buyer", company_ids: [COMPANY] });
    await expect(
      service.createAccess(client, folder.id, contracts.folderAccessCreate.parse({ user_id: randomUUID() })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("updates and deletes a grant (broker/admin only)", async () => {
    const { repo, service } = makeService();
    const folder = seedFolder(repo);
    const broker = session({ role: "broker" });
    const grant = await service.createAccess(broker, folder.id, contracts.folderAccessCreate.parse({ user_id: randomUUID() }));

    const updated = await service.updateAccess(broker, grant.id, contracts.folderAccessUpdate.parse({ can_download: true }));
    expect(updated.can_download).toBe(true);

    await service.deleteAccess(broker, grant.id);
    expect(await repo.getAccessById(grant.id)).toBeNull();
  });
});
