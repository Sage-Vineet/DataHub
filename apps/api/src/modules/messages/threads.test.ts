import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { InMemoryMessagesRepository } from "./repository.memory.js";
import { MessagesService } from "./service.js";

/**
 * The two cross-company views: the thread rail and "people I can message".
 *
 * They look alike and are scoped differently on purpose — an admin sees every
 * company's thread but only their own companies' contacts. That asymmetry is
 * the thing most likely to be "tidied up" by someone who assumes it is a bug,
 * so it is asserted directly.
 */

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "U",
  email: "u@x.com",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [A],
  ...over,
});

function make() {
  const repo = new InMemoryMessagesRepository();
  repo.seedThreadCompany({
    id: A,
    name: "Acme",
    industry: "Manufacturing",
    logo: null,
    contactName: null,
    contactEmail: null,
    status: "active",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  repo.seedThreadCompany({
    id: B,
    name: "Bravo",
    industry: "Retail",
    logo: null,
    contactName: null,
    contactEmail: null,
    status: "active",
    createdAt: "2021-01-01T00:00:00.000Z",
  });
  return { repo, service: new MessagesService({ repo }) };
}

describe("the thread rail", () => {
  it("returns one row per accessible company, with the industry the rail renders", async () => {
    const { service } = make();
    const threads = await service.threads(session());

    expect(threads).toHaveLength(1);
    expect(threads[0]!.company).toMatchObject({ id: A, name: "Acme", industry: "Manufacturing" });
    expect(threads[0]!.last_message).toBeNull();
  });

  it("shows an admin every company", async () => {
    const { service } = make();
    const threads = await service.threads(session({ role: "admin", company_ids: [] }));
    expect(threads.map((t) => t.company.id).sort()).toEqual([A, B].sort());
  });

  it("returns nothing when the user belongs to no company", async () => {
    const { service } = make();
    expect(await service.threads(session({ company_ids: [] }))).toEqual([]);
  });

  it("carries the most recent message per company", async () => {
    const { service } = make();
    const user = session({ company_ids: [A] });
    await service.companySend(user, A, "first");
    await service.companySend(user, A, "second");

    const threads = await service.threads(user);
    expect(threads[0]!.last_message?.body).toBe("second");
  });

  it("orders by last activity, newest first", async () => {
    const { service } = make();
    const user = session({ role: "admin", company_ids: [] });
    // Bravo gets the only message, so it must outrank Acme despite the name.
    await service.companySend(session({ company_ids: [B] }), B, "hello");

    const threads = await service.threads(user);
    expect(threads.map((t) => t.company.name)).toEqual(["Bravo", "Acme"]);
  });

  it("falls back to the company's own age when nobody has messaged it", async () => {
    // Otherwise an untouched deal drifts to the bottom in arbitrary order and
    // its position changes between reloads.
    const { service } = make();
    const threads = await service.threads(session({ role: "admin", company_ids: [] }));
    expect(threads.map((t) => t.company.name)).toEqual(["Bravo", "Acme"]);
  });
});

describe("my direct contacts", () => {
  it("returns one entry per company the user belongs to", async () => {
    const { repo, service } = make();
    repo.seedCompany({ id: A, name: "Acme" }, [
      { id: "peer-1", name: "Peer", email: "p@x.com", role: "broker" },
    ]);

    const entries = await service.myDirectContacts(session({ company_ids: [A] }));

    expect(entries).toHaveLength(1);
    expect(entries[0]!.company.id).toBe(A);
    expect(entries[0]!.contacts.map((c) => c.id)).toEqual(["peer-1"]);
  });

  it("scopes an admin to their own companies, unlike the thread rail", async () => {
    // The asymmetry is deliberate: a thread rail is an overview, this list is
    // "people I can message", and every user in the system is not that.
    const { service } = make();
    expect(await service.myDirectContacts(session({ role: "admin", company_ids: [] }))).toEqual([]);
  });

  it("skips a company it cannot resolve rather than failing the whole list", async () => {
    // One bad membership row must not empty someone's contact list.
    const { repo, service } = make();
    repo.seedCompany({ id: A, name: "Acme" }, []);
    const missing = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const entries = await service.myDirectContacts(session({ company_ids: [A, missing] }));

    expect(entries.map((e) => e.company.id)).toEqual([A]);
  });

  it("returns nothing for a user with no companies", async () => {
    const { service } = make();
    expect(await service.myDirectContacts(session({ company_ids: [] }))).toEqual([]);
  });
});
