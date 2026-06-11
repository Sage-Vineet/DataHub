import { useState } from 'react';
import GroupMessagesWorkspace from '../../components/messages/GroupMessagesWorkspace';
import DirectMessagesWorkspace from '../../components/messages/DirectMessagesWorkspace';

export default function ClientMessages() {
  const [tab, setTab] = useState('groups');

  return (
    <div className="flex flex-col h-full min-h-0" style={{ height: 'calc(100vh - 130px)' }}>
      {tab === 'groups'
        ? <GroupMessagesWorkspace useMyGroups title="Groups" tab={tab} onTabChange={setTab} />
        : <DirectMessagesWorkspace useMyContacts title="Chats" tab={tab} onTabChange={setTab} />
      }
    </div>
  );
}
