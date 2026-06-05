import { Fragment, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";
import { cn, formatCurrency } from "../../../lib/utils";

/**
 * Aggregate all transactions from every account in a category into a
 * Vendor → Account hierarchy.
 *
 * Returns: Array<{
 *   vendorName: string,
 *   yearlyTotals: Record<number, number>,
 *   totalAmount: number,
 *   accounts: Array<{ accountName, accountNumber, yearlyTotals, totalAmount }>
 * }>
 * Sorted by absolute totalAmount descending. Accounts within each vendor
 * are sorted alphabetically.
 */
function buildCategoryVendorRows(accounts) {
  const vendorMap = new Map();

  (accounts || []).forEach((account) => {
    (account.transactions || []).forEach((tx) => {
      const vendor = tx.vendorName || tx.vendor_name || "No Vendor";
      const year = Number(tx.fiscalYear || tx.fiscal_year || 0);
      const amount = Number(tx.netAmount ?? tx.net_amount ?? tx.amount ?? 0) || 0;

      if (!vendorMap.has(vendor)) {
        vendorMap.set(vendor, {
          vendorName: vendor,
          yearlyTotals: {},
          totalAmount: 0,
          accountMap: new Map(),
        });
      }

      const vendorRow = vendorMap.get(vendor);
      vendorRow.totalAmount += amount;
      if (year > 0) {
        vendorRow.yearlyTotals[year] = (vendorRow.yearlyTotals[year] || 0) + amount;
      }

      const accountKey = `${account.accountNumber || ""}::${account.accountName || ""}`;
      if (!vendorRow.accountMap.has(accountKey)) {
        vendorRow.accountMap.set(accountKey, {
          accountName: account.accountName || "Unnamed Account",
          accountNumber: account.accountNumber || "",
          yearlyTotals: {},
          totalAmount: 0,
        });
      }

      const acctRow = vendorRow.accountMap.get(accountKey);
      acctRow.totalAmount += amount;
      if (year > 0) {
        acctRow.yearlyTotals[year] = (acctRow.yearlyTotals[year] || 0) + amount;
      }
    });
  });

  return Array.from(vendorMap.values())
    .map(({ accountMap, ...v }) => ({
      ...v,
      accounts: Array.from(accountMap.values()).sort((a, b) =>
        a.accountName.localeCompare(b.accountName),
      ),
    }))
    .sort((a, b) => Math.abs(b.totalAmount) - Math.abs(a.totalAmount));
}

function AmountCell({ value, bold = false, className = "" }) {
  const num = Number(value || 0);
  return (
    <td
      className={cn(
        "px-4 py-2 text-right tabular-nums text-[13px]",
        bold ? "font-semibold text-text-primary" : "font-normal text-text-secondary",
        num < 0 && "text-status-error",
        className,
      )}
    >
      {num !== 0 ? formatCurrency(num) : "—"}
    </td>
  );
}

/** Primary expandable row: Vendor. Child rows: Accounts. */
function VendorRow({ vendor, years, isOpen, onToggle }) {
  return (
    <Fragment>
      <tr
        onClick={() => onToggle(vendor.vendorName)}
        className={cn(
          "border-b border-border cursor-pointer group transition-colors",
          isOpen ? "bg-bg-card/30" : "hover:bg-bg-page/50",
        )}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            {isOpen ? (
              <ChevronDown size={13} className="shrink-0 text-text-muted group-hover:text-primary transition-colors" />
            ) : (
              <ChevronRight size={13} className="shrink-0 text-text-muted group-hover:text-primary transition-colors" />
            )}
            <span className="text-[13px] font-semibold text-text-primary">
              {vendor.vendorName || "No Vendor"}
            </span>
          </div>
        </td>
        {years.map((year) => (
          <AmountCell key={year} value={vendor.yearlyTotals?.[year]} bold />
        ))}
        <AmountCell value={vendor.totalAmount} bold />
      </tr>

      {isOpen &&
        vendor.accounts.map((account) => (
          <tr
            key={`${account.accountNumber}::${account.accountName}`}
            className="border-b border-border/40 bg-bg-page/20 hover:bg-bg-page/50 transition-colors"
          >
            <td className="px-4 py-1.5 pl-10 text-[12px] text-text-secondary">
              {account.accountName || <span className="italic text-text-muted">—</span>}
            </td>
            {years.map((year) => (
              <AmountCell key={year} value={account.yearlyTotals?.[year]} />
            ))}
            <AmountCell value={account.totalAmount} />
          </tr>
        ))}
    </Fragment>
  );
}

/**
 * One P&L section (e.g. "Revenue", "Cost of Goods Sold").
 * Extracts its own useMemo so hooks rules are satisfied even though
 * the parent renders a list of these.
 */
function CategorySection({ category, years, openVendors, onToggle }) {
  const vendorRows = useMemo(
    () => buildCategoryVendorRows(category.accounts),
    [category.accounts],
  );

  const sectionTotal = Number(
    category.total ??
      category.totalAmount ??
      years.reduce((sum, yr) => sum + Number(category.totalsByYear?.[yr] || 0), 0),
  );

  return (
    <Fragment>
      {/* Category section header */}
      <tr className="border-b border-border bg-bg-page/60">
        <td className="px-4 py-2.5 text-[13px] font-bold text-text-primary">
          {category.category}
        </td>
        {years.map((yr) => (
          <td
            key={yr}
            className="px-4 py-2.5 text-right text-[13px] font-bold text-text-primary tabular-nums"
          >
            {formatCurrency(Number(category.totalsByYear?.[yr] || 0))}
          </td>
        ))}
        <td
          className={cn(
            "px-4 py-2.5 text-right text-[13px] font-bold tabular-nums",
            sectionTotal < 0 ? "text-status-error" : "text-text-primary",
          )}
        >
          {formatCurrency(sectionTotal)}
        </td>
      </tr>

      {/* Vendor rows — each expands to show account sub-rows */}
      {vendorRows.map((vendor) => (
        <VendorRow
          key={vendor.vendorName}
          vendor={vendor}
          years={years}
          isOpen={openVendors.has(vendor.vendorName)}
          onToggle={onToggle}
        />
      ))}
    </Fragment>
  );
}

export default function ManualProfitLossDetail({
  data,
  title = "Profit & Loss Detail",
  subtitle,
  entityName = "Company",
}) {
  const years = Array.isArray(data?.years) ? data.years : [];
  const categories = Array.isArray(data?.categories) ? data.categories : [];

  const [openVendors, setOpenVendors] = useState(() => new Set());

  const toggleVendor = (vendorName) => {
    setOpenVendors((prev) => {
      const next = new Set(prev);
      if (next.has(vendorName)) next.delete(vendorName);
      else next.add(vendorName);
      return next;
    });
  };

  const colSpanAll = years.length + 2;

  return (
    <div className="flex-1 overflow-y-auto bg-bg-page/50 p-10 lg:p-16 font-inter">
      <div className="max-w-[1300px] mx-auto card-base p-10 min-h-[900px] flex flex-col rounded-sm shadow-xl">

        {/* Report header */}
        <div className="flex flex-col items-center mb-10 relative">
          <div className="w-12 h-1 bg-primary rounded-full mb-6" />
          <h1 className="text-[22px] font-bold text-text-primary tracking-tight leading-none mb-2">
            {entityName}
          </h1>
          <h2 className="text-[18px] font-medium text-text-secondary mb-4">{title}</h2>
          {subtitle && (
            <div className="flex items-center gap-3 text-[12px] text-text-muted bg-bg-page px-4 py-1.5 rounded-full border border-border">
              <span>{subtitle}</span>
            </div>
          )}
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-bg-page border-b-2 border-border sticky top-0 z-10">
                <th className="px-4 py-3 text-left text-[12px] font-semibold text-text-primary uppercase tracking-wider min-w-[260px]">
                  Vendor / Account
                </th>
                {years.map((year) => (
                  <th
                    key={year}
                    className="px-4 py-3 text-right text-[12px] font-semibold text-text-primary uppercase tracking-wider min-w-[110px]"
                  >
                    {year}
                  </th>
                ))}
                <th className="px-4 py-3 text-right text-[12px] font-semibold text-text-primary uppercase tracking-wider min-w-[110px]">
                  Grand Total
                </th>
              </tr>
            </thead>

            <tbody>
              {categories.map((category) => (
                <CategorySection
                  key={category.category}
                  category={category}
                  years={years}
                  openVendors={openVendors}
                  onToggle={toggleVendor}
                />
              ))}

              {categories.length === 0 && (
                <tr>
                  <td
                    colSpan={colSpanAll}
                    className="px-4 py-20 text-center text-text-muted italic"
                  >
                    <div className="flex flex-col items-center gap-2">
                      <FileText size={40} className="text-border mb-2" />
                      <span>No detailed report data found for the selected filters.</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
