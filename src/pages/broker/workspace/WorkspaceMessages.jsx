import { useState } from "react";
import { useParams } from "react-router-dom";
import { MessageSquare, Users } from "lucide-react";
import GroupMessagesWorkspace from "../../../components/messages/GroupMessagesWorkspace";
import CompanyDirectMessagesWorkspace from "../../../components/messages/CompanyDirectMessagesWorkspace";

export default function WorkspaceMessages() {
  const { clientId } = useParams();
  const [tab, setTab] = useState("groups");

  const toggle = (
    <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5 self-start">
      <button
        onClick={() => setTab("groups")}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
          tab === "groups"
            ? "bg-white text-[#05164D] shadow-sm"
            : "text-gray-400 hover:text-[#05164D]"
        }`}
      >
        <Users size={11} />
        Groups
      </button>
      <button
        onClick={() => setTab("direct")}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-all ${
          tab === "direct"
            ? "bg-white text-[#05164D] shadow-sm"
            : "text-gray-400 hover:text-[#05164D]"
        }`}
      >
        <MessageSquare size={11} />
        Direct
      </button>
    </div>
  );

  return (
    <div className="h-full min-h-0" style={{ height: "calc(100vh - 220px)" }}>
      {tab === "groups" ? (
        <GroupMessagesWorkspace
          companyId={clientId}
          headerSlot={toggle}
        />
      ) : (
        <CompanyDirectMessagesWorkspace
          fixedCompanyId={clientId}
          showPageHeader={false}
          headerSlot={toggle}
          contactLabel="Assigned Contacts"
          contactEmptyState="No assigned users or client contacts are available for this company."
        />
      )}
    </div>
  );
}
