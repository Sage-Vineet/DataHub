"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  LoaderCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { getStoredToken } from "../lib/api";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const EXTRACT_BANK_PDF_RECORDS_ENDPOINT = `${API_BASE_URL}/api/extract-bank-pdf-records`;

const fmtPdfAmt = (val) => {
  const num = Number(val);
  if (!Number.isFinite(num)) return "-";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
};

const getErrMsg = (e) => (e instanceof Error ? e.message : String(e));

export default function ExtractedBankRecords({ clientId }) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedBanks, setExpandedBanks] = useState({});
  const [expandedAccounts, setExpandedAccounts] = useState({});
  const [expandedStatements, setExpandedStatements] = useState({});

  console.log("ExtractedBankRecords render - state:", {
    data,
    isLoading,
    error,
    clientId,
  });

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError("");
      try {
        const token = getStoredToken();
        const headers = {
          ...(token
            ? {
              Authorization: `Bearer ${token}`,
              "X-Access-Token": token,
              "X-Auth-Token": token,
              "X-Token": token,
            }
            : {}),
          ...(clientId ? { "X-Client-Id": clientId } : {}),
        };
        console.log("Fetching with headers:", headers);

        const resp = await fetch(EXTRACT_BANK_PDF_RECORDS_ENDPOINT, {
          cache: "no-store",
          headers,
        });
        const result = await resp.json();
        console.log("ExtractedBankRecords fetch result:", result);
        if (!resp.ok) throw new Error(result?.error || `HTTP ${resp.status}`);

        setData(result);
        console.log("Data set successfully:", result);

        // Auto-expand first bank
        if (result?.banks?.[0]) {
          const bankKey = `bank-${0}`;
          setExpandedBanks({ [bankKey]: true });
          console.log("Expanded first bank:", bankKey);
        }
      } catch (e) {
        console.error("Error fetching extracted bank records:", e);
        setError(getErrMsg(e));
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, [clientId]);

  const toggleBank = (bankIndex) => {
    const key = `bank-${bankIndex}`;
    setExpandedBanks((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const toggleAccount = (bankIndex, accountIndex) => {
    const key = `bank-${bankIndex}-account-${accountIndex}`;
    setExpandedAccounts((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const toggleStatement = (bankIndex, accountIndex, statementIndex) => {
    const key = `bank-${bankIndex}-account-${accountIndex}-statement-${statementIndex}`;
    setExpandedStatements((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  if (isLoading) {
    return (
      <section className="card-base card-p w-full">
        <div className="mb-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            Extracted Bank PDF Records
          </h2>
          <p className="text-[14px] text-text-secondary">
            Bank transaction data extracted from PDF statements.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-dashed border-border bg-bg-page/40 p-8 text-[14px] text-text-muted">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          Loading bank records...
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="card-base card-p w-full">
        <div className="mb-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            Extracted Bank PDF Records
          </h2>
          <p className="text-[14px] text-text-secondary">
            Bank transaction data extracted from PDF statements.
          </p>
        </div>
        <div className="flex items-start gap-3 rounded-2xl border border-dashed border-red-200 bg-red-50 p-4 text-[14px] text-red-600">
          <AlertCircle className="h-5 w-5 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Error loading bank records</p>
            <p className="mt-1 text-[13px]">{error}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!data?.banks || data.banks.length === 0) {
    return (
      <section className="card-base card-p w-full">
        <div className="mb-5">
          <h2 className="text-[18px] font-semibold text-text-primary">
            Extracted Bank PDF Records
          </h2>
          <p className="text-[14px] text-text-secondary">
            Bank transaction data extracted from PDF statements.
          </p>
        </div>
        <div className="rounded-2xl border border-dashed border-border bg-bg-page/40 p-6 text-center text-[14px] text-text-muted">
          No bank records found.
        </div>
      </section>
    );
  }
}
