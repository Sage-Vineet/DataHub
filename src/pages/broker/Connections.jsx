import { CheckCircle2, Clock3, Link2, ShieldAlert } from 'lucide-react';
import { buildConnectionCards } from '../../lib/dataHub';

const connectionCards = buildConnectionCards();

export default function BrokerConnections() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Connections</h1>
        <p className="mt-0.5 text-sm text-[#6D6E71]">Data Hub connection status has been merged into the broker workspace as a dedicated overview.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {connectionCards.map((card) => {
          const Icon = card.status === 'Connected'
            ? CheckCircle2
            : card.status === 'Pending setup'
              ? Clock3
              : ShieldAlert;

          return (
            <div key={card.id} className="rounded-2xl bg-white p-5 shadow-card">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#F4F8EC]">
                  <Link2 size={20} className="text-[#476E2C]" />
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  card.status === 'Connected'
                    ? 'bg-[#E8F3D8] text-[#476E2C]'
                    : card.status === 'Pending setup'
                      ? 'bg-[#FFF1E2] text-[#b45e08]'
                      : 'bg-[#FDECEC] text-[#C62026]'
                }`}>
                  {card.status}
                </span>
              </div>
              <h2 className="text-lg font-semibold text-[#050505]">{card.name}</h2>
              <p className="mt-2 text-sm leading-6 text-[#6D6E71]">{card.detail}</p>
              <div className="mt-5 flex items-center gap-2 text-sm font-medium text-[#6D6E71]">
                <Icon size={15} />
                {card.lastChecked}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-2xl border border-[#F68C1F]/20 bg-[#FFF8F0] p-5">
        <h2 className="text-lg font-semibold text-[#050505]">About this merge</h2>
        <p className="mt-2 text-sm leading-6 text-[#6D6E71]">
          The navigation, finance-facing pages, and dashboard insights from Data Hub are now part of the Leo broker app. Existing broker, company, reminder, and client workspace logic remains in place, and any future external accounting integrations can be wired into this screen without changing the merged UI structure.
        </p>
      </div>
    </div>
  );
}
