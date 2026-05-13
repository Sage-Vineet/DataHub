import { useEffect, useState, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  getCompanyRequest,
  setSelectedReportSource,
} from "../../../lib/api";
import Header from "../../../components/Header";
import QuickBooksConnection from "../../../components/quickbooks/QuickBooksConnection";
import ManualGLUpload from "../../../components/manual-gl/ManualGLUpload";
import ManualFolderReportsUpload from "../../../components/manual-reports/ManualFolderReportsUpload";
import { cn } from "../../../lib/utils";
import { REPORT_SOURCE_KEYS } from "../../../lib/report-source";

export default function WorkspaceConnections() {
  const { clientId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [company, setCompany] = useState(null);

  const CONNECTION_TABS = useMemo(
    () => [
      { key: "quickbooks", label: "QuickBooks Online" },
      { key: "manual", label: "Manual GL Upload" },
      { key: "manual-reports", label: "Manual Upload (Excel or PDF)" },
      { key: "quickbooks-manual", label: "Quickbooks (Manual Upload)" },
    ],
    []
  );

  const selectedTab = CONNECTION_TABS.some(
    (tab) => tab.key === searchParams.get("source"),
  )
    ? searchParams.get("source")
    : "quickbooks";

  const handleTabChange = (key) => {
    setSearchParams({ source: key });
  };

  useEffect(() => {
    if (!clientId) return;
    const sourceKey =
      selectedTab === "manual"
        ? REPORT_SOURCE_KEYS.MANUAL_GL
        : selectedTab === "manual-reports" || selectedTab === "quickbooks-manual"
          ? REPORT_SOURCE_KEYS.MANUAL_UPLOAD
        : REPORT_SOURCE_KEYS.QUICKBOOKS;

    setSelectedReportSource(sourceKey, { clientId }).catch((error) => {
      console.error("[WorkspaceConnections] Failed to sync report source:", error);
    });
  }, [clientId, selectedTab]);

  // Load workspace company info to pass to the connection component
  useEffect(() => {
    if (clientId) {
      getCompanyRequest(clientId)
        .then(setCompany)
        .catch(() => setCompany(null));
    }
  }, [clientId]);

  return (
    <div className="page-container flex flex-col h-full">
      <Header title="Connections" />
      <div className="page-content flex-1 p-6 space-y-5">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-[24px] font-bold text-[#050505]">
            Manage Connection
          </h1>
        </div>

        <div className="mb-6 flex gap-6 border-b border-border pb-px">
          {CONNECTION_TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={cn(
                "relative pb-3 text-[14px] font-medium transition-all",
                selectedTab === tab.key
                  ? "font-semibold text-text-primary after:absolute after:bottom-[-1px] after:left-0 after:h-[2px] after:w-full after:rounded-full after:bg-primary after:content-['']"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
          {selectedTab === "quickbooks" && (
            <QuickBooksConnection company={company} />
          )}
          {selectedTab === "manual" && (
            <ManualGLUpload companyId={clientId} />
          )}
          {selectedTab === "manual-reports" && (
            <ManualFolderReportsUpload companyId={clientId} />
          )}
          {selectedTab === "quickbooks-manual" && (
            <ManualFolderReportsUpload
              companyId={clientId}
              title="Quickbooks (Manual Upload)"
              description="Select a Data Room folder that contains QuickBooks-exported Balance Sheet, Profit & Loss, and Cash Flow files."
            />
          )}
        </div>
      </div>
    </div>
  );
}
