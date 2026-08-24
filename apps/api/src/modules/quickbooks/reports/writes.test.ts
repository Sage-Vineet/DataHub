import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { InMemoryQuickBooksRepository } from "../repository.memory.js";
import type { MutateEntityInput, QueryEntityInput, ReportFetcher } from "./client.js";
import {
  ComplexInvoiceUpdateError,
  QuickBooksWritesService,
  faultCodes,
  toCustomerPayload,
  toInvoiceFields,
} from "./writes.js";

/**
 * The two things this product writes into a company's own accounting system.
 *
 * Both are narrow on purpose. A customer is five fields; an invoice may only
 * have its number, due date and private note changed, because a partial write
 * to an invoice is a book somebody has to unpick by hand.
 */

const COMPANY = randomUUID();
const OTHER = randomUUID();
const REALM = "4620816365000000000";

const USER: SessionUser = {
  id: randomUUID(),
  name: "Uma",
  email: "uma@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
};

const INVOICE = { Id: "42", SyncToken: "3", DocNumber: "INV-1" };

function fetcher(
  over: {
    invoice?: Record<string, unknown> | null;
    answer?: Record<string, unknown> | Error;
    canWrite?: boolean;
  } = {},
): ReportFetcher & { writes: MutateEntityInput[]; queries: QueryEntityInput[] } {
  const writes: MutateEntityInput[] = [];
  const queries: QueryEntityInput[] = [];
  const base = {
    writes,
    queries,
    fetchReport: () => Promise.reject(new Error("not used")),
    queryEntity: (input: QueryEntityInput) => {
      queries.push(input);
      const invoice = over.invoice === undefined ? INVOICE : over.invoice;
      return Promise.resolve({
        payload: { QueryResponse: invoice === null ? {} : { Invoice: [invoice] } },
        params: {},
      });
    },
  };
  if (over.canWrite === false) return base as unknown as ReportFetcher & typeof base;

  return {
    ...base,
    mutateEntity: (input: MutateEntityInput) => {
      writes.push(input);
      if (over.answer instanceof Error) return Promise.reject(over.answer);
      return Promise.resolve({
        payload: over.answer ?? { Customer: { Id: "7" }, Invoice: { Id: "42", DocNumber: "INV-9" } },
        params: {},
      });
    },
  } as unknown as ReportFetcher & typeof base;
}

async function build(over: Parameters<typeof fetcher>[0] = {}) {
  const connections = new InMemoryQuickBooksRepository();
  await connections.save({
    companyId: COMPANY,
    realmId: REALM,
    realmCompanyName: "Acme Books",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    environment: "production",
    oauthClientId: "client",
    redirectUri: "https://example.test/cb",
    connectedBy: USER.id,
  });
  const fake = fetcher(over);
  return {
    connections,
    fetcher: fake,
    service: new QuickBooksWritesService({ connections, fetcher: fake }),
  };
}

describe("building a customer for Intuit", () => {
  it("reads the page's field names and Intuit's alike", () => {
    // The page sends `name`/`email`; an older client sends `DisplayName` and
    // `PrimaryEmailAddr`. Reading one silently creates a customer with no
    // contact details.
    expect(toCustomerPayload({ name: "Acme Ltd", email: "a@b.test" })).toEqual({
      DisplayName: "Acme Ltd",
      PrimaryEmailAddr: { Address: "a@b.test" },
    });
    expect(
      toCustomerPayload({ DisplayName: "Acme Ltd", PrimaryEmailAddr: { Address: "a@b.test" } }),
    ).toEqual({ DisplayName: "Acme Ltd", PrimaryEmailAddr: { Address: "a@b.test" } });
  });

  it("carries a phone, an address and notes when they are given", () => {
    expect(
      toCustomerPayload({
        name: "Acme",
        phone: "+44 20 7946 0000",
        address: "1 High Street",
        notes: "Introduced by Kestrel.",
      }),
    ).toMatchObject({
      PrimaryPhone: { FreeFormNumber: "+44 20 7946 0000" },
      BillAddr: { Line1: "1 High Street" },
      Notes: "Introduced by Kestrel.",
    });
  });

  it("leaves an empty field out rather than sending a blank one", () => {
    // Intuit stores what it is sent. A blank email overwrites a real one on a
    // later update and reads as a customer who has no address.
    expect(toCustomerPayload({ name: "Acme", email: "  ", phone: "" })).toEqual({
      DisplayName: "Acme",
    });
  });

  it("refuses a customer with no name", () => {
    // The display name IS the customer in QuickBooks; there is nothing to
    // create without it.
    expect(() => toCustomerPayload({ email: "a@b.test" })).toThrow(/name is required/i);
    expect(() => toCustomerPayload({ name: "   " })).toThrow(/name is required/i);
  });
});

describe("reading Intuit's fault codes", () => {
  it("reads the code off the fault", () => {
    expect(faultCodes({ Fault: { Error: [{ code: "6240", Message: "Duplicate Name" }] } })).toEqual([
      "6240",
    ]);
  });

  it("does not find a code in an unrelated number", () => {
    // The version this replaces searched the WHOLE response for "6240", so an
    // invoice numbered 6240, an amount of 6240.00 or an id containing those
    // digits reported an unrelated failure as "that name is taken".
    expect(faultCodes({ Invoice: { Id: "6240", TotalAmt: 6240 } })).toEqual([]);
    expect(faultCodes({ Fault: { Error: "not a list" } })).toEqual([]);
    expect(faultCodes(null)).toEqual([]);
  });
});

describe("creating a customer", () => {
  it("sends it and answers with what Intuit created", async () => {
    const { service, fetcher: fake } = await build();
    const result = await service.createCustomer(USER, COMPANY, { name: "Acme Ltd" });

    expect(result.customer).toEqual({ Id: "7" });
    expect(fake.writes[0]).toMatchObject({
      realmId: REALM,
      entityType: "customers",
      payload: { DisplayName: "Acme Ltd" },
    });
  });

  it("names a duplicate for what it is", async () => {
    // Intuit answers 200 with a Fault for this one rather than a 4xx, so the
    // fault has to be read off a successful response.
    const { service } = await build({
      answer: { Fault: { Error: [{ code: "6240", Message: "Duplicate Name Exists Error" }] } },
    });
    await expect(service.createCustomer(USER, COMPANY, { name: "Acme" })).rejects.toThrow(
      /already exists/i,
    );
  });

  it("says so plainly for a refusal that is not a duplicate", async () => {
    const { service } = await build({ answer: { Fault: { Error: [{ code: "2010" }] } } });
    await expect(service.createCustomer(USER, COMPANY, { name: "Acme" })).rejects.toThrow(
      /did not create/i,
    );
  });

  it("refuses a company the caller cannot reach, and one named nowhere", async () => {
    const { service } = await build();
    await expect(service.createCustomer(USER, OTHER, { name: "A" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(service.createCustomer(USER, "", { name: "A" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("says the connection is missing rather than writing nowhere", async () => {
    const { service, connections } = await build();
    await connections.disconnect(COMPANY);
    await expect(service.createCustomer(USER, COMPANY, { name: "A" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("what an invoice update may carry", () => {
  it("takes the three fields it is allowed to change", () => {
    expect(
      toInvoiceFields({ invoiceNumber: 991, dueDate: "2026-03-31", note: "Chased twice." }),
    ).toEqual({ DocNumber: "991", DueDate: "2026-03-31", PrivateNote: "Chased twice." });
  });

  it("leaves an absent field alone rather than clearing it", () => {
    // An empty note is what a cleared form field sends, and wiping somebody's
    // QuickBooks note because their form was blank is a worse failure than
    // being unable to clear it from here.
    expect(toInvoiceFields({ note: "" })).toEqual({});
    expect(toInvoiceFields({})).toEqual({});
  });
});

describe("updating an invoice", () => {
  it("reads the invoice first, for its sync token", async () => {
    // Intuit's optimistic concurrency needs the CURRENT token: a write with a
    // stale one is refused, which is the point — it means somebody edited the
    // invoice in QuickBooks since this page loaded it.
    const { service, fetcher: fake } = await build();
    await service.updateInvoice(USER, COMPANY, "42", { invoiceNumber: "INV-9" });

    expect(fake.queries[0]?.entityType).toBe("invoices");
    expect(fake.writes[0]?.payload).toMatchObject({
      Id: "42",
      SyncToken: "3",
      sparse: true,
      DocNumber: "INV-9",
    });
  });

  it("refuses to restructure an invoice, and says where it can be done", async () => {
    // A partial write to an invoice is a book somebody has to unpick by hand.
    const { service, fetcher: fake } = await build();
    for (const patch of [
      { amount: 100 },
      { balance: 0 },
      { status: "paid" },
      { date: "2026-01-01" },
      { lineItems: [] },
      { Line: [] },
      { customer: "Acme Ltd" },
    ]) {
      await expect(service.updateInvoice(USER, COMPANY, "42", patch)).rejects.toBeInstanceOf(
        ComplexInvoiceUpdateError,
      );
    }
    expect(fake.writes).toEqual([]);
  });

  it("refuses before it even looks the company up", async () => {
    // The answer does not depend on the company, and somebody trying to
    // restructure an invoice should be told so whether or not QuickBooks is
    // connected.
    const { service, connections, fetcher: fake } = await build();
    await connections.disconnect(COMPANY);
    await expect(
      service.updateInvoice(USER, COMPANY, "42", { amount: 100 }),
    ).rejects.toBeInstanceOf(ComplexInvoiceUpdateError);
    expect(fake.queries).toEqual([]);
  });

  it("answers the invoice unchanged when there is nothing to write", async () => {
    // A sparse update with no fields is a validation fault at Intuit, which
    // reads to the caller as a failure they caused.
    const { service, fetcher: fake } = await build();
    const result = await service.updateInvoice(USER, COMPANY, "42", { note: "" });

    expect(result.changed).toBe(false);
    expect(result.invoice).toEqual(INVOICE);
    expect(fake.writes).toEqual([]);
  });

  it("404s an invoice this company does not have", async () => {
    const { service } = await build({ invoice: null });
    await expect(
      service.updateInvoice(USER, COMPANY, "999", { note: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses a request naming no invoice", async () => {
    const { service } = await build();
    await expect(service.updateInvoice(USER, COMPANY, "", { note: "x" })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });

  it("says so when Intuit answers without the invoice", async () => {
    const { service } = await build({ answer: { Fault: { Error: [{ code: "5010" }] } } });
    await expect(
      service.updateInvoice(USER, COMPANY, "42", { note: "x" }),
    ).rejects.toThrow(/did not apply/i);
  });
});

describe("a deployment whose client cannot write", () => {
  it("says so rather than failing obscurely", async () => {
    // `mutateEntity` is optional on the port: every read path works without
    // it, and a client that cannot write should not have to pretend it can.
    const { service } = await build({ canWrite: false });
    await expect(service.createCustomer(USER, COMPANY, { name: "A" })).rejects.toThrow(
      /cannot write/i,
    );
  });
});
