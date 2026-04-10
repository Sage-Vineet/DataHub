import { useParams } from 'react-router-dom';
import {
  Upload, Send, CheckCircle, Bell, FileText, Clock
} from 'lucide-react';
import { activities, requests, documents, reminders, companies } from '../../../data/mockData';

const iconMap = { Upload, Send, CheckCircle, Bell, FileText, Clock };
const colorMap = {
  upload:   { bg: '#DBEAFE', color: '#00648F' },
  request:  { bg: '#FEF3C7', color: '#F68C1F' },
  approved: { bg: '#DCFCE7', color: '#476E2C' },
  reminder: { bg: '#F3E8FF', color: '#742982' },
};

export default function WorkspaceActivity() {
  const { clientId } = useParams();
  const company = companies.find(c => c.id === clientId);

  // Build a timeline from requests, documents, reminders for this client
  const timeline = [
    ...requests
      .filter(r => r.companyId === clientId)
      .map(r => ({
        id: `req-${r.id}`,
        type: 'request',
        message: `Request "${r.name}" created`,
        detail: `Type: ${r.type} · Priority: ${r.priority}`,
        date: r.createdAt,
        icon: Send,
      })),
    ...documents
      .filter(d => d.company === company?.name)
      .map(d => ({
        id: `doc-${d.id}`,
        type: 'upload',
        message: `Document "${d.name}" received`,
        detail: `Folder: ${d.folder} · Size: ${d.size}`,
        date: d.uploadedAt,
        icon: Upload,
      })),
    ...reminders
      .filter(r => r.companyId === clientId)
      .map(r => ({
        id: `rem-${r.id}`,
        type: 'reminder',
        message: r.title,
        detail: r.message,
        date: r.createdAt,
        icon: Bell,
      })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#050505]">Activity Log</h1>
        <p className="text-sm text-[#6D6E71] mt-0.5">Full audit trail for {company?.name}</p>
      </div>

      <div className="bg-white rounded-2xl shadow-card overflow-hidden">
        {timeline.length === 0 ? (
          <div className="py-16 text-center">
            <Clock size={36} className="mx-auto mb-3 text-gray-200" />
            <p className="text-sm text-[#A5A5A5]">No activity yet for this client.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {timeline.map((item, idx) => {
              const Icon = item.icon;
              const cfg = colorMap[item.type] || colorMap.upload;
              return (
                <div key={item.id} className="flex items-start gap-4 px-5 py-4 hover:bg-gray-50/80 transition-colors">
                  <div className="flex flex-col items-center gap-0 flex-shrink-0 mt-1">
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: cfg.bg }}>
                      <Icon size={14} style={{ color: cfg.color }} />
                    </div>
                    {idx < timeline.length - 1 && (
                      <div className="w-0.5 h-6 bg-gray-100 mt-1" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 pb-1">
                    <p className="text-sm font-semibold text-[#050505]">{item.message}</p>
                    {item.detail && (
                      <p className="text-xs text-[#6D6E71] mt-0.5 line-clamp-2">{item.detail}</p>
                    )}
                    <p className="text-xs text-[#A5A5A5] mt-1 flex items-center gap-1">
                      <Clock size={10} />
                      {item.date}
                    </p>
                  </div>
                  <span
                    className="text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize flex-shrink-0"
                    style={{ background: cfg.bg, color: cfg.color }}
                  >
                    {item.type}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/30">
          <p className="text-xs text-[#A5A5A5]">{timeline.length} total events</p>
        </div>
      </div>
    </div>
  );
}
