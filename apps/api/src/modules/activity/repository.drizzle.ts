import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@datahub/db";
import type { BrokerActivitySources } from "./feed.js";
import type { ActivityRepository, ActivityScope } from "./ports.js";

const { companies, users, documents, requests, requestNarratives, activityLog } = schema;

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** The broker feed's sources over Postgres. */
export class DrizzleActivityRepository implements ActivityRepository {
  constructor(private readonly db: Db) {}

  async brokerSources(scope: ActivityScope, perSource: number): Promise<BrokerActivitySources> {
    // A non-admin is always scoped; `inArray` with an empty list is invalid SQL,
    // and the service returns early before it can happen.
    const ids = [...scope.companyIds];
    const companyFilter = scope.isAdmin ? undefined : inArray(companies.id, ids);
    const docFilter = scope.isAdmin ? undefined : inArray(documents.companyId, ids);
    const reqFilter = scope.isAdmin ? undefined : inArray(requests.companyId, ids);
    const logFilter = scope.isAdmin ? undefined : inArray(activityLog.companyId, ids);
    const buyerFilter = scope.isAdmin ? undefined : inArray(users.companyId, ids);

    const [companyRows, buyerRows, documentRows, requestRows, narrativeRows, logRows] =
      await Promise.all([
        this.db
          .select({
            id: companies.id,
            name: companies.name,
            projectName: companies.projectName,
            industry: companies.industry,
            createdAt: companies.createdAt,
          })
          .from(companies)
          .where(companyFilter)
          .orderBy(desc(companies.createdAt))
          .limit(perSource),
        this.db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            companyId: users.companyId,
            createdAt: users.createdAt,
          })
          .from(users)
          // The role filter is not optional: without it a scoped query would
          // list every user of the company, brokers included, as "clients".
          .where(buyerFilter ? and(eq(users.role, "buyer"), buyerFilter) : eq(users.role, "buyer"))
          .orderBy(desc(users.createdAt))
          .limit(perSource),
        this.db
          .select({
            id: documents.id,
            name: documents.name,
            companyId: documents.companyId,
            uploadedBy: documents.uploadedBy,
            uploadedAt: documents.uploadedAt,
          })
          .from(documents)
          .where(docFilter)
          .orderBy(desc(documents.uploadedAt))
          .limit(perSource),
        this.db
          .select({
            id: requests.id,
            title: requests.title,
            companyId: requests.companyId,
            createdBy: requests.createdBy,
            createdAt: requests.createdAt,
          })
          .from(requests)
          .where(reqFilter)
          .orderBy(desc(requests.createdAt))
          .limit(perSource),
        this.db
          .select({
            id: requestNarratives.id,
            requestId: requestNarratives.requestId,
            updatedBy: requestNarratives.updatedBy,
            updatedAt: requestNarratives.updatedAt,
          })
          .from(requestNarratives)
          .orderBy(desc(requestNarratives.updatedAt))
          .limit(perSource),
        this.db
          .select({
            id: activityLog.id,
            type: activityLog.type,
            message: activityLog.message,
            companyId: activityLog.companyId,
            createdBy: activityLog.createdBy,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(logFilter)
          .orderBy(desc(activityLog.createdAt))
          .limit(perSource),
      ]);

    // Narratives are fetched unscoped (they carry no company), so their requests
    // are resolved and filtered here — that filter is what keeps a request title
    // from another tenant out of the feed.
    const narrativeRequestIds = [
      ...new Set(narrativeRows.map((n) => n.requestId).filter((v): v is string => Boolean(v))),
    ];
    const requestById = new Map<string, { title: string | null; companyId: string | null }>();
    if (narrativeRequestIds.length > 0) {
      const rows = await this.db
        .select({ id: requests.id, title: requests.title, companyId: requests.companyId })
        .from(requests)
        .where(inArray(requests.id, narrativeRequestIds));
      for (const r of rows) {
        if (!scope.isAdmin && (!r.companyId || !scope.companyIds.includes(r.companyId))) continue;
        requestById.set(r.id, { title: r.title, companyId: r.companyId });
      }
    }

    const companyIdsToName = [
      ...new Set(
        [
          ...documentRows.map((d) => d.companyId),
          ...requestRows.map((r) => r.companyId),
          ...logRows.map((l) => l.companyId),
          ...buyerRows.map((u) => u.companyId),
          ...[...requestById.values()].map((v) => v.companyId),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    const companyNameById = new Map<string, string>();
    if (companyIdsToName.length > 0) {
      const rows = await this.db
        .select({ id: companies.id, name: companies.name, projectName: companies.projectName })
        .from(companies)
        .where(inArray(companies.id, companyIdsToName));
      // The project name is what a broker calls the deal; the legal name is the
      // fallback.
      for (const c of rows) companyNameById.set(c.id, c.projectName ?? c.name);
    }

    const actorIds = [
      ...new Set(
        [
          ...documentRows.map((d) => d.uploadedBy),
          ...requestRows.map((r) => r.createdBy),
          ...narrativeRows.map((n) => n.updatedBy),
          ...logRows.map((l) => l.createdBy),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    const userNameById = new Map<string, string>();
    if (actorIds.length > 0) {
      const rows = await this.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, actorIds));
      for (const u of rows) userNameById.set(u.id, u.name);
    }

    return {
      companies: companyRows.map((c) => ({ ...c, createdAt: iso(c.createdAt) })),
      buyers: buyerRows.map((u) => ({ ...u, createdAt: iso(u.createdAt) })),
      documents: documentRows.map((d) => ({ ...d, uploadedAt: iso(d.uploadedAt) })),
      requests: requestRows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
      narratives: narrativeRows.map((n) => ({ ...n, updatedAt: iso(n.updatedAt) })),
      activityLog: logRows.map((l) => ({ ...l, createdAt: iso(l.createdAt) })),
      requestById,
      companyNameById,
      userNameById,
    };
  }
}
