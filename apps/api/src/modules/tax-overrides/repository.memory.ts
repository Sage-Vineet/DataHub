import type { TaxOverride, TaxOverrideInput, TaxOverridesRepository } from "./ports.js";

/** The same contract, in memory, for tests that do not need Postgres. */
export class InMemoryTaxOverridesRepository implements TaxOverridesRepository {
  private readonly byCompany = new Map<string, TaxOverride[]>();

  /** A fixed timestamp keeps the tests comparing values rather than clocks. */
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  list(companyId: string): Promise<TaxOverride[]> {
    return Promise.resolve(
      [...(this.byCompany.get(companyId) ?? [])].sort(
        (a, b) =>
          a.fiscalYear - b.fiscalYear || a.lineLabel.localeCompare(b.lineLabel),
      ),
    );
  }

  replaceAll(
    companyId: string,
    overrides: readonly TaxOverrideInput[],
    _updatedBy: string | null,
  ): Promise<TaxOverride[]> {
    const updatedAt = this.now();
    this.byCompany.set(
      companyId,
      overrides.map((override) => ({ ...override, updatedAt })),
    );
    return this.list(companyId);
  }
}
