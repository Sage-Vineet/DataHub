import { useEffect, useMemo, useState } from "react";
import Header from "../../../components/Header";
import {
  Download,
  FileText,
  CheckCircle2,
  Clock,
  AlertCircle,
  Calendar,
  DollarSign,
  Activity,
  User,
  Eye,
  Mail,
  Globe,
  RefreshCw,
  Search,
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

const ITEMS_PER_PAGE = 10;

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
    const due = new Date(dueDate);
    const now = new Date();
    if (!Number.isNaN(due.getTime()) && due < now) {
      return "overdue";
    }
  }

  return "open";
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
    privateNote: invoice?.PrivateNote || invoice?.privateNote || "",
    email: invoice?.BillEmail?.Address || invoice?.email || "",
    terms: invoice?.SalesTermRef?.name || invoice?.terms || "",
    currency: invoice?.CurrencyRef?.name || invoice?.currency || "USD",
    raw: invoice,
  };
}

function filterInvoices(invoices, filters) {
  const {
    searchTerm,
    statusFilter,
    dateFilter,
    customerFilter,
    startDate,
    endDate,
  } = filters;
  const term = String(searchTerm || "")
    .trim()
    .toLowerCase();
  const now = new Date();

  return invoices.filter((invoice) => {
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
    const invoiceDate = invoice.date ? new Date(invoice.date) : null;
    const validInvoiceDate =
      invoiceDate && !Number.isNaN(invoiceDate.getTime()) ? invoiceDate : null;

    if (dateFilter === "this-month" && validInvoiceDate) {
      matchesDate =
        validInvoiceDate.getFullYear() === now.getFullYear() &&
        validInvoiceDate.getMonth() === now.getMonth();
    } else if (dateFilter === "last-month" && validInvoiceDate) {
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      matchesDate =
        validInvoiceDate.getFullYear() === lastMonthDate.getFullYear() &&
        validInvoiceDate.getMonth() === lastMonthDate.getMonth();
    } else if (dateFilter === "custom") {
      if (
        startDate &&
        (!validInvoiceDate || validInvoiceDate < new Date(startDate))
      ) {
        matchesDate = false;
      }

      if (endDate) {
        const inclusiveEnd = new Date(endDate);
        inclusiveEnd.setHours(23, 59, 59, 999);
        if (!validInvoiceDate || validInvoiceDate > inclusiveEnd) {
          matchesDate = false;
        }
      }
    }

    return matchesSearch && matchesStatus && matchesCustomer && matchesDate;
  });
}

function statusConfig(status) {
  const configs = {
    paid: {
      label: "Paid",
      icon: CheckCircle2,
      color: "bg-[#8bc53d] text-white border-transparent",
    },
    open: {
      label: "Open",
      icon: Clock,
      color: "bg-[#00648F] text-white border-transparent",
    },
    overdue: {
      label: "Overdue",
      icon: AlertCircle,
      color: "bg-[#C62026] text-white border-transparent",
    },
    draft: {
      label: "Draft",
      icon: FileText,
      color: "bg-[#6D6E71] text-white border-transparent",
    },
  };

  return configs[String(status || "draft").toLowerCase()] || configs.draft;
}

function SkeletonTable() {
  return (
    <div className="card-base overflow-hidden">
      <div className="overflow-x-auto min-h-[500px]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              {[
                "Invoice & Date",
                "Client",
                "Due Date",
                "Amount",
                "Balance",
                "Status",
                "Actions",
              ].map((label) => (
                <th
                  key={label}
                  className="px-4 py-3 text-left text-[14px] font-medium text-text-muted"
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {Array.from({ length: 8 }).map((_, index) => (
              <tr key={index}>
                <td colSpan={7} className="px-6 py-4">
                  <div className="h-10 animate-pulse rounded-md bg-bg-page" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pagination({ currentPage, totalPages, onPageChange, className = "" }) {
  if (totalPages <= 1) return null;

  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <p className="text-[13px] text-text-muted">
        Page {currentPage} of {totalPages}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className="rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function AdvancedFilterToolbar({
  placeholder,
  onSearch,
  onFilterChange,
  onReset,
  statusOptions,
  dateOptions,
  showCustomerFilter,
  customerOptions,
}) {
  const [localSearch, setLocalSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [date, setDate] = useState("all");
  const [customer, setCustomer] = useState("all");

  return (
    <div className="card-base p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative w-full lg:max-w-md">
          <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center">
            <Search size={16} className="text-text-muted" />
          </div>
          <input
            type="text"
            value={localSearch}
            onChange={(event) => {
              const value = event.target.value;
              setLocalSearch(value);
              onSearch(value);
            }}
            placeholder={placeholder}
            className="h-10 w-full rounded-md border border-border-input bg-bg-card pl-10 pr-3 text-[14px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <select
            value={status}
            onChange={(event) => {
              const value = event.target.value;
              setStatus(value);
              onFilterChange("status", value);
            }}
            className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary"
          >
            <option value="all">All Statuses</option>
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            value={date}
            onChange={(event) => {
              const value = event.target.value;
              setDate(value);
              onFilterChange("date", value);
            }}
            className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary"
          >
            <option value="all">All Dates</option>
            {dateOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          {showCustomerFilter ? (
            <select
              value={customer}
              onChange={(event) => {
                const value = event.target.value;
                setCustomer(value);
                onFilterChange("customer", value);
              }}
              className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary"
            >
              <option value="all">All Clients</option>
              {customerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : null}

          <button onClick={onReset} className="btn-secondary h-10 px-4">
            Reset
          </button>
        </div>
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-[18px] font-semibold text-text-primary">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-text-muted transition-colors hover:bg-bg-page hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {fields.map((field) => {
            const Icon = field.icon;
            const value = formData?.[field.name] ?? "";

            return (
              <div key={field.name} className="space-y-1.5">
                <label className="flex items-center gap-2 text-[13px] font-medium text-text-primary">
                  {Icon ? <Icon size={15} className="text-text-muted" /> : null}
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
                    className="h-10 w-full rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary"
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
                    className="w-full rounded-md border border-border-input bg-bg-card px-3 py-2 text-[14px] text-text-primary"
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
                    className="h-10 w-full rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary"
                  />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
          <button onClick={onClose} className="btn-secondary">
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
            className={cn("btn-primary", isSaving && "cursor-wait opacity-80")}
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
      } catch (error) {
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

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);

  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

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

  const handleUpdateInvoice = async (formData) => {
    if (!editingInvoice) return;

    try {
      const status = await getConnectionStatus();
      if (!status?.isConnected) {
        alert("Please connect to QuickBooks");
        throw new Error("Please connect to QuickBooks");
      }
    } catch (error) {
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
          ? {
            ...invoice,
            invoiceNumber: updatedInvoice?.DocNumber || formData.docNumber,
            dueDate: updatedInvoice?.DueDate || formData.dueDate,
            privateNote: updatedInvoice?.PrivateNote || formData.privateNote,
          }
          : invoice,
      ),
    );
  };

  const filteredInvoices = useMemo(
    () =>
      filterInvoices(invoices, {
        searchTerm,
        statusFilter,
        dateFilter,
        customerFilter,
        startDate,
        endDate,
      }),
    [
      customerFilter,
      dateFilter,
      endDate,
      invoices,
      searchTerm,
      startDate,
      statusFilter,
    ],
  );

  const totalPages = Math.max(
    1,
    Math.ceil(filteredInvoices.length / ITEMS_PER_PAGE),
  );
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const paginatedInvoices = filteredInvoices.slice(
    startIndex,
    startIndex + ITEMS_PER_PAGE,
  );

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(1);
    }
  }, [currentPage, totalPages]);

  const handleExportCSV = () => {
    exportToCSV(
      filteredInvoices,
      [
        "Invoice Number",
        "Client",
        "Date",
        "Due Date",
        "Status",
        "Total Amount",
        "Balance Due",
      ],
      "invoices_export",
      (invoice) => [
        invoice.invoiceNumber,
        invoice.customer,
        invoice.date,
        invoice.dueDate,
        invoice.status,
        invoice.amount,
        invoice.balance,
      ],
    );
  };

  return (
    <>
      <Header title="Invoices" />
      <div className="flex-1 space-y-5 p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-[24px] font-bold text-text-primary">Invoices</h1>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="btn-secondary"
            >
              <RefreshCw
                size={16}
                className={isSyncing ? "animate-spin" : ""}
              />
              {isSyncing ? "Syncing..." : "Sync"}
            </button>
            <button onClick={handleExportCSV} className="btn-secondary">
              <Download size={16} className="text-text-muted" />
              Export Ledger
            </button>
          </div>
        </div>

        <QBDisconnectedBanner pageName="Client Invoices" />

        <AdvancedFilterToolbar
          placeholder="Search by invoice # or client..."
          onSearch={setSearchTerm}
          onFilterChange={(key, value) => {
            if (key === "status") setStatusFilter(value);
            if (key === "date") setDateFilter(value);
            if (key === "customer") setCustomerFilter(value);
            setCurrentPage(1);
          }}
          onReset={() => {
            setSearchTerm("");
            setStatusFilter("all");
            setDateFilter("all");
            setStartDate("");
            setEndDate("");
            setCustomerFilter("all");
            setCurrentPage(1);
          }}
          statusOptions={[
            { label: "Paid", value: "paid" },
            { label: "Open", value: "open" },
            { label: "Overdue", value: "overdue" },
            { label: "Draft", value: "draft" },
          ]}
          dateOptions={[
            { label: "This Month", value: "this-month" },
            { label: "Last Month", value: "last-month" },
            { label: "Custom Range", value: "custom" },
          ]}
          showCustomerFilter={true}
          customerOptions={customers.map((customer) => ({
            label: customer.name,
            value: customer.name,
          }))}
        />

        {dateFilter === "custom" ? (
          <div className="card-base animate-in fade-in slide-in-from-top-2 flex items-center gap-4 p-4">
            <div className="flex items-center gap-2">
              <span className="text-[14px] text-text-muted">From:</span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[14px] text-text-muted">To:</span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 rounded-md border border-border-input bg-bg-card px-3 text-[14px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <SkeletonTable />
        ) : error && invoices.length === 0 ? (
          <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 p-6 font-medium text-red-600">
            <AlertCircle size={20} />
            {error}
          </div>
        ) : (
          <div className="card-base overflow-hidden">
            <div className="min-h-[500px] overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-6 py-3 text-left text-[14px] font-medium text-text-muted">
                      Invoice & Date
                    </th>
                    <th className="px-4 py-3 text-left text-[14px] font-medium text-text-muted">
                      Client
                    </th>
                    <th className="px-4 py-3 text-left text-[14px] font-medium text-text-muted">
                      Due Date
                    </th>
                    <th className="px-4 py-3 text-right text-[14px] font-medium text-text-muted">
                      Amount
                    </th>
                    <th className="px-4 py-3 text-right text-[14px] font-medium text-text-muted">
                      Balance
                    </th>
                    <th className="px-4 py-3 text-center text-[14px] font-medium text-text-muted">
                      Status
                    </th>
                    <th className="w-32 px-4 py-3 text-right text-[14px] font-medium text-text-muted">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paginatedInvoices.length > 0 ? (
                    paginatedInvoices.map((invoice) => {
                      const status = statusConfig(invoice.status);
                      const StatusIcon = status.icon;

                      return (
                        <tr
                          key={invoice.id}
                          className="group transition-colors duration-200 hover:bg-bg-page/50"
                        >
                          <td className="px-6 py-3">
                            <div className="flex flex-col">
                              <span className="text-[14px] font-medium text-text-primary">
                                #{invoice.invoiceNumber}
                              </span>
                              <span className="text-[12px] text-text-muted">
                                {invoice.date
                                  ? new Date(invoice.date).toLocaleDateString(
                                    "en-US",
                                    {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    },
                                  )
                                  : "N/A"}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-[14px] text-text-secondary">
                              {invoice.customer}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                "text-[14px] text-text-secondary",
                                invoice.status === "overdue" &&
                                "font-medium text-negative",
                              )}
                            >
                              {invoice.dueDate
                                ? new Date(invoice.dueDate).toLocaleDateString(
                                  "en-US",
                                  {
                                    month: "short",
                                    day: "numeric",
                                  },
                                )
                                : "N/A"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            <span className="text-[14px] font-medium text-text-primary">
                              {formatCurrency(invoice.amount)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            <span
                              className={cn(
                                "text-[14px] font-medium",
                                invoice.balance > 0
                                  ? "text-text-primary"
                                  : "text-text-muted",
                              )}
                            >
                              {formatCurrency(invoice.balance)}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div
                              className={cn(
                                "inline-flex min-w-[80px] items-center justify-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-bold capitalize",
                                status.color,
                              )}
                            >
                              <StatusIcon size={12} />
                              {status.label}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={async () => {
                                setIsDetailLoading(true);
                                try {
                                  const response = await getInvoiceByDocNumber(
                                    invoice.invoiceNumber,
                                  );
                                  const detail = response?.data || response;
                                  const matchingCustomer = customers.find(
                                    (customer) =>
                                      customer.name === invoice.customer,
                                  );

                                  setEditingInvoice({
                                    ...invoice,
                                    ...detail,
                                    docNumber:
                                      detail?.DocNumber ||
                                      invoice.invoiceNumber,
                                    privateNote:
                                      detail?.PrivateNote ||
                                      invoice.privateNote ||
                                      "",
                                    customerId:
                                      invoice.customerId ||
                                      detail?.CustomerRef?.value ||
                                      matchingCustomer?.id ||
                                      matchingCustomer?.Id ||
                                      "",
                                    email: detail?.BillEmail?.Address || "N/A",
                                    terms: detail?.SalesTermRef?.name || "N/A",
                                    currency:
                                      detail?.CurrencyRef?.name || "USD",
                                    txnDate: detail?.TxnDate || invoice.date,
                                    totalAmt:
                                      detail?.TotalAmt || invoice.amount,
                                    balance: detail?.Balance || invoice.balance,
                                    status: invoice.status,
                                  });
                                  setIsEditModalOpen(true);
                                } catch (error) {
                                  console.error(
                                    "Failed to load invoice detail:",
                                    error,
                                  );
                                  alert(
                                    error.message ||
                                    "Could not load invoice details.",
                                  );
                                } finally {
                                  setIsDetailLoading(false);
                                }
                              }}
                              disabled={isDetailLoading}
                              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-4 py-1.5 text-[12px] font-semibold text-text-primary shadow-sm transition-all hover:border-primary/30 hover:bg-bg-page disabled:opacity-50"
                            >
                              <Eye size={14} className="text-text-muted" />
                              <span>Doc</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={7} className="py-20 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <p className="text-[14px] font-semibold text-text-primary">
                            No Invoices Found
                          </p>
                          <p className="text-[12px] text-text-muted">
                            Adjust your filters to refine the search
                          </p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border bg-bg-page/30 p-4">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setCurrentPage}
                className="border-0 bg-transparent"
              />
            </div>
          </div>
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
            icon: Activity,
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
