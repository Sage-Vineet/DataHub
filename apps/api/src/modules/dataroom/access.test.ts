import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { effectivePermissions, type FolderGrant } from "./access.js";

const buyer: SessionUser = {
  id: "u-1",
  name: "Buyer",
  email: "b@x.test",
  role: "buyer",
  company_id: "c-1",
  status: "active",
  company_ids: ["c-1"],
};
const broker: SessionUser = { ...buyer, id: "u-2", role: "broker" };

const grant = (over: Partial<FolderGrant> = {}): FolderGrant => ({
  folderId: "f-1",
  userId: "u-1",
  groupId: null,
  canRead: true,
  canWrite: false,
  canDownload: false,
  ...over,
});

describe("effectivePermissions", () => {
  it("gives the deal team everything within a company they can reach", () => {
    // Legacy treats broker and admin as unscoped inside a company, and the SPA
    // renders them that way. Tightening it here would make the deal team's own
    // view go dark, which reads as broken rather than as secure.
    expect(effectivePermissions({ user: broker, folderGrants: [] })).toEqual({
      read: true,
      write: true,
      download: true,
    });
  });

  it("honours a direct grant", () => {
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [grant({ canRead: true, canDownload: true })],
      }),
    ).toEqual({ read: true, write: false, download: true });
  });

  it("unions several grants rather than taking the last", () => {
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [
          grant({ canRead: true, canWrite: false, canDownload: false }),
          grant({ canRead: false, canWrite: true, canDownload: true }),
        ],
      }),
    ).toEqual({ read: true, write: true, download: true });
  });

  it("ignores a grant naming somebody else", () => {
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [grant({ userId: "someone-else" })],
      }),
    ).toEqual({ read: false, write: false, download: false });
  });

  it("honours a grant through a group the user belongs to", () => {
    expect(
      effectivePermissions({
        user: buyer,
        groupIds: ["g-1"],
        folderGrants: [grant({ userId: null, groupId: "g-1", canDownload: true })],
      }),
    ).toMatchObject({ read: true, download: true });
  });

  it("inherits the nearest ancestor's grants when a folder has none", () => {
    // Without inheritance, granting access to a parent grants nothing usable,
    // because its children carry no rows of their own.
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [],
        ancestorGrants: [[grant({ folderId: "parent", canRead: true, canDownload: true })]],
      }),
    ).toMatchObject({ read: true, download: true });
  });

  it("takes the nearest ancestor that has any grant, not the broadest", () => {
    // A specific grant on a subfolder must not be silently widened by a looser
    // one further up the tree.
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [],
        ancestorGrants: [
          [grant({ folderId: "near", canRead: true, canWrite: false })],
          [grant({ folderId: "far", canRead: true, canWrite: true })],
        ],
      }),
    ).toMatchObject({ write: false });
  });

  it("skips an empty ancestor and keeps looking upward", () => {
    expect(
      effectivePermissions({
        user: buyer,
        folderGrants: [],
        ancestorGrants: [[], [grant({ folderId: "far", canRead: true, canDownload: true })]],
      }),
    ).toMatchObject({ read: true, download: true });
  });

  it("falls back to company-wide read where nothing is granted anywhere", () => {
    // Grants narrow; they do not open. Defaulting to "no access" would lock
    // people out of folders they have been using since before grants existed.
    expect(
      effectivePermissions({ user: buyer, folderGrants: [], ancestorGrants: [[], []] }),
    ).toEqual({ read: true, write: false, download: true });
  });
});
