import { useState } from 'react';
import GroupMessagesWorkspace from '../../components/messages/GroupMessagesWorkspace';
import DirectMessagesWorkspace from '../../components/messages/DirectMessagesWorkspace';

export default function ClientMessages() {
  const [tab, setTab] = useState('groups');

  return (
    <div className="flex flex-col h-full min-h-0" style={{ height: 'calc(100vh - 130px)' }}>
      <MessagesTabBar tab={tab} onTabChange={setTab} />
      <div className="flex-1 min-h-0 pt-3">
        {tab === 'groups'
          ? <GroupMessagesWorkspace useMyGroups title="Groups" />
          : <DirectMessagesWorkspace useMyContacts title="Chats" />
        }
      </div>
    </div>
  );
}

function MessagesTabBar({ tab, onTabChange }) {
  return (
    <div className="flex-shrink-0 flex items-center gap-1 p-1 bg-[#F0F2F5] rounded-full w-fit">
      <TabButton label="Groups" value="groups" active={tab === 'groups'} onClick={onTabChange} />
      <TabButton label="Chats" value="chats" active={tab === 'chats'} onClick={onTabChange} />
    </div>
  );
}

function TabButton({ label, value, active, onClick }) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-5 py-1.5 rounded-full text-[13px] font-semibold transition-all ${
        active
          ? 'bg-white text-[#05164D] shadow-sm'
          : 'text-gray-500 hover:text-[#05164D]'
      }`}
    >
      {label}
    </button>
  );
}
