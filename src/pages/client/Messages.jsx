import { useAuth } from "../../context/AuthContext";
import CompanyDirectMessagesWorkspace from "../../components/messages/CompanyDirectMessagesWorkspace";

export default function ClientMessages() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0] || "";

  return (
    <CompanyDirectMessagesWorkspace
      fixedCompanyId={companyId}
      title="Messages"
      description="Message your broker directly for this company."
      contactLabel="Broker"
      contactEmptyState="No broker is available for this company right now."
    />
  );
}
