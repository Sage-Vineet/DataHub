import Navbar from './Navbar';

export default function BrokerLayout({ children }) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-page text-text-primary">
      <Navbar onMenuClick={() => {}} />
      <main className="flex-1 overflow-y-auto bg-bg-page p-4 lg:p-6 scrollbar-thin">
        <div className="animate-fadeIn mx-auto max-w-screen-2xl">
          {children}
        </div>
      </main>
    </div>
  );
}
