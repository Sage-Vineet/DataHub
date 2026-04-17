import { useParams } from "react-router-dom";
import MessagesWorkspace from "../../../components/messages/MessagesWorkspace";

export default function WorkspaceMessages() {
  const { clientId } = useParams();

  return (
    <MessagesWorkspace
      fixedCompanyId={clientId}
      title="Messages"
      description="Collaborate with the broker team, assigned users, and the client contact for this company."
    />
  );
}
