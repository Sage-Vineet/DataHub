import { useAuth } from "../../context/AuthContext";
import MessagesWorkspace from "../../components/messages/MessagesWorkspace";

export default function ClientMessages() {
  const { user } = useAuth();
  const companyId = user?.company_id || user?.companyId || user?.company_ids?.[0] || user?.companyIds?.[0] || "";

  return (
    <MessagesWorkspace
      fixedCompanyId={companyId}
      title="Messages"
      description="Coordinate with your broker and assigned users for this company."
    />
  );
}
