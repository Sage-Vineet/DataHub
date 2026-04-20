import { useParams } from "react-router-dom";
import CompanyDirectMessagesWorkspace from "../../../components/messages/CompanyDirectMessagesWorkspace";

export default function WorkspaceMessages() {
  const { clientId } = useParams();

  return (
    <CompanyDirectMessagesWorkspace
      fixedCompanyId={clientId}
      title="Messages"
      description="Message the assigned users and client contact for this company in separate one-to-one conversations."
      contactLabel="Assigned Contacts"
      contactEmptyState="No assigned users or client contact are available for this company."
    />
  );
}
