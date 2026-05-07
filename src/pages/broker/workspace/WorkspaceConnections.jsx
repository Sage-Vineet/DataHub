import { useEffect, useState, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { getCompanyRequest } from "../../../lib/api";
import Header from "../../../components/Header";
import QuickBooksConnection from "../../../components/quickbooks/QuickBooksConnection";
import ManualGLUpload from "../../../components/manual-gl/ManualGLUpload";
import { cn } from "../../../lib/utils";

export default function WorkspaceConnections() {
  const { clientId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [company, setCompany] = useState(null);

  const CONNECTION_TABS = useMemo(
    () => [
      { key: "quickbooks", label: "QuickBooks Online" },
      { key: "manual", label: "Manual GL Upload" },
    ],
    []
  );

  const selectedTab = searchParams.get("source") === "manual" ? "manual" : "quickbooks";

  const handleTabChange = (key) => {
    setSearchParams({ source: key });
  };

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
        </div>
      </div>
    </div>
  );
}
