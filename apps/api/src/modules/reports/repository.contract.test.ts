import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { createSchemaDb, schema, type Db } from "@datahub/db";
import type { ReportsRepository } from "./ports.js";
import { DrizzleReportsRepository } from "./repository.drizzle.js";
import { InMemoryReportsRepository } from "./repository.memory.js";

/**
 * One suite, both stores.
 *
 * `InMemoryReportsRepository` exists so the service's tests need no database.
 * That only holds while it behaves like the real one, and a fake drifts
 * silently: the tests using it keep passing while the thing they stand in for
 * has changed underneath them. This session has already found two fakes that
 * had — the QuickBooks pull identity and the data room's missing `ext`.
 *
 * The rules under test are the ones a version listing depends on: numbering is
 * per company, exactly one version is active at a time, and a duplicate is a
 * DRAFT rather than a copy of an active one.
 */

const USER = randomUUID();

interface Store {
  repo: ReportsRepository;
  companyId: string;
  otherCompanyId: string;
}

const clients: PGlite[] = [];

async function drizzleStore(): Promise<Store> {
  const client = await createSchemaDb();
  clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db;

  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  await db.insert(schema.users).values({
    id: USER,
    name: "Uma",
    email: `${USER}@x.test`,
    passwordHash: "!",
    role: "broker",
  });
  await db.insert(schema.companies).values([
    { id: companyId, name: "Acme", industry: "" },
    { id: otherCompanyId, name: "Beta", industry: "" },
  ]);

  return { repo: new DrizzleReportsRepository(db), companyId, otherCompanyId };
}

function memoryStore(): Promise<Store> {
  return Promise.resolve({
    repo: new InMemoryReportsRepository(),
    companyId: randomUUID(),
    otherCompanyId: randomUUID(),
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const STORES: Array<[string, () => Promise<Store>]> = [
  ["Drizzle", drizzleStore],
  ["in memory", memoryStore],
];

describe.each(STORES)("report versions (%s)", (_name, open) => {
  const create = (repo: ReportsRepository, companyId: string, versionName: string | null = "v") =>
    repo.create({ companyId, versionName, metadata: {}, createdBy: USER });

  it("has nothing to report for a company with no versions", async () => {
    const { repo, companyId } = await open();
    expect(await repo.listByCompany(companyId)).toEqual([]);
    expect(await repo.getById(randomUUID())).toBeNull();
  });

  it("numbers versions from one, per company", async () => {
    // Per company, not globally: "version 3" on a deal means the third of that
    // deal's, and a global counter makes the number meaningless to a reader.
    const { repo, companyId, otherCompanyId } = await open();
    expect((await create(repo, companyId)).versionNumber).toBe(1);
    expect((await create(repo, companyId)).versionNumber).toBe(2);
    expect((await create(repo, otherCompanyId)).versionNumber).toBe(1);
  });

  it("creates every version inactive, including the first", async () => {
    // Activation is a decision, not a side effect of creating. The service
    // activates the first one deliberately; the store does not guess.
    const { repo, companyId } = await open();
    const first = await create(repo, companyId);
    expect(first).toMatchObject({ isActive: false, status: "draft" });
    expect((await create(repo, companyId)).isActive).toBe(false);
  });

  it("keeps exactly one version active", async () => {
    // Two active versions makes "the company's report" ambiguous, and every
    // read that asks for the active one gets whichever the query returned
    // first.
    const { repo, companyId } = await open();
    const first = await create(repo, companyId);
    const second = await create(repo, companyId);

    await repo.activate(second.id);
    const all = await repo.listByCompany(companyId);
    expect(all.filter((v) => v.isActive).map((v) => v.id)).toEqual([second.id]);
    expect(all.find((v) => v.id === first.id)?.isActive).toBe(false);
  });

  it("does not deactivate another company's version when activating one", async () => {
    // The deactivation is scoped to the company. Scoped wider it would take
    // every other deal's active version down with it.
    const { repo, companyId, otherCompanyId } = await open();
    const mine = await create(repo, companyId);
    const theirs = await create(repo, otherCompanyId);
    await repo.activate(theirs.id);

    await repo.activate(mine.id);
    expect((await repo.getById(theirs.id))?.isActive).toBe(true);
    expect((await repo.getById(mine.id))?.isActive).toBe(true);
  });

  it("answers null for activating a version nobody has", async () => {
    const { repo } = await open();
    expect(await repo.activate(randomUUID())).toBeNull();
  });

  it("updates only the fields named", async () => {
    const { repo, companyId } = await open();
    const version = await create(repo, companyId, "Before");
    const updated = await repo.update(version.id, { versionName: "After" });

    expect(updated).toMatchObject({ versionName: "After", status: "draft" });
    expect(updated?.versionNumber).toBe(version.versionNumber);
  });

  it("updates status and metadata independently of the name", async () => {
    const { repo, companyId } = await open();
    const version = await create(repo, companyId, "Keep me");
    const updated = await repo.update(version.id, {
      status: "synced",
      metadata: { note: "signed off" },
    });

    expect(updated).toMatchObject({ status: "synced", versionName: "Keep me" });
    expect(updated?.metadata).toEqual({ note: "signed off" });
  });

  it("answers null for updating a version nobody has", async () => {
    const { repo } = await open();
    expect(await repo.update(randomUUID(), { versionName: "x" })).toBeNull();
  });

  it("duplicates a version as a fresh inactive draft", async () => {
    // A duplicate that came out active would silently replace the version the
    // company is reporting from, at the moment somebody meant to experiment.
    const { repo, companyId } = await open();
    const source = await create(repo, companyId, "Q3 close");
    await repo.update(source.id, { status: "synced", metadata: { note: "kept" } });

    const copy = await repo.duplicate(source.id, USER);
    expect(copy).toMatchObject({ status: "draft", isActive: false });
    expect(copy?.id).not.toBe(source.id);
    expect(copy?.versionNumber).toBe(source.versionNumber + 1);
    expect(copy?.metadata).toEqual({ note: "kept" });
  });

  it("answers null for duplicating a version nobody has", async () => {
    const { repo } = await open();
    expect(await repo.duplicate(randomUUID(), USER)).toBeNull();
  });

  it("removes a version, and leaves the company's others alone", async () => {
    const { repo, companyId } = await open();
    const first = await create(repo, companyId);
    const second = await create(repo, companyId);

    await repo.delete(second.id);
    expect(await repo.getById(second.id)).toBeNull();
    expect((await repo.listByCompany(companyId)).map((v) => v.id)).toEqual([first.id]);
  });

  it("shrugs off deleting a version nobody has", async () => {
    const { repo } = await open();
    await expect(repo.delete(randomUUID())).resolves.toBeUndefined();
  });

  it("keeps one company's versions out of another's listing", async () => {
    const { repo, companyId, otherCompanyId } = await open();
    await create(repo, companyId);
    expect(await repo.listByCompany(otherCompanyId)).toEqual([]);
  });
});
