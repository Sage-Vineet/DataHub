import { useState } from 'react';
import UserSidebar from './UserSidebar';
import UserNavbar from './UserNavbar';

export default function UserLayout({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-[#F6F7FB] text-text-primary">
      <div className="hidden lg:flex flex-shrink-0">
        <UserSidebar />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-[#05164D]/40 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 h-full w-[240px] animate-slideIn">
            <UserSidebar onClose={() => setSidebarOpen(false)} />
          </div>
        </div>
      )}

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <UserNavbar onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="mx-auto max-w-7xl animate-fadeIn">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
