import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "@datahub/contracts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { InMemoryBankReconciliationRepository } from "./repository.memory.js";
import { BankReconciliationService } from "./service.js";

/**
 * The editable parts of the bank reconciliation.
 *
 * The grid saves on blur, which shapes most of what matters here: the same cell
 * is written over and over, and an edit that silently does nothing is worse
 * than one that fails, because the number stays on screen until a refresh takes
 * it away.
 */

const COMPANY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const make = () => {
  const repo = new InMemoryBankReconciliationRepository();
  return { repo, service: new BankReconciliationService({ repo }) };
};

const session = (over: Partial<SessionUser> = {}): SessionUser => ({
  id: randomUUID(),
  name: "Dana",
  email: "dana@example.test",
  role: "broker",
  company_id: null,
  status: "active",
  company_ids: [COMPANY],
  ...over,
});

describe("adjustments", () => {
  it("records a cell and reads it back", async () => {
    const { service } = make();
    const user = session();
    await service.setAdjustment(user, COMPANY, { month: "2024-03", rowKey: "deposits", amount: 125.5 });

    expect(await service.listAdjustments(user, COMPANY)).toEqual([
      { month: "2024-03", rowKey: "deposits", amount: 125.5 },
    ]);
  });

  it("replaces the cell rather than stacking it, however often it is saved", async () => {
    // The grid writes on every blur.
    const { service } = make();
    const user = session();
    for (const amount of [1, 2, 3]) {
      await service.setAdjustment(user, COMPANY, { month: "2024-03", rowKey: "deposits", amount });
    }
    const adjustments = await service.listAdjustments(user, COMPANY);
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]!.amount).toBe(3);
  });

  it("reads a cleared cell as zero rather than refusing it", async () => {
    // An empty input means zero, not an error.
    const { service } = make();
    const user = session();
    await service.setAdjustment(user, COMPANY, { month: "2024-03", rowKey: "fees", amount: "" });
    expect((await service.listAdjustments(user, COMPANY))[0]!.amount).toBe(0);

    await service.setAdjustment(user, COMPANY, { month: "2024-03", rowKey: "fees", amount: "abc" });
    expect((await service.listAdjustments(user, COMPANY))[0]!.amount).toBe(0);
  });

  it("refuses a cell that names no row or column", async () => {
    const { service } = make();
    await expect(
      service.setAdjustment(session(), COMPANY, { month: "", rowKey: "deposits", amount: 1 }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      service.setAdjustment(session(), COMPANY, { month: "2024-03", rowKey: "", amount: 1 }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("keeps one company's grid out of another's", async () => {
    const { service } = make();
    const dana = session();
    await service.setAdjustment(dana, COMPANY, { month: "2024-03", rowKey: "deposits", amount: 5 });

    const sam = session({ company_ids: [OTHER] });
    expect(await service.listAdjustments(sam, OTHER)).toEqual([]);
  });

  it("refuses a company the caller cannot reach, and one they did not name", async () => {
    const { service } = make();
    await expect(
      service.listAdjustments(session({ company_ids: [OTHER] }), COMPANY),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.listAdjustments(session(), "")).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("add-back items", () => {
  const setup = async () => {
    const h = make();
    const user = session();
    const item = await h.service.createAddbackItem(user, COMPANY, {
      section: "deposits",
      name: "Owner salary",
      monthAmounts: { "2024-01": 1000 },
      reportSource: "quickbooks_online",
    });
    return { ...h, user, item };
  };

  it("creates one, defaulting its source to manual", async () => {
    const { item } = await setup();
    expect(item.name).toBe("Owner salary");
    expect(item.source).toBe("manual");
    expect(item.monthAmounts).toEqual({ "2024-01": 1000 });
  });

  it("lists by report source, so one source's rows stay off another's grid", async () => {
    const { service, user } = await setup();
    await service.createAddbackItem(user, COMPANY, {
      section: "deposits",
      name: "From a manual upload",
      reportSource: "manual_upload",
    });

    const qb = await service.listAddbackItems(user, COMPANY, {
      reportSource: "quickbooks_online",
    });
    expect(qb.map((i) => i.name)).toEqual(["Owner salary"]);
  });

  it("narrows to a section when one is asked for", async () => {
    const { service, user } = await setup();
    await service.createAddbackItem(user, COMPANY, {
      section: "withdrawals",
      name: "Loan interest",
      reportSource: "quickbooks_online",
    });

    const operating = await service.listAddbackItems(user, COMPANY, {
      reportSource: "quickbooks_online",
      section: "deposits",
    });
    expect(operating.map((i) => i.name)).toEqual(["Owner salary"]);
  });

  it("refuses a listing that names no report source", async () => {
    // Without it every source's rows come back together.
    const { service, user } = await setup();
    await expect(
      service.listAddbackItems(user, COMPANY, { reportSource: "" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("refuses a create missing any of the three required fields", async () => {
    const { service, user } = await setup();
    const bad = [
      { section: "", name: "x", reportSource: "quickbooks_online" },
      { section: "deposits", name: "", reportSource: "quickbooks_online" },
      { section: "deposits", name: "x", reportSource: "" },
    ];
    for (const input of bad) {
      await expect(service.createAddbackItem(user, COMPANY, input)).rejects.toBeInstanceOf(
        BadRequestError,
      );
    }
  });

  it("edits the monthly amounts", async () => {
    const { service, user, item } = await setup();
    await service.updateAddbackItemAmounts(user, COMPANY, item.id, { "2024-02": 250 });

    const [updated] = await service.listAddbackItems(user, COMPANY, {
      reportSource: "quickbooks_online",
    });
    expect(updated!.monthAmounts).toEqual({ "2024-02": 250 });
  });

  it("404s an edit that matches nothing, rather than reporting it saved", async () => {
    // Legacy scoped the update by company and answered `{ success: true }`
    // whatever happened, so editing an item that had been deleted reported
    // saved and changed nothing — and on a grid that saves on blur the number
    // stays on screen until a refresh quietly takes it away.
    const { service, user } = await setup();
    await expect(
      service.updateAddbackItemAmounts(user, COMPANY, randomUUID(), { "2024-02": 1 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s an edit to another company's item, and leaves it alone", async () => {
    const { service, user, item } = await setup();
    const sam = session({ company_ids: [OTHER] });

    await expect(
      service.updateAddbackItemAmounts(sam, OTHER, item.id, { "2024-02": 999 }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const [untouched] = await service.listAddbackItems(user, COMPANY, {
      reportSource: "quickbooks_online",
    });
    expect(untouched!.monthAmounts).toEqual({ "2024-01": 1000 });
  });

  it("deletes one", async () => {
    const { service, user, item } = await setup();
    await service.deleteAddbackItem(user, COMPANY, item.id);
    expect(
      await service.listAddbackItems(user, COMPANY, { reportSource: "quickbooks_online" }),
    ).toEqual([]);
  });

  it("404s a delete that matches nothing", async () => {
    const { service, user } = await setup();
    await expect(
      service.deleteAddbackItem(user, COMPANY, randomUUID()),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s a delete of another company's item, and leaves it alone", async () => {
    const { service, user, item } = await setup();
    const sam = session({ company_ids: [OTHER] });

    await expect(service.deleteAddbackItem(sam, OTHER, item.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(
      await service.listAddbackItems(user, COMPANY, { reportSource: "quickbooks_online" }),
    ).toHaveLength(1);
  });

  it("refuses every operation for a company the caller cannot reach", async () => {
    const { service, item } = await setup();
    const stranger = session({ role: "buyer", company_ids: [] });
    await expect(
      service.listAddbackItems(stranger, COMPANY, { reportSource: "quickbooks_online" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.createAddbackItem(stranger, COMPANY, {
        section: "deposits",
        name: "x",
        reportSource: "quickbooks_online",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.updateAddbackItemAmounts(stranger, COMPANY, item.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.deleteAddbackItem(stranger, COMPANY, item.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("the section a line is filed under", () => {
  /**
   * `section` is a database CHECK, not a convention. Legacy did not check it,
   * so a typo reached Postgres and came back as a 500 from inside the driver —
   * a stack trace where a field name would have done.
   */
  it("refuses a section that is not one of the two", async () => {
    const { service } = make();
    const user = session();
    await expect(
      service.createAddbackItem(user, COMPANY, {
        section: "operating",
        name: "Owner salary",
        reportSource: "quickbooks_online",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("names the field and its options, rather than saying invalid", async () => {
    const { service } = make();
    let message = "";
    try {
      await service.createAddbackItem(session(), COMPANY, {
        section: "operating",
        name: "x",
        reportSource: "quickbooks_online",
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("operating");
    expect(message).toContain("deposits");
    expect(message).toContain("withdrawals");
  });

  it("accepts both real sections", async () => {
    const { service } = make();
    const user = session();
    for (const section of ["deposits", "withdrawals"]) {
      const item = await service.createAddbackItem(user, COMPANY, {
        section,
        name: `Line for ${section}`,
        reportSource: "quickbooks_online",
      });
      expect(item.section).toBe(section);
    }
  });

  it("refuses a filter naming a section that cannot exist", async () => {
    // Listing it would answer an empty array, which reads as "this section is
    // empty" rather than "there is no such section".
    const { service } = make();
    await expect(
      service.listAddbackItems(session(), COMPANY, {
        reportSource: "quickbooks_online",
        section: "operating",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});
