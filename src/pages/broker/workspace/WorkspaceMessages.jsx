import { useState } from "react";
import { useParams } from "react-router-dom";
import { MessageSquare, Users } from "lucide-react";
import GroupMessagesWorkspace from "../../../components/messages/GroupMessagesWorkspace";
import CompanyDirectMessagesWorkspace from "../../../components/messages/CompanyDirectMessagesWorkspace";

export default function WorkspaceMessages() {
  const { clientId } = useParams();
  const [tab, setTab] = useState("groups"); // "groups" | "direct"

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
          <GroupMessagesWorkspace companyId={clientId} title="Group Messages" />
        ) : (
          <CompanyDirectMessagesWorkspace
            fixedCompanyId={clientId}
            title="Direct Messages"
            contactLabel="Assigned Contacts"
            contactEmptyState="No assigned users or client contact are available for this company."
          />
        )}
      </div>
    </div>
  );
}
