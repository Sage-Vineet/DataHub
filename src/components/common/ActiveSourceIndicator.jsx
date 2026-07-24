import { Database, FileText, Zap, BarChart3 } from "lucide-react";
import { useDataSource } from "../../context/DataSourceContext";
import { getReportSourceLabel } from "../../lib/report-source";

const SOURCE_CONFIGS = {
  quickbooks: { icon: Zap, color: "text-[#2CA01C]", bg: "bg-[#2CA01C]/10", ring: "ring-[#2CA01C]/20" },
  manual: { icon: Database, color: "text-blue-600", bg: "bg-blue-50", ring: "ring-blue-200" },
  manual_upload: { icon: FileText, color: "text-purple-600", bg: "bg-purple-50", ring: "ring-purple-200" },
  quickbooks_manual: { icon: Zap, color: "text-orange-600", bg: "bg-orange-50", ring: "ring-orange-200" },
  key_reports: { icon: BarChart3, color: "text-primary", bg: "bg-primary/10", ring: "ring-primary/20" },
};

export default function ActiveSourceIndicator() {
  const { activeSource, activeSourceMode, isLoadingSource, isSwitching } = useDataSource();

  if (isLoadingSource || !activeSource) {
    return (
      <div className="hidden sm:flex items-center gap-2 rounded-full border border-border bg-bg-card px-3 py-1.5 text-[12px] text-text-muted">
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-muted/40" />
        <span>Loading source…</span>
      </div>
    );
  }

  const config = SOURCE_CONFIGS[activeSourceMode] ?? SOURCE_CONFIGS.quickbooks;
  const Icon = config.icon;
  const label = getReportSourceLabel(activeSource);

  return (
    <div className="hidden sm:flex items-center gap-2 rounded-full border border-border bg-bg-card px-3 py-1.5 text-[12px] font-medium">
      <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${config.bg} ${config.ring}`}>
        <Icon size={11} className={config.color} />
      </div>
      <span className="text-text-muted">Source:</span>
      <span className={`font-semibold ${config.color}`}>{label}</span>
      {isSwitching && (
        <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
      )}
    </div>
  );
}
