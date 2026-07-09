import { useEffect } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
    useKeyReportContextStore,
    selectKeyReportContext,
} from "../../store/useKeyReportContextStore";

export default function KeyReportVersionSelector({ clientId, className = "", variant = "default" }) {
    const fetchVersions = useKeyReportContextStore((s) => s.fetchVersions);
    const selectVersion = useKeyReportContextStore((s) => s.selectVersion);
    const ctx = useKeyReportContextStore(useShallow(selectKeyReportContext));

    // Force a fresh fetch on mount so this dropdown always reflects the latest
    // Key Reports versions. Without `force`, the shared store caches the list per
    // company and never refetches — so a version created/generated on the Key
    // Reports page (e.g. Version 5) would never appear here. This selector lives
    // only on the consumer pages (Reports / Bank & Tax Reconciliation / EBITDA),
    // so refreshing on each visit is the correct, low-cost behavior.
    useEffect(() => {
        if (clientId) fetchVersions(clientId, true);
    }, [clientId, fetchVersions]);

    if (!ctx.versions.length) return null;

    if (variant === "filter") {
        return (
            <div className={`flex flex-col gap-1.5 ${className}`}>
                <label className="text-[12px] font-medium uppercase tracking-wider text-text-muted">
                    Version
                </label>
                <div className="relative flex items-center">
                    <select
                        value={ctx.selectedVersionId || ""}
                        onChange={(e) => selectVersion(e.target.value)}
                        className="h-9 min-w-[180px] appearance-none rounded-md border border-border-input bg-bg-card pl-3 pr-9 text-[13px] text-text-primary transition-all focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                        {ctx.versions.map((v) => (
                            <option key={v.id} value={v.id}>
                                {v.versionName || `Version ${v.versionNumber}`}
                                {v.isActive ? " ★" : ""}
                            </option>
                        ))}
                    </select>
                    <div className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
                        {ctx.loadingDetail && <Loader2 size={12} className="animate-spin text-text-muted" />}
                        <ChevronDown size={14} className="text-text-muted" />
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`flex items-center gap-2 ${className}`}>
            <span className="text-sm font-medium text-text-secondary">Key Reports Version</span>
            <div className="relative flex items-center">
                <select
                    value={ctx.selectedVersionId || ""}
                    onChange={(e) => selectVersion(e.target.value)}
                    className="h-9 min-w-[200px] rounded-lg border border-border bg-white px-3 py-1 text-sm font-medium text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                >
                    {ctx.versions.map((v) => (
                        <option key={v.id} value={v.id}>
                            {v.versionName || `Version ${v.versionNumber}`}
                            {v.isActive ? " ★" : ""}
                        </option>
                    ))}
                </select>
                {ctx.loadingDetail && (
                    <div className="absolute right-8">
                        <Loader2 size={14} className="animate-spin text-text-muted" />
                    </div>
                )}
            </div>
        </div>
    );
}
