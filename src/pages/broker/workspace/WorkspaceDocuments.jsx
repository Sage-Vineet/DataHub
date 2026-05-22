import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import { getCompanyRequest } from '../../../lib/api';
import FileExplorer from '../../../components/fileExplorer/FileExplorer';

export default function WorkspaceDocuments() {
  const { clientId } = useParams();
  const { user } = useAuth();
  const [company, setCompany] = useState(null);

  useEffect(() => {
    if (!clientId) return;
    getCompanyRequest(clientId).then(setCompany).catch(() => setCompany(null));
  }, [clientId]);
  return (
    <div className="-m-4 lg:-m-6 h-[calc(100vh-4rem)]">
      <FileExplorer
        role="broker"
        title={`${company?.name || 'Client'} Documents`}
        companyId={clientId}
        currentUserId={user?.id}
      />
    </div>
  );
}
