import { useState } from "react";
import { MessageSquare, Users } from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import GroupMessagesWorkspace from "../../components/messages/GroupMessagesWorkspace";
import CompanyDirectMessagesWorkspace from "../../components/messages/CompanyDirectMessagesWorkspace";

export default function ClientMessages() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0] || "";
  const [tab, setTab] = useState("groups");

  return (
    <div className="flex flex-col h-full min-h-0 space-y-4">
      {/* Tab switcher */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 self-start">
        <button
          onClick={() => setTab("groups")}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            tab === "groups"
              ? "bg-white text-[#05164D] shadow-sm"
              : "text-gray-500 hover:text-[#05164D]"
          }`}
        >
          <Users size={15} />
          Group Messages
        </button>
        <button
          onClick={() => setTab("direct")}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
            tab === "direct"
              ? "bg-white text-[#05164D] shadow-sm"
              : "text-gray-500 hover:text-[#05164D]"
          }`}
        >
          <MessageSquare size={15} />
          Direct Messages
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0" style={{ height: "calc(100vh - 220px)" }}>
        {tab === "groups" ? (
          <GroupMessagesWorkspace
            useMyGroups
            title="Group Messages"
          />
        ) : (
          <CompanyDirectMessagesWorkspace
            fixedCompanyId={companyId}
            title="Direct Messages"
            description="Message your broker directly for this company."
            contactLabel="Broker"
            contactEmptyState="No broker is available for this company right now."
          />
        )}
      </div>
    </div>
  );
}
