import { useParams } from "react-router-dom";
import CompanyDirectMessagesWorkspace from "../../../components/messages/CompanyDirectMessagesWorkspace";

export default function WorkspaceMessages() {
  const { clientId } = useParams();

  return (
    <CompanyDirectMessagesWorkspace
      fixedCompanyId={clientId}
      title="Messages"
      contactLabel="Assigned Contacts"
      contactEmptyState="No assigned users or client contact are available for this company."
    />
  );
}
