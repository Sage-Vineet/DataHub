import QuickBooksConnection from "../../components/quickbooks/QuickBooksConnection";
import { useAuth } from "../../context/AuthContext";

export default function ClientConnections() {
  const { user } = useAuth();

  // Create a minimal company object for the connection component
  const company = {
    id: user?.company_id || (user?.companyIds && user.companyIds[0]),
    name: user?.company || "Your Company"
  };

  return (
    <div className="flex-1 p-0 space-y-5">
      <h1 className="text-[24px] font-bold text-text-primary">
        QuickBooks Connection
      </h1>

      <QuickBooksConnection company={company} />
    </div>
  );
}
