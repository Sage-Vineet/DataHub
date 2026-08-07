import { useState } from 'react';
import { useParams } from 'react-router-dom';
import GroupMessagesWorkspace from '../../../components/messages/GroupMessagesWorkspace';
import DirectMessagesWorkspace from '../../../components/messages/DirectMessagesWorkspace';

export default function WorkspaceMessages() {
  const { clientId } = useParams();
  const [tab, setTab] = useState('groups');

  return (
    <div className="flex flex-col h-full min-h-0" style={{ height: 'calc(100vh - 130px)' }}>
      {tab === 'groups'
        ? <GroupMessagesWorkspace companyId={clientId} title="Groups" tab={tab} onTabChange={setTab} />
        : <DirectMessagesWorkspace companyId={clientId} title="Chats" tab={tab} onTabChange={setTab} />
      }
    </div>
  );
}
