import type { Account, GlEntry } from "@datahub/financial-engine";
import type { AddbackKind, DataSource, EbitdaRole, EntryGranularity } from "@datahub/contracts";

/** Everything the bridge needs for one key-report version. */
export interface EngagementData {
  companyId: string;
  companyName: string;
  profitMetric: "adjusted_ebitda" | "sde";
  marketRateReplacementSalary: number | null;
  fiscalYears: number[];
  accounts: Account[];
  entries: GlEntry[];
}

export interface AddbackRecord {
  id: string;
  companyId: string;
  versionId: string;
  kind: AddbackKind;
  dataSource: DataSource;
  typeKey: string;
  name: string;
  linkedAccountId: string | null;
  vendorScope: string[];
  granularity: EntryGranularity;
  values: Record<string, number>;
  recastNormalizedValue: number | null;
  groupId: string | null;
  groupLabel: string | null;
  explanation: string | null;
  commentary: string | null;
  createdBy: string | null;
}

export type CreateAddbackInput = Omit<AddbackRecord, "id">;

export interface QoeRepository {
  /** Accounts + GL rows for a version, or null when the version does not exist. */
  loadEngagement(versionId: string): Promise<EngagementData | null>;
  listAddbacks(versionId: string): Promise<AddbackRecord[]>;
  createAddback(input: CreateAddbackInput): Promise<AddbackRecord>;
  deleteAddback(id: string): Promise<void>;
  getAddback(id: string): Promise<AddbackRecord | null>;
  updateCommentary(id: string, commentary: string): Promise<AddbackRecord | null>;
  /** Assign or clear an account's EBITDA role — the flag that drives the EBIT lines. */
  setAccountRole(versionId: string, accountId: string, role: EbitdaRole | null): Promise<void>;
  /** Apply many role assignments at once, as one classification run. */
  setAccountRoles(
    versionId: string,
    updates: Array<{ accountId: string; role: EbitdaRole | null }>,
  ): Promise<void>;
}

/** Narrative drafting. Always returns an unsaved draft (`QE - 0004`). */
export interface CommentaryDraftPort {
  draft(input: { label: string; amounts: Record<string, number>; context: string }): Promise<string>;
}
