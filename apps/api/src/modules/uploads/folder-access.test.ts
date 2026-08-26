import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import {
  ownsTheRoom,
  resolveFolderPermissions,
  type FolderAccessGrant,
} from "./folder-access.js";

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base: SessionUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Dana Buyer",
  email: "d@x.test",
  role: "buyer",
  company_id: COMPANY,
  status: "active",
  company_ids: [COMPANY],
};
const buyer = base;
const otherBuyer: SessionUser = { ...base, id: "22222222-2222-4222-8222-222222222222" };
const broker: SessionUser = { ...base, id: "33333333-3333-4333-8333-333333333333", role: "broker" };

const PARENT = "f0000000-0000-4000-8000-00000000000a";
const CHILD = "f0000000-0000-4000-8000-00000000000b";

function grant(over: Partial<FolderAccessGrant> = {}): FolderAccessGrant {
  return {
    folderId: CHILD,
    userId: buyer.id,
    groupId: null,
    canRead: true,
    canWrite: false,
    canDownload: false,
    ...over,
  };
}

const resolve = (
  user: SessionUser,
  grants: FolderAccessGrant[],
  groupIds: string[] = [],
  ancestry: string[] = [CHILD, PARENT],
) => resolveFolderPermissions({ user, ancestry, grants, groupIds });

describe("ownsTheRoom", () => {
  it.each([["broker"], ["admin"]] as const)("%s is never gated by a grant", (role) => {
    expect(ownsTheRoom({ ...base, role })).toBe(true);
  });

  it("a buyer is", () => {
    expect(ownsTheRoom(buyer)).toBe(false);
  });
});

describe("resolveFolderPermissions", () => {
  it("leaves a folder nobody has configured unrestricted", () => {
    // The load-bearing default. Not one folder in the product carries a grant
    // today, so denying here would empty every data room on the first deploy
    // rather than tighten an existing rule.
    expect(resolve(buyer, [])).toEqual({ read: true, write: true, download: true });
  });

  it("restricts a folder the moment somebody configures it", () => {
    expect(resolve(otherBuyer, [grant()])).toEqual({
      read: false,
      write: false,
      download: false,
    });
  });

  it("grants exactly the capabilities named, and no more", () => {
    // The commercially meaningful split: read without download is a real answer,
    // and it is the one a seller reaches for on the sensitive folders.
    expect(resolve(buyer, [grant({ canRead: true, canDownload: false })])).toMatchObject({
      read: true,
      download: false,
    });
  });

  it("reaches a person through a group", () => {
    const g = "99999999-9999-4999-8999-999999999999";
    expect(
      resolve(buyer, [grant({ userId: null, groupId: g, canDownload: true })], [g]),
    ).toMatchObject({ read: true, download: true });
  });

  it("does not reach someone who is not in the group", () => {
    const g = "99999999-9999-4999-8999-999999999999";
    expect(resolve(buyer, [grant({ userId: null, groupId: g })], [])).toEqual({
      read: false,
      write: false,
      download: false,
    });
  });

  it("takes the most permissive of several grants that reach one person", () => {
    // Reached directly AND through a group. A grant adds trust; it never caps it.
    const g = "99999999-9999-4999-8999-999999999999";
    expect(
      resolve(
        buyer,
        [
          grant({ canRead: true, canWrite: false, canDownload: false }),
          grant({ userId: null, groupId: g, canRead: false, canWrite: true, canDownload: true }),
        ],
        [g],
      ),
    ).toEqual({ read: true, write: true, download: true });
  });

  describe("inheritance", () => {
    it("takes the nearest ancestor's grants when the folder has none of its own", () => {
      expect(
        resolve(buyer, [grant({ folderId: PARENT, canDownload: true })]),
      ).toMatchObject({ read: true, download: true });
    });

    it("lets a child's own grants override an ancestor's", () => {
      // Nearest-wins, not union: a parent that opened a whole branch must not
      // widen a child that was configured more narrowly.
      const grants = [
        grant({ folderId: PARENT, canRead: true, canWrite: true, canDownload: true }),
        grant({ folderId: CHILD, canRead: true, canWrite: false, canDownload: false }),
      ];
      expect(resolve(buyer, grants)).toEqual({ read: true, write: false, download: false });
    });

    it("restricts a child of a restricted parent, so a parent grant cannot be walked around", () => {
      expect(resolve(otherBuyer, [grant({ folderId: PARENT })])).toEqual({
        read: false,
        write: false,
        download: false,
      });
    });
  });

  it("never gates the deal-owning side, even on a folder they are not named in", () => {
    expect(resolve(broker, [grant({ userId: otherBuyer.id })])).toEqual({
      read: true,
      write: true,
      download: true,
    });
  });
});
