import { useEffect, useMemo, useState } from "react";
import Header from "../../../components/Header";
import {
  Activity,
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  Download,
  Eye,
  FileText,
  Globe,
  Mail,
  RefreshCw,
  Search,
  User,
  Wallet,
  X,
} from "lucide-react";
import { formatCurrency, cn } from "../../../lib/utils";
import { exportToCSV } from "../../../lib/exportCSV";
import {
  fetchInvoices,
  getInvoiceByDocNumber,
  updateInvoice,
} from "../../../services/invoiceService";
import { fetchCustomers } from "../../../services/customerService";
import {
  getConnectionStatus,
  refreshQuickbooksToken,
} from "../../../services/authService";
import QBDisconnectedBanner from "../../../components/common/QBDisconnectedBanner";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_NOTES_STORAGE_KEY = "workspace-invoice-month-notes";
const MONTH_DISCOUNTS_STORAGE_KEY = "workspace-invoice-month-discounts";

const SERVICE_KEYWORDS = [
  "service",
  "services",
  "design",
  "gardening",
  "installation",
  "trimming",
  "maintenance",
  "repair",
  "pest control",
  "labor",
];

function readStoredObject(key) {
  if (typeof window === "undefined") return {};

  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function parseInvoiceDate(value) {
  if (!value) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year, month - 1, day);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatShortDate(value) {
  const date = parseInvoiceDate(value);
  if (!date) return "N/A";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatEditableAmount(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return "0";
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
}

function getInvoicesArray(payload) {
  if (Array.isArray(payload?.QueryResponse?.Invoice)) {
    return payload.QueryResponse.Invoice;
  }

  if (Array.isArray(payload?.data?.QueryResponse?.Invoice)) {
    return payload.data.QueryResponse.Invoice;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function getCustomersArray(payload) {
  if (Array.isArray(payload?.QueryResponse?.Customer)) {
    return payload.QueryResponse.Customer;
  }

  if (Array.isArray(payload?.data?.QueryResponse?.Customer)) {
    return payload.data.QueryResponse.Customer;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function deriveInvoiceStatus(invoice) {
  const balance = Number(invoice?.Balance ?? invoice?.balance ?? 0);
  const dueDate = invoice?.DueDate || invoice?.dueDate;

  if (balance === 0) return "paid";

  if (dueDate) {
    const due = parseInvoiceDate(dueDate);
    const now = new Date();
    if (due && due < now) {
      return "overdue";
    }
  }

  return "open";
}

function getInvoiceLineItems(invoice) {
  return Array.isArray(invoice?.Line)
    ? invoice.Line.filter((line) => line?.DetailType === "SalesItemLineDetail")
    : [];
}

function getDiscountAmount(invoice) {
  return Array.isArray(invoice?.Line)
    ? invoice.Line.reduce((total, line) => {
        if (line?.DetailType !== "DiscountLineDetail") return total;
        return total + Number(line?.Amount || 0);
      }, 0)
    : 0;
}

function isServiceLine(line) {
  const itemName = line?.SalesItemLineDetail?.ItemRef?.name || "";
  const accountName = line?.SalesItemLineDetail?.ItemAccountRef?.name || "";
  const description = line?.Description || "";
  const haystack = `${itemName} ${accountName} ${description}`.toLowerCase();

  if (!haystack.trim()) return false;

  return SERVICE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

function getServiceAmount(invoice) {
  return getInvoiceLineItems(invoice).reduce((total, line) => {
    if (!isServiceLine(line)) return total;
    return total + Number(line?.Amount || 0);
  }, 0);
}

function normalizeInvoice(invoice) {
  return {
    id: invoice?.Id || invoice?.id || invoice?.DocNumber,
    invoiceNumber: invoice?.DocNumber || invoice?.invoiceNumber || "",
    customer:
      invoice?.CustomerRef?.name ||
      invoice?.customer ||
      invoice?.customerName ||
      "Unknown Client",
    customerId: invoice?.CustomerRef?.value || invoice?.customerId || "",
    date: invoice?.TxnDate || invoice?.date || "",
    dueDate: invoice?.DueDate || invoice?.dueDate || "",
    status: deriveInvoiceStatus(invoice),
    amount: Number(invoice?.TotalAmt ?? invoice?.amount ?? 0),
    balance: Number(invoice?.Balance ?? invoice?.balance ?? 0),
    serviceAmount: getServiceAmount(invoice),
    discountAmount: getDiscountAmount(invoice),
    privateNote: invoice?.PrivateNote || invoice?.privateNote || "",
    email: invoice?.BillEmail?.Address || invoice?.email || "",
    terms: invoice?.SalesTermRef?.name || invoice?.terms || "",
    currency: invoice?.CurrencyRef?.name || invoice?.currency || "USD",
    raw: invoice,
  };
}

function filterInvoices(invoices, filters) {
  const { searchTerm, statusFilter, dateFilter, customerFilter, selectedYear } =
    filters;
  const term = String(searchTerm || "")
    .trim()
    .toLowerCase();
  const now = new Date();

  return invoices.filter((invoice) => {
    const invoiceDate = parseInvoiceDate(invoice.date);
    const matchesSearch =
      !term ||
      String(invoice.invoiceNumber || "")
        .toLowerCase()
        .includes(term) ||
      String(invoice.customer || "")
        .toLowerCase()
        .includes(term);

    const matchesStatus =
      statusFilter === "all" || invoice.status === statusFilter;

    const matchesCustomer =
      customerFilter === "all" || invoice.customer === customerFilter;

    let matchesDate = true;

    if (dateFilter === "this-month") {
      matchesDate =
        !!invoiceDate &&
        invoiceDate.getFullYear() === now.getFullYear() &&
        invoiceDate.getMonth() === now.getMonth();
    } else if (dateFilter === "last-month") {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      matchesDate =
        !!invoiceDate &&
        invoiceDate.getFullYear() === lastMonth.getFullYear() &&
        invoiceDate.getMonth() === lastMonth.getMonth();
    } else if (dateFilter === "selected-year") {
      matchesDate =
        !!invoiceDate && invoiceDate.getFullYear() === Number(selectedYear);
    }

    return matchesSearch && matchesStatus && matchesCustomer && matchesDate;
  });
}

function statusConfig(status) {
  const configs = {
    paid: {
      label: "Paid",
      icon: CheckCircle2,
      className: "bg-[#EAF7E2] text-[#3C8C47] border-[#CFE9C6]",
    },
    open: {
      label: "Open",
      icon: Clock,
      className: "bg-[#E8F1FF] text-[#3C66C9] border-[#C9D8FF]",
    },
    overdue: {
      label: "Overdue",
      icon: AlertCircle,
      className: "bg-[#FDEDED] text-[#C62026] border-[#F7C9CD]",
    },
    draft: {
      label: "Draft",
      icon: FileText,
      className: "bg-[#F4F4F5] text-[#6B7280] border-[#E5E7EB]",
    },
  };

  return configs[String(status || "draft").toLowerCase()] || configs.draft;
}

function buildMonthRows(invoices, year, notesMap, discountMap) {
  return MONTH_NAMES.map((monthLabel, monthIndex) => {
    const monthInvoices = invoices
      .filter((invoice) => {
        const date = parseInvoiceDate(invoice.date);
        return (
          date && date.getFullYear() === year && date.getMonth() === monthIndex
        );
      })
      .sort((left, right) => {
        const leftDate = parseInvoiceDate(left.date)?.getTime() || 0;
        const rightDate = parseInvoiceDate(right.date)?.getTime() || 0;
        return rightDate - leftDate;
      });

    const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    const totalPostedAmount = monthInvoices.reduce(
      (sum, invoice) => sum + Math.max(invoice.amount - invoice.balance, 0),
      0,
    );
    const invoiceAmount = monthInvoices.reduce(
      (sum, invoice) => sum + invoice.amount,
      0,
    );
    const totalServiceAmount = monthInvoices.reduce(
      (sum, invoice) => sum + invoice.serviceAmount,
      0,
    );
    const paidInvoices = monthInvoices.filter(
      (invoice) => invoice.status === "paid",
    ).length;
    const derivedDiscount = monthInvoices.reduce(
      (sum, invoice) => sum + invoice.discountAmount,
      0,
    );
    const discountValue =
      discountMap[key] === "" || discountMap[key] === undefined
        ? derivedDiscount
        : Number(discountMap[key] || 0);

    return {
      key,
      monthLabel,
      monthIndex,
      year,
      invoices: monthInvoices,
      invoiceCount: monthInvoices.length,
      totalPostedAmount,
      servicePercent:
        invoiceAmount > 0 ? (totalServiceAmount / invoiceAmount) * 100 : 0,
      invoiceAmount,
      totalEV: monthInvoices.length,
      dollarsPerEV:
        monthInvoices.length > 0 ? invoiceAmount / monthInvoices.length : 0,
      totalPA: paidInvoices,
      dollarsPerPA: paidInvoices > 0 ? totalPostedAmount / paidInvoices : 0,
      notes: notesMap[key] || "",
      discountInput:
        discountMap[key] === undefined
          ? formatEditableAmount(derivedDiscount)
          : String(discountMap[key]),
      discountValue,
      clientFinalTotal: invoiceAmount - discountValue,
    };
  });
}

function MetricCard({ label, value, tone, icon: Icon, subtitle }) {
  return (
    <div className="rounded-[22px] border border-[#E6E8EE] bg-white p-5 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
      <div
        className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl"
        style={{ backgroundColor: tone.bg }}
      >
        <Icon size={20} style={{ color: tone.fg }} />
      </div>
      <p className="text-[26px] font-bold tracking-tight text-[#101828]">
        {value}
      </p>
      <p className="mt-1 text-[13px] font-medium text-[#344054]">{label}</p>
      <p className="mt-1 text-[12px] text-[#667085]">{subtitle}</p>
    </div>
  );
}

function MonthlySummarySkeleton() {
  return (
    <div className="overflow-hidden rounded-[24px] border border-[#E6E8EE] bg-white shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
      <div className="overflow-x-auto">
        <table className="min-w-[1120px] w-full border-collapse">
          <thead>
            <tr className="border-b border-[#E8ECF2] bg-[#F5F7FA]">
              {[
                "Month",
                "Year",
                "Total Posted Amt",
                "Service %",
                "Invoice Amount",
                "Total EV",
                "$ per EV",
                "Total PA",
                "$ per PA",
                "Notes",
                "Discount ($)",
                "Client Final Total",
              ].map((label) => (
                <th
                  key={label}
                  className="px-4 py-4 text-left text-[13px] font-semibold text-[#344054]"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MONTH_NAMES.map((month) => (
              <tr key={month} className="border-b border-[#EEF2F6]">
                {Array.from({ length: 12 }).map((_, index) => (
                  <td key={`${month}-${index}`} className="px-4 py-3">
                    <div className="h-9 animate-pulse rounded-lg bg-[#F3F4F6]" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceFilters({
  searchTerm,
  statusFilter,
  dateFilter,
  customerFilter,
  onSearchChange,
  onStatusChange,
  onDateChange,
  onCustomerChange,
  onReset,
  customerOptions,
  selectedYear,
}) {
  return (
    <div className="rounded-[24px] border border-[#E6E8EE] bg-white p-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)]">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(320px,1.45fr)_minmax(170px,0.78fr)_minmax(170px,0.78fr)_minmax(210px,0.95fr)_auto] xl:items-center">
        <div className="relative min-w-0 md:col-span-2 xl:col-span-1">
          <div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
            <Search size={18} className="text-[#98A2B3]" />
          </div>
          <input
            type="text"
            value={searchTerm}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search by invoice # or client..."
            className="h-12 w-full rounded-xl border border-[#E4E7EC] bg-white pl-11 pr-4 text-[15px] text-[#101828] outline-none transition-colors placeholder:text-[#98A2B3] focus:border-[#8BC53D]"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(event) => onStatusChange(event.target.value)}
          className="h-12 w-full rounded-xl border border-[#E4E7EC] bg-white px-4 text-[15px] font-medium text-[#344054] outline-none transition-colors focus:border-[#8BC53D]"
        >
          <option value="all">All Statuses</option>
          <option value="paid">Paid</option>
          <option value="open">Open</option>
          <option value="overdue">Overdue</option>
          <option value="draft">Draft</option>
        </select>

        <select
          value={dateFilter}
          onChange={(event) => onDateChange(event.target.value)}
          className="h-12 w-full rounded-xl border border-[#E4E7EC] bg-white px-4 text-[15px] font-medium text-[#344054] outline-none transition-colors focus:border-[#8BC53D]"
        >
          <option value="all">All Dates</option>
          <option value="this-month">This Month</option>
          <option value="last-month">Last Month</option>
          <option value="selected-year">{selectedYear} Only</option>
        </select>

        <select
          value={customerFilter}
          onChange={(event) => onCustomerChange(event.target.value)}
          className="h-12 w-full rounded-xl border border-[#E4E7EC] bg-white px-4 text-[15px] font-medium text-[#344054] outline-none transition-colors focus:border-[#8BC53D]"
        >
          <option value="all">All Clients</option>
          {customerOptions.map((customer) => (
            <option key={customer} value={customer}>
              {customer}
            </option>
          ))}
        </select>

        <button
          onClick={onReset}
          className="h-12 rounded-xl border border-[#E4E7EC] bg-white px-5 text-[15px] font-semibold text-[#344054] transition-colors hover:bg-[#F8FAFC] md:col-span-2 xl:col-span-1"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function GenericEditModal({
  isOpen,
  onClose,
  onSave,
  initialData,
  title,
  fields,
}) {
  const [formData, setFormData] = useState(initialData || {});
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setFormData(initialData || {});
  }, [initialData]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35 backdrop-blur-[2px]">
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#E8ECF2] px-6 py-5">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#667085]">
              Invoice Detail
            </p>
            <h2 className="mt-1 text-[22px] font-bold text-[#101828]">
              {title}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-[#667085] transition-colors hover:bg-[#F3F4F6] hover:text-[#101828]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid flex-1 gap-4 overflow-y-auto bg-[#FAFBFC] px-6 py-5 md:grid-cols-2">
          {fields.map((field) => {
            const Icon = field.icon;
            const value = formData?.[field.name] ?? "";
            const isWide = field.type === "textarea";

            return (
              <div
                key={field.name}
                className={cn("space-y-2", isWide && "md:col-span-2")}
              >
                <label className="flex items-center gap-2 text-[13px] font-medium text-[#344054]">
                  {Icon ? <Icon size={15} className="text-[#667085]" /> : null}
                  {field.label}
                </label>

                {field.type === "select" ? (
                  <select
                    value={value}
                    onChange={(event) =>
                      setFormData((previous) => ({
                        ...previous,
                        [field.name]: event.target.value,
                      }))
                    }
                    className="h-11 w-full rounded-xl border border-[#D9DEE8] bg-white px-3 text-[14px] text-[#101828] outline-none transition-colors focus:border-[#8BC53D]"
                  >
                    {(field.options || []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea
                    value={value}
                    onChange={(event) =>
                      setFormData((previous) => ({
                        ...previous,
                        [field.name]: event.target.value,
                      }))
                    }
                    rows={4}
                    className="w-full rounded-xl border border-[#D9DEE8] bg-white px-3 py-2.5 text-[14px] text-[#101828] outline-none transition-colors focus:border-[#8BC53D]"
                  />
                ) : (
                  <input
                    type="text"
                    value={value}
                    placeholder={field.placeholder || ""}
                    onChange={(event) =>
                      setFormData((previous) => ({
                        ...previous,
                        [field.name]: event.target.value,
                      }))
                    }
                    className="h-11 w-full rounded-xl border border-[#D9DEE8] bg-white px-3 text-[14px] text-[#101828] outline-none transition-colors focus:border-[#8BC53D]"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-[#E8ECF2] px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-xl border border-[#D9DEE8] px-4 py-2 text-[14px] font-semibold text-[#344054] transition-colors hover:bg-[#F8FAFC]"
          >
            Close
          </button>
          <button
            onClick={async () => {
              setIsSaving(true);
              try {
                await onSave(formData);
                onClose();
              } catch (error) {
                console.error("Save failed:", error);
                alert(error.message || "Could not save invoice.");
              } finally {
                setIsSaving(false);
              }
            }}
            disabled={isSaving}
            className={cn(
              "rounded-xl bg-[#8BC53D] px-4 py-2 text-[14px] font-semibold text-white transition-all hover:bg-[#78AA32]",
              isSaving && "cursor-wait opacity-80",
            )}
          >
            {isSaving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

function useInvoices() {
  const [invoices, setInvoices] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;

    async function loadInvoices() {
      setIsLoading(true);
      setError("");

      try {
        const payload = await fetchInvoices();
        const normalized = getInvoicesArray(payload).map(normalizeInvoice);

        if (isMounted) {
          setInvoices(normalized);
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || "Failed to load invoices.");
          setInvoices([]);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadInvoices();

    return () => {
      isMounted = false;
    };
  }, []);

  return { invoices, setInvoices, isLoading, error };
}

function useCustomers() {
  const [customers, setCustomers] = useState([]);

  useEffect(() => {
    let isMounted = true;

    async function loadCustomers() {
      try {
        const payload = await fetchCustomers();
        const normalized = getCustomersArray(payload).map((customer) => ({
          id: customer?.Id || customer?.id || "",
          Id: customer?.Id || customer?.id || "",
          name: customer?.DisplayName || customer?.name || "",
        }));

        if (isMounted) {
          setCustomers(normalized);
        }
      } catch {
        if (isMounted) {
          setCustomers([]);
        }
      }
    }

    loadCustomers();

    return () => {
      isMounted = false;
    };
  }, []);

  return { customers };
}

export default function WorkspaceInvoices() {
  const { invoices, setInvoices, isLoading, error } = useInvoices();
  const { customers } = useCustomers();

  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(
    new Date().getMonth(),
  );
  const [monthNotes, setMonthNotes] = useState(() =>
    readStoredObject(MONTH_NOTES_STORAGE_KEY),
  );
  const [discountInputs, setDiscountInputs] = useState(() =>
    readStoredObject(MONTH_DISCOUNTS_STORAGE_KEY),
  );

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      MONTH_NOTES_STORAGE_KEY,
      JSON.stringify(monthNotes),
    );
  }, [monthNotes]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      MONTH_DISCOUNTS_STORAGE_KEY,
      JSON.stringify(discountInputs),
    );
  }, [discountInputs]);

  const yearOptions = useMemo(() => {
    const years = new Set([new Date().getFullYear()]);

    invoices.forEach((invoice) => {
      const date = parseInvoiceDate(invoice.date);
      if (date) years.add(date.getFullYear());
    });

    return Array.from(years).sort((left, right) => right - left);
  }, [invoices]);

  useEffect(() => {
    if (yearOptions.length === 0) return;

    if (!yearOptions.includes(selectedYear)) {
      setSelectedYear(yearOptions[0]);
    }
  }, [selectedYear, yearOptions]);

  const filteredInvoices = useMemo(
    () =>
      filterInvoices(invoices, {
        searchTerm,
        statusFilter,
        dateFilter,
        customerFilter,
        selectedYear,
      }),
    [
      customerFilter,
      dateFilter,
      invoices,
      searchTerm,
      selectedYear,
      statusFilter,
    ],
  );

  const monthRows = useMemo(
    () =>
      buildMonthRows(
        filteredInvoices,
        selectedYear,
        monthNotes,
        discountInputs,
      ),
    [discountInputs, filteredInvoices, monthNotes, selectedYear],
  );

  useEffect(() => {
    const hasInvoicesInSelectedMonth =
      monthRows[selectedMonthIndex]?.invoiceCount > 0;
    if (hasInvoicesInSelectedMonth) return;

    const firstMonthWithInvoices = monthRows.findIndex(
      (row) => row.invoiceCount > 0,
    );

    if (firstMonthWithInvoices !== -1) {
      setSelectedMonthIndex(firstMonthWithInvoices);
    }
  }, [monthRows, selectedMonthIndex]);

  const selectedMonthRow = monthRows[selectedMonthIndex] || monthRows[0];

  const annualSummary = useMemo(() => {
    return monthRows.reduce(
      (summary, row) => {
        summary.totalPostedAmount += row.totalPostedAmount;
        summary.invoiceAmount += row.invoiceAmount;
        summary.clientFinalTotal += row.clientFinalTotal;
        summary.totalInvoices += row.invoiceCount;
        summary.totalPaidInvoices += row.totalPA;
        return summary;
      },
      {
        totalPostedAmount: 0,
        invoiceAmount: 0,
        clientFinalTotal: 0,
        totalInvoices: 0,
        totalPaidInvoices: 0,
      },
    );
  }, [monthRows]);

  const weightedServicePercent =
    annualSummary.invoiceAmount > 0
      ? monthRows.reduce(
          (total, row) => total + row.servicePercent * row.invoiceAmount,
          0,
        ) / annualSummary.invoiceAmount
      : 0;

  const isComplexUpdate = (original, data) =>
    Number(data.totalAmt || 0) !== Number(original.totalAmt || 0) ||
    Number(data.balance || 0) !== Number(original.balance || 0) ||
    String(data.customerId || "") !== String(original.customerId || "") ||
    String(data.status || "") !== String(original.status || "");

  const openQuickBooksInvoice = (invoiceId) => {
    const baseUrl =
      import.meta.env.VITE_QB_ENV === "production"
        ? "https://qbo.intuit.com/app/invoice"
        : "https://sandbox.qbo.intuit.com/app/invoice";
    const url = `${baseUrl}?txnId=${invoiceId}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await refreshQuickbooksToken();
      window.location.reload();
    } catch (err) {
      console.error("Sync failed:", err);
      alert("Sync failed. Please try again.");
    } finally {
      setIsSyncing(false);
    }
  };

  const handleUpdateInvoice = async (formData) => {
    if (!editingInvoice) return;

    try {
      const status = await getConnectionStatus();
      if (!status?.isConnected) {
        alert("Please connect to QuickBooks");
        throw new Error("Please connect to QuickBooks");
      }
    } catch {
      alert("Please connect to QuickBooks");
      throw new Error("Please connect to QuickBooks");
    }

    if (isComplexUpdate(editingInvoice, formData)) {
      alert("Redirecting to QuickBooks for advanced editing");
      openQuickBooksInvoice(editingInvoice.id || editingInvoice.invoiceNumber);
      return;
    }

    const payload = {
      invoiceNumber: formData.docNumber,
      dueDate: formData.dueDate,
      note: formData.privateNote,
    };

    const response = await updateInvoice(editingInvoice.id, payload);
    const updatedInvoice = response?.data || response;

    setInvoices((previous) =>
      previous.map((invoice) =>
        invoice.id === editingInvoice.id
          ? normalizeInvoice({
              ...invoice.raw,
              ...updatedInvoice,
              DocNumber: updatedInvoice?.DocNumber || formData.docNumber,
              DueDate: updatedInvoice?.DueDate || formData.dueDate,
              PrivateNote:
                updatedInvoice?.PrivateNote || formData.privateNote || "",
            })
          : invoice,
      ),
    );
  };

  const handleOpenInvoice = async (invoice) => {
    setIsDetailLoading(true);

    try {
      const response = await getInvoiceByDocNumber(invoice.invoiceNumber);
      const detail = response?.data || response;
      const matchingCustomer = customers.find(
        (customer) => customer.name === invoice.customer,
      );

      setEditingInvoice({
        ...invoice,
        ...detail,
        docNumber: detail?.DocNumber || invoice.invoiceNumber,
        privateNote: detail?.PrivateNote || invoice.privateNote || "",
        customerId:
          invoice.customerId ||
          detail?.CustomerRef?.value ||
          matchingCustomer?.id ||
          matchingCustomer?.Id ||
          "",
        email: detail?.BillEmail?.Address || "N/A",
        terms: detail?.SalesTermRef?.name || "N/A",
        currency: detail?.CurrencyRef?.name || "USD",
        txnDate: detail?.TxnDate || invoice.date,
        totalAmt: detail?.TotalAmt || invoice.amount,
        balance: detail?.Balance || invoice.balance,
        status: invoice.status,
      });
      setIsEditModalOpen(true);
    } catch (loadError) {
      console.error("Failed to load invoice detail:", loadError);
      alert(loadError.message || "Could not load invoice details.");
    } finally {
      setIsDetailLoading(false);
    }
  };

  const handleExportCSV = () => {
    exportToCSV(
      monthRows,
      [
        "Month",
        "Year",
        "Total Posted Amt",
        "Service %",
        "Invoice Amount",
        "Total EV",
        "$ per EV",
        "Total PA",
        "$ per PA",
        "Notes",
        "Discount ($)",
        "Client Final Total",
      ],
      `invoice_summary_${selectedYear}`,
      (row) => [
        row.monthLabel,
        row.year,
        row.totalPostedAmount,
        `${row.servicePercent.toFixed(2)}%`,
        row.invoiceAmount,
        row.totalEV,
        row.dollarsPerEV,
        row.totalPA,
        row.dollarsPerPA,
        row.notes,
        row.discountValue,
        row.clientFinalTotal,
      ],
    );
  };

  const customerOptions = useMemo(
    () =>
      Array.from(
        new Set(customers.map((customer) => customer.name).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
    [customers],
  );

  return (
    <>
      <Header title="Invoices" />

      <div className="flex-1 space-y-6 bg-[#F6F8FB] p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#667085]">
              QuickBooks Invoice Matrix
            </p>
            <h1 className="mt-2 text-[30px] font-bold tracking-tight text-[#101828]">
              Invoices
            </h1>
            <p className="mt-1 max-w-2xl text-[14px] text-[#667085]">
              Monthly invoice performance laid out like the spreadsheet view
              from your reference, with live numbers from `GET /invoices`.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="rounded-2xl border border-[#D9DEE8] bg-white px-4 py-3 shadow-sm">
              <label className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085]">
                Year
              </label>
              <select
                value={selectedYear}
                onChange={(event) =>
                  setSelectedYear(Number(event.target.value))
                }
                className="mt-1 bg-transparent text-[15px] font-semibold text-[#101828] outline-none"
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="inline-flex items-center justify-center gap-2 rounded-2xl border border-[#D9DEE8] bg-white px-4 py-3 text-[14px] font-semibold text-[#344054] shadow-sm transition-all hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                size={16}
                className={isSyncing ? "animate-spin" : ""}
              />
              {isSyncing ? "Syncing..." : "Sync"}
            </button>

            <button
              onClick={handleExportCSV}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-[#8BC53D] px-4 py-3 text-[14px] font-semibold text-white shadow-[0_12px_24px_rgba(139,197,61,0.28)] transition-all hover:bg-[#78AA32]"
            >
              <Download size={16} />
              Export Summary
            </button>
          </div>
        </div>

        <QBDisconnectedBanner pageName="Client Invoices" />

        <InvoiceFilters
          searchTerm={searchTerm}
          statusFilter={statusFilter}
          dateFilter={dateFilter}
          customerFilter={customerFilter}
          onSearchChange={setSearchTerm}
          onStatusChange={setStatusFilter}
          onDateChange={setDateFilter}
          onCustomerChange={setCustomerFilter}
          onReset={() => {
            setSearchTerm("");
            setStatusFilter("all");
            setDateFilter("all");
            setCustomerFilter("all");
          }}
          customerOptions={customerOptions}
          selectedYear={selectedYear}
        />

        {/* <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Total Posted Amount"
            value={formatCurrency(annualSummary.totalPostedAmount)}
            subtitle="Collected or posted against this year's invoices"
            tone={{ bg: "#E8F1FF", fg: "#3C66C9" }}
            icon={Wallet}
          />
          <MetricCard
            label="Invoice Amount"
            value={formatCurrency(annualSummary.invoiceAmount)}
            subtitle="Gross invoice value across all months"
            tone={{ bg: "#EAF7E2", fg: "#3C8C47" }}
            icon={FileText}
          />
          <MetricCard
            label="Paid Invoices"
            value={annualSummary.totalPaidInvoices}
            subtitle={`${annualSummary.totalInvoices} total invoices in ${selectedYear}`}
            tone={{ bg: "#FFF3E8", fg: "#C26B1A" }}
            icon={CheckCircle2}
          />
          <MetricCard
            label="Weighted Service %"
            value={`${weightedServicePercent.toFixed(2)}%`}
            subtitle="Service-coded value as a share of invoice totals"
            tone={{ bg: "#EEF2FF", fg: "#4338CA" }}
            icon={Activity}
          />
        </div> */}

        {isLoading ? (
          <MonthlySummarySkeleton />
        ) : error && invoices.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-[#F5C2C7] bg-[#FDECEC] p-5 text-[14px] font-medium text-[#C62026]">
            <AlertCircle size={18} />
            {error}
          </div>
        ) : (
          <>
            <section className="overflow-hidden rounded-[24px] border border-[#E6E8EE] bg-white shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
              <div className="flex flex-col gap-2 border-b border-[#E8ECF2] px-5 py-5 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h2 className="text-[20px] font-bold text-[#101828]">
                    Monthly Invoice Summary
                  </h2>
                  <p className="mt-1 text-[13px] text-[#667085]">
                    Styled to match the spreadsheet layout you shared. Select a
                    month row to inspect the individual invoices underneath.
                  </p>
                </div>
                <p className="text-[12px] text-[#667085]">
                  Total EV = invoice count. Total PA = paid invoice count.
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[1120px] w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#E8ECF2] bg-[#F4F6F8]">
                      <th className="px-4 py-4 text-left text-[13px] font-semibold text-[#344054]">
                        Month
                      </th>
                      <th className="px-4 py-4 text-left text-[13px] font-semibold text-[#344054]">
                        Year
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Total Posted Amt
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Service %
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Invoice Amount
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Total EV
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        $ per EV
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Total PA
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        $ per PA
                      </th>
                      <th className="px-4 py-4 text-left text-[13px] font-semibold text-[#344054]">
                        Notes
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Discount ($)
                      </th>
                      <th className="px-4 py-4 text-right text-[13px] font-semibold text-[#344054]">
                        Client Final Total
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {monthRows.map((row) => (
                      <tr
                        key={row.key}
                        className={cn(
                          "border-b border-[#EEF2F6] transition-colors",
                          selectedMonthIndex === row.monthIndex
                            ? "bg-[#F8FBF2]"
                            : "hover:bg-[#FAFBFC]",
                        )}
                      >
                        <td className="px-4 py-3">
                          <button
                            onClick={() =>
                              setSelectedMonthIndex(row.monthIndex)
                            }
                            className="text-left text-[15px] font-medium text-[#101828] underline-offset-4 hover:text-[#476E2C] hover:underline"
                          >
                            {row.monthLabel}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-[15px] text-[#344054]">
                          {row.year}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] font-semibold text-[#3C66C9] tabular-nums">
                          {formatCurrency(row.totalPostedAmount)}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] text-[#101828] tabular-nums">
                          {row.servicePercent.toFixed(2)}%
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] font-semibold text-[#3C8C47] tabular-nums">
                          {formatCurrency(row.invoiceAmount)}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] text-[#101828] tabular-nums">
                          {row.totalEV}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] text-[#101828] tabular-nums">
                          {formatCurrency(row.dollarsPerEV)}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] text-[#101828] tabular-nums">
                          {row.totalPA}
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] text-[#101828] tabular-nums">
                          {formatCurrency(row.dollarsPerPA)}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={row.notes}
                            onChange={(event) =>
                              setMonthNotes((previous) => ({
                                ...previous,
                                [row.key]: event.target.value,
                              }))
                            }
                            placeholder="Add note..."
                            className="h-9 w-[170px] rounded-lg border border-[#E4E7EC] bg-white px-3 text-[14px] text-[#101828] outline-none transition-colors placeholder:text-[#98A2B3] focus:border-[#8BC53D]"
                          />
                        </td>
                        <td className="px-4 py-3">
                          <input
                            value={row.discountInput}
                            onChange={(event) =>
                              setDiscountInputs((previous) => ({
                                ...previous,
                                [row.key]: event.target.value,
                              }))
                            }
                            className="h-9 w-[92px] rounded-lg border border-[#E4E7EC] bg-white px-3 text-right text-[14px] text-[#101828] outline-none transition-colors focus:border-[#8BC53D]"
                          />
                        </td>
                        <td className="px-4 py-3 text-right text-[15px] font-bold text-[#38A169] tabular-nums">
                          {formatCurrency(row.clientFinalTotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>

                  <tfoot>
                    <tr className="bg-[#F8FAFC]">
                      <td className="px-4 py-4 text-[14px] font-bold text-[#101828]">
                        Year Total
                      </td>
                      <td className="px-4 py-4 text-[14px] font-bold text-[#101828]">
                        {selectedYear}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#3C66C9]">
                        {formatCurrency(annualSummary.totalPostedAmount)}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {weightedServicePercent.toFixed(2)}%
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#3C8C47]">
                        {formatCurrency(annualSummary.invoiceAmount)}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {annualSummary.totalInvoices}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {formatCurrency(
                          annualSummary.totalInvoices > 0
                            ? annualSummary.invoiceAmount /
                                annualSummary.totalInvoices
                            : 0,
                        )}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {annualSummary.totalPaidInvoices}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {formatCurrency(
                          annualSummary.totalPaidInvoices > 0
                            ? annualSummary.totalPostedAmount /
                                annualSummary.totalPaidInvoices
                            : 0,
                        )}
                      </td>
                      <td className="px-4 py-4 text-[14px] text-[#667085]">
                        -
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#101828]">
                        {formatCurrency(
                          monthRows.reduce(
                            (sum, row) => sum + row.discountValue,
                            0,
                          ),
                        )}
                      </td>
                      <td className="px-4 py-4 text-right text-[14px] font-bold text-[#38A169]">
                        {formatCurrency(annualSummary.clientFinalTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>

            <section className="overflow-hidden rounded-[24px] border border-[#E6E8EE] bg-white shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
              <div className="flex flex-col gap-3 border-b border-[#E8ECF2] px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h2 className="text-[20px] font-bold text-[#101828]">
                    {selectedMonthRow?.monthLabel} {selectedYear} Invoices
                  </h2>
                  <p className="mt-1 text-[13px] text-[#667085]">
                    Drill down into the individual invoices from the selected
                    month without losing the spreadsheet summary view.
                  </p>
                </div>
                <div className="rounded-full bg-[#F8FAFC] px-3 py-1 text-[12px] font-semibold text-[#475467]">
                  {selectedMonthRow?.invoiceCount || 0} invoices
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse">
                  <thead>
                    <tr className="border-b border-[#E8ECF2] bg-[#FCFCFD]">
                      <th className="px-5 py-3 text-left text-[13px] font-semibold text-[#667085]">
                        Invoice
                      </th>
                      <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#667085]">
                        Client
                      </th>
                      <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#667085]">
                        Issued
                      </th>
                      <th className="px-4 py-3 text-left text-[13px] font-semibold text-[#667085]">
                        Due
                      </th>
                      <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#667085]">
                        Amount
                      </th>
                      <th className="px-4 py-3 text-right text-[13px] font-semibold text-[#667085]">
                        Balance
                      </th>
                      <th className="px-4 py-3 text-center text-[13px] font-semibold text-[#667085]">
                        Status
                      </th>
                      <th className="px-5 py-3 text-right text-[13px] font-semibold text-[#667085]">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedMonthRow?.invoices?.length ? (
                      selectedMonthRow.invoices.map((invoice) => {
                        const status = statusConfig(invoice.status);
                        const StatusIcon = status.icon;

                        return (
                          <tr
                            key={invoice.id}
                            className="border-b border-[#EEF2F6] transition-colors hover:bg-[#FAFBFC]"
                          >
                            <td className="px-5 py-4">
                              <div>
                                <p className="text-[14px] font-semibold text-[#101828]">
                                  #{invoice.invoiceNumber}
                                </p>
                                <p className="mt-1 text-[12px] text-[#667085]">
                                  {invoice.privateNote || "No private note"}
                                </p>
                              </div>
                            </td>
                            <td className="px-4 py-4 text-[14px] text-[#101828]">
                              {invoice.customer}
                            </td>
                            <td className="px-4 py-4 text-[14px] text-[#475467]">
                              {formatShortDate(invoice.date)}
                            </td>
                            <td className="px-4 py-4 text-[14px] text-[#475467]">
                              {formatShortDate(invoice.dueDate)}
                            </td>
                            <td className="px-4 py-4 text-right text-[14px] font-semibold text-[#101828] tabular-nums">
                              {formatCurrency(invoice.amount)}
                            </td>
                            <td className="px-4 py-4 text-right text-[14px] font-semibold tabular-nums text-[#475467]">
                              {formatCurrency(invoice.balance)}
                            </td>
                            <td className="px-4 py-4 text-center">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] font-semibold",
                                  status.className,
                                )}
                              >
                                <StatusIcon size={12} />
                                {status.label}
                              </span>
                            </td>
                            <td className="px-5 py-4 text-right">
                              <button
                                onClick={() => handleOpenInvoice(invoice)}
                                disabled={isDetailLoading}
                                className="inline-flex items-center gap-2 rounded-xl border border-[#D9DEE8] bg-white px-3 py-2 text-[13px] font-semibold text-[#344054] transition-colors hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Eye size={14} />
                                View
                              </button>
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={8} className="px-5 py-14 text-center">
                          <div className="mx-auto max-w-md">
                            <p className="text-[15px] font-semibold text-[#101828]">
                              No invoices found for{" "}
                              {selectedMonthRow?.monthLabel}
                            </p>
                            <p className="mt-1 text-[13px] text-[#667085]">
                              This month still appears in the spreadsheet so you
                              can add notes and discount adjustments even
                              without invoice activity.
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>

      <GenericEditModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        onSave={handleUpdateInvoice}
        initialData={editingInvoice}
        title="View Invoice"
        fields={[
          {
            name: "docNumber",
            label: "Invoice Number",
            type: "text",
            icon: FileText,
          },
          {
            name: "txnDate",
            label: "Invoice Date",
            type: "text",
            icon: Calendar,
          },
          {
            name: "dueDate",
            label: "Due Date",
            type: "text",
            placeholder: "YYYY-MM-DD",
            icon: Calendar,
          },
          {
            name: "email",
            label: "Billing Email",
            type: "text",
            icon: Mail,
          },
          {
            name: "terms",
            label: "Sales Terms",
            type: "text",
            icon: Clock,
          },
          {
            name: "currency",
            label: "Currency",
            type: "text",
            icon: Globe,
          },
          {
            name: "privateNote",
            label: "Note (Private)",
            type: "textarea",
            icon: FileText,
          },
          {
            name: "customerId",
            label: "Client",
            type: "select",
            icon: User,
            options: customers.map((customer) => ({
              label: customer.name,
              value: customer.id || customer.Id,
            })),
          },
          {
            name: "totalAmt",
            label: "Total Amount",
            type: "text",
            icon: DollarSign,
          },
          {
            name: "balance",
            label: "Balance Due",
            type: "text",
            icon: Wallet,
          },
          {
            name: "status",
            label: "Status",
            type: "select",
            options: [
              { label: "Paid", value: "paid" },
              { label: "Open", value: "open" },
              { label: "Overdue", value: "overdue" },
              { label: "Draft", value: "draft" },
            ],
          },
        ]}
      />
    </>
  );
}
