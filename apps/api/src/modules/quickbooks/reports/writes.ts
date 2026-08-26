import type { SessionUser } from "@datahub/contracts";
import { canAccessCompany } from "../../../shared/access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import type { QuickBooksRepository } from "../ports.js";
import { escapeQueryLiteral, type ReportFetcher } from "./client.js";

/**
 * The two things this product writes back to QuickBooks.
 *
 * Everything else in the module reads. These two put data into a company's own
 * accounting system, which is why they are narrow on purpose: a customer is
 * created from five fields, and an invoice may only have its number, due date
 * and private note changed. Anything structural — amounts, lines, status,
 * dates — is refused and the user is sent to QuickBooks itself, because a
 * partial write to an invoice is a book somebody has to unpick by hand.
 */

/** Fields whose presence means the caller is trying to restructure an invoice. */
export const BLOCKED_INVOICE_FIELDS = [
  "amount",
  "balance",
  "status",
  "date",
  "lineItems",
  "Line",
] as const;

export interface CustomerInput {
  name?: unknown;
  DisplayName?: unknown;
  email?: unknown;
  PrimaryEmailAddr?: { Address?: unknown };
  phone?: unknown;
  PrimaryPhone?: { FreeFormNumber?: unknown };
  address?: unknown;
  BillAddr?: { Line1?: unknown };
  notes?: unknown;
  Notes?: unknown;
}

/** A field the caller may have sent under either its own name or Intuit's. */
const either = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text !== "") return text;
  }
  return undefined;
};

/**
 * A customer, as Intuit's schema names it.
 *
 * The page sends `name`/`email`/`phone`; an older client sends Intuit's own
 * `DisplayName`/`PrimaryEmailAddr`. Both arrive, so both are read — reading
 * one silently creates a customer with no contact details.
 */
export function toCustomerPayload(input: CustomerInput): Record<string, unknown> {
  const name = either(input.name, input.DisplayName);
  if (!name) throw new BadRequestError("Client name is required.");

  const email = either(input.email, input.PrimaryEmailAddr?.Address);
  const phone = either(input.phone, input.PrimaryPhone?.FreeFormNumber);
  const address = either(input.address, input.BillAddr?.Line1);
  const notes = either(input.notes, input.Notes);

  return {
    DisplayName: name,
    ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(phone ? { PrimaryPhone: { FreeFormNumber: phone } } : {}),
    ...(address ? { BillAddr: { Line1: address } } : {}),
    ...(notes ? { Notes: notes } : {}),
  };
}

/**
 * Which Intuit fault this is, if it is one.
 *
 * Read off the fault rather than searched for in the whole response. The
 * version this replaces did `JSON.stringify(error).includes("6240")`, which
 * matches a customer id, an amount, a date — anything at all containing those
 * four digits — and reported an unrelated failure as "that name is taken".
 */
export function faultCodes(payload: unknown): string[] {
  const fault = (payload as { Fault?: { Error?: unknown } } | null)?.Fault?.Error;
  if (!Array.isArray(fault)) return [];
  return fault
    .map((entry) => String((entry as { code?: unknown })?.code ?? "").trim())
    .filter((code) => code !== "");
}

/** Intuit's code for "an object with that name already exists". */
export const DUPLICATE_NAME_CODE = "6240";

export interface InvoicePatch {
  invoiceNumber?: unknown;
  dueDate?: unknown;
  note?: unknown;
}

export interface QuickBooksWritesDeps {
  connections: QuickBooksRepository;
  fetcher: ReportFetcher;
}

export class QuickBooksWritesService {
  constructor(private readonly deps: QuickBooksWritesDeps) {}

  private async connection(
    user: SessionUser,
    companyId: string,
  ): Promise<{ realmId: string; accessToken: string }> {
    if (!companyId) throw new BadRequestError("Missing clientId.");
    if (!canAccessCompany(user, companyId)) throw new ForbiddenError("Access denied");

    const connection = await this.deps.connections.get(companyId);
    if (!connection?.isConnected) {
      throw new NotFoundError("QuickBooks is not connected for this company.");
    }
    const tokens = await this.deps.connections.tokens(companyId);
    if (!tokens?.accessToken) {
      throw new NotFoundError("QuickBooks is not connected for this company.");
    }
    return { realmId: connection.realmId, accessToken: tokens.accessToken };
  }

  private mutate(): NonNullable<ReportFetcher["mutateEntity"]> {
    const mutate = this.deps.fetcher.mutateEntity;
    if (!mutate) {
      throw new BadRequestError("This deployment cannot write to QuickBooks.");
    }
    return mutate.bind(this.deps.fetcher);
  }

  /** Create a customer in the company's QuickBooks. */
  async createCustomer(
    user: SessionUser,
    companyId: string,
    input: CustomerInput,
  ): Promise<{ customer: Record<string, unknown> }> {
    const { realmId, accessToken } = await this.connection(user, companyId);
    const payload = toCustomerPayload(input);

    const answered = await this.mutate()({
      realmId,
      accessToken,
      entityType: "customers",
      payload,
    });

    const customer = answered.payload.Customer;
    if (customer === undefined || customer === null) {
      // Intuit answers 200 with a Fault for some refusals rather than a 4xx.
      const codes = faultCodes(answered.payload);
      throw new BadRequestError(
        codes.includes(DUPLICATE_NAME_CODE)
          ? "A client with that name already exists in QuickBooks."
          : "QuickBooks did not create the customer.",
      );
    }
    return { customer: customer as Record<string, unknown> };
  }

  /**
   * Change an invoice's number, due date or private note. Nothing else.
   *
   * Read-then-write, because Intuit's optimistic concurrency needs the
   * invoice's current `SyncToken` — a write without it is refused, and a write
   * with a stale one is refused too, which is the point: it means somebody
   * edited the invoice in QuickBooks since this page loaded it.
   */
  async updateInvoice(
    user: SessionUser,
    companyId: string,
    invoiceId: string,
    patch: Record<string, unknown>,
  ): Promise<{ invoice: Record<string, unknown>; changed: boolean }> {
    if (!invoiceId) throw new BadRequestError("Missing invoice id.");

    // Refused BEFORE the connection is read: the answer does not depend on the
    // company, and a caller trying to restructure an invoice should be told so
    // whether or not QuickBooks happens to be connected.
    const blocked = BLOCKED_INVOICE_FIELDS.filter((field) => patch[field] !== undefined);
    const customerAsString = typeof patch.customer === "string";
    if (blocked.length > 0 || customerAsString) {
      throw new ComplexInvoiceUpdateError(
        blocked.length > 0 ? [...blocked] : ["customer"],
      );
    }

    const { realmId, accessToken } = await this.connection(user, companyId);

    const found = await this.deps.fetcher.queryEntity({
      realmId,
      accessToken,
      entityType: "invoices",
      where: `Id = '${escapeQueryLiteral(invoiceId)}'`,
      maxResults: 1,
    });
    const existing = invoiceFrom(found.payload);
    if (!existing) throw new NotFoundError("No such invoice in this company's QuickBooks.");

    const fields = toInvoiceFields(patch);
    if (Object.keys(fields).length === 0) {
      // Nothing to write. Answering the invoice unchanged beats sending Intuit
      // a sparse update with no fields, which it refuses as a validation fault
      // and which reads to the caller as a failure they caused.
      return { invoice: existing, changed: false };
    }

    const answered = await this.mutate()({
      realmId,
      accessToken,
      entityType: "invoices",
      payload: {
        Id: String(existing.Id ?? invoiceId),
        SyncToken: String(existing.SyncToken ?? "0"),
        sparse: true,
        ...fields,
      },
    });

    const invoice = answered.payload.Invoice;
    if (invoice === undefined || invoice === null) {
      throw new BadRequestError("QuickBooks did not apply the change.");
    }
    return { invoice: invoice as Record<string, unknown>, changed: true };
  }
}

/**
 * A caller trying to restructure an invoice.
 *
 * Its own type because the answer carries `redirectToQuickBooks`, which the
 * page turns into a link — telling somebody "not allowed" without telling them
 * where it IS allowed leaves them stuck.
 */
export class ComplexInvoiceUpdateError extends BadRequestError {
  constructor(readonly fields: string[]) {
    super(
      `${fields.join(", ")} cannot be changed here. Edit the invoice in QuickBooks.`,
    );
    this.name = "ComplexInvoiceUpdateError";
  }
}

/** The invoice inside a query answer, whatever shape it came back in. */
function invoiceFrom(payload: Record<string, unknown>): Record<string, unknown> | null {
  const response = payload.QueryResponse;
  if (response === null || typeof response !== "object") return null;
  const rows = (response as Record<string, unknown>).Invoice;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as Record<string, unknown>;
}

/**
 * The three fields an invoice update may carry, as Intuit names them.
 *
 * An absent field is left alone; the page cannot clear a private note this
 * way. That is deliberate rather than an oversight: an empty note is what a
 * cleared form field sends, and wiping somebody's QuickBooks note because
 * their form was blank is a worse failure than being unable to clear it.
 */
export function toInvoiceFields(patch: InvoicePatch): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const number = either(patch.invoiceNumber);
  const dueDate = either(patch.dueDate);
  const note = either(patch.note);

  if (number !== undefined) fields.DocNumber = number;
  if (dueDate !== undefined) fields.DueDate = dueDate;
  if (note !== undefined) fields.PrivateNote = note;
  return fields;
}
