import { useAuth } from "../../context/AuthContext";
import CompanyDirectMessagesWorkspace from "../../components/messages/CompanyDirectMessagesWorkspace";

export default function UserMessages() {
  const { user } = useAuth();
  const companyOptions = (user?.assignedCompanies || user?.assigned_companies || [])
    .map((company) => ({
      id: company.id,
      name: company.name,
      industry: company.industry,
    }))
    .filter((company) => company.id);

  return (
    <CompanyDirectMessagesWorkspace
      title="Messages"
      description="Select one of your assigned companies and message the broker in a direct conversation."
      companyOptions={companyOptions}
      companyPlaceholder="Select one of your assigned companies to see broker conversations."
      companyEmptyState="No companies are assigned to your account yet."
      contactLabel="Broker"
      contactEmptyState="No broker is available for this company right now."
      singleListMode
      singleListEmptyState="No broker conversations are available for your assigned companies."
    />
  );
}
