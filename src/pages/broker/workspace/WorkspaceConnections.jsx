import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { getCompanyRequest } from "../../../lib/api";
import Header from "../../../components/Header";
import QuickBooksConnection from "../../../components/quickbooks/QuickBooksConnection";

export default function WorkspaceConnections() {
  const { clientId } = useParams();
  const [company, setCompany] = useState(null);

  // Load workspace company info to pass to the connection component
  useEffect(() => {
    if (clientId) {
      getCompanyRequest(clientId)
        .then(setCompany)
        .catch(() => setCompany(null));
    }
  }, [clientId]);

  return (
    <>
      <Header title="Connections" />
      <div className="flex-1 p-6 space-y-5">
        <h1 className="text-[24px] font-bold text-text-primary">
          Manage Connection
        </h1>

        <QuickBooksConnection company={company} />
      </div>
    </>
  );
}
