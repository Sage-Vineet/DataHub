import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import BridgeTable from "../../../components/qoe/BridgeTable";
import AddbackWizard from "../../../components/qoe/AddbackWizard";
import ClassificationPanel from "../../../components/qoe/ClassificationPanel";
import { money, periodKey } from "../../../components/qoe/format";
import {
  classifyAccounts,
  createAddback,
  deleteAddback,
  draftCommentary,
  fetchBridge,
  listAddbacks,
  saveCommentary,
  setAccountClassification,
  setAccountRole,
} from "../../../services/qoeApi";
import { getCompanyRequest } from "../../../lib/api";
import { useKeyReportContextStore } from "../../../store/useKeyReportContextStore";
import KeyReportVersionSelector from "../../../components/key-reports/KeyReportVersionSelector";

/**
 * The QoE SDE/EBITDA bridge (`QE - 0004`).
 *
 * Every figure is computed server-side by `@datahub/financial-engine` and
 * asserted against the engagement workbook in its golden suite. This screen
 * renders and edits; it does not calculate.
 */

const DATA_SOURCES = [
  ["company_financials", "Company Financials"],
  ["tax_return", "Tax Return"],
];

function Toolbar({
  years, selectedYears, onToggleYear,
  aggregation, onAggregation,
  dataSource, onDataSource,
  onAdd,
}) {
  return (
    <div className="flex flex-wrap items-end gap-4 rounded-lg border border-slate-200 bg-white p-4">
      {/* QE-0004: periods are chosen individually, never through a range picker. */}
      <div>
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Periods
        </span>
        <div className="flex flex-wrap gap-1.5">
          {years.map((year) => {
            const on = selectedYears.includes(year);
            return (
              <button
                key={year}
                onClick={() => onToggleYear(year)}
                className={`rounded-md border px-3 py-1.5 text-sm font-medium transition ${
                  on
                    ? "border-sky-600 bg-sky-600 text-white"
                    : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"
                }`}
              >
                FY{year}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Columns
        </span>
        <div className="inline-flex rounded-md border border-slate-300 p-0.5">
          {["annual", "monthly"].map((mode) => (
            <button
              key={mode}
              onClick={() => onAggregation(mode)}
              className={`rounded px-3 py-1 text-sm capitalize transition ${
                aggregation === mode ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* QE-0004: one source at a time; the two data sets never mix in a view. */}
      <div>
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          Data source
        </span>
        <div className="inline-flex rounded-md border border-slate-300 p-0.5">
          {DATA_SOURCES.map(([value, label]) => (
            <button
              key={value}
              onClick={() => onDataSource(value)}
              className={`rounded px-3 py-1 text-sm transition ${
                dataSource === value ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="ml-auto">
        <button
          onClick={onAdd}
          className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
        >
          + Add New Add-Back
        </button>
      </div>
    </div>
  );
}

/** Commentary panel for the selected bridge line. */
/**
 * Rendered with `key={line.key}` by the page, so selecting a different line
 * remounts this and the initial state comes from props. That replaces an effect
 * that synced state on every prop change — the pattern that caused a cascading
 * re-render loop elsewhere on this screen.
 */
function CommentaryPanel({ line, addback, onDraft, onSave }) {
  const [text, setText] = useState(line?.commentary || "");
  const [drafting, setDrafting] = useState(false);
  const [dirty, setDirty] = useState(false);

  if (!line) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        Select a line on the bridge to read or edit its commentary.
      </div>
    );
  }

  const editable = Boolean(addback);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-semibold text-slate-900">{line.label}</h3>
      <p className="mt-0.5 text-xs text-slate-500">
        {editable ? "Commentary" : "Standard rationale — edit per deal from the add-back record."}
      </p>

      <textarea
        className="mt-3 w-full rounded-md border border-slate-300 p-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:bg-slate-50 disabled:text-slate-500"
        rows={6}
        value={text}
        disabled={!editable}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
      />

      {editable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={async () => {
              setDrafting(true);
              try {
                const { draft } = await onDraft(addback.id);
                setText(draft);
                setDirty(true);
              } finally {
                setDrafting(false);
              }
            }}
            disabled={drafting}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {drafting ? "Drafting…" : "Suggest a draft"}
          </button>
          <button
            onClick={() => { onSave(addback.id, text); setDirty(false); }}
            disabled={!dirty}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
          >
            Save commentary
          </button>
          {dirty && (
            <span className="self-center text-xs text-amber-600">
              Unsaved — a draft is never stored until you confirm it.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function WorkspaceEbitda() {
  const { clientId } = useParams();
  const versionId = useKeyReportContextStore((s) => s.selectedVersionId);

  const [bridge, setBridge] = useState(null);
  const [addbacks, setAddbacks] = useState([]);
  const [company, setCompany] = useState(null);
  const [allYears, setAllYears] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [aggregation, setAggregation] = useState("annual");
  const [dataSource, setDataSource] = useState("company_financials");
  const [selectedLine, setSelectedLine] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [classifying, setClassifying] = useState(false);
  const [error, setError] = useState("");

  // The available-year list is discovered from the first response and then left
  // alone. A ref rather than state because writing it must NOT re-trigger the
  // fetch it came from — doing that through `selectedYears` (a fresh array each
  // time) is an infinite render loop.
  const yearsInitialized = useRef(null);

  // Stable dependency: the identity of `selectedYears` changes on every render,
  // its contents do not.
  const yearsKey = selectedYears.join(",");

  // No state is written before the first `await`, so this never triggers a
  // synchronous cascade when called from an effect.
  const load = useCallback(async () => {
    if (!versionId) return;
    try {
      const years = yearsKey ? yearsKey.split(",").map(Number) : undefined;
      const [next, list] = await Promise.all([
        fetchBridge({ versionId, years, aggregation, dataSource }, { clientId }),
        listAddbacks({ versionId }, { clientId }),
      ]);
      setError("");
      setBridge(next);
      setAddbacks(Array.isArray(list) ? list : []);
      // Discover the available years once per version. Writing this through
      // `selectedYears` — a fresh array each render — is an infinite loop.
      if (yearsInitialized.current !== versionId && next?.periods?.length) {
        yearsInitialized.current = versionId;
        const discovered = [...new Set(next.periods.map((p) => p.fiscalYear))].sort();
        setAllYears(discovered);
        setSelectedYears(discovered);
      }
    } catch (err) {
      setError(err?.message || "Could not load the bridge.");
    }
  }, [versionId, yearsKey, aggregation, dataSource, clientId]);

  // `load` is async and writes no state before its first await, so there is no
  // synchronous cascade here — the rule cannot see through the async boundary.
  // Fetching from an effect goes away when this screen adopts
  // @tanstack/react-query with the rest of the frontend migration.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  useEffect(() => {
    if (clientId) getCompanyRequest(clientId).then(setCompany).catch(() => {});
  }, [clientId]);

  // A dry run: report what the classifier sees without writing anything.
  const refreshReport = useCallback(async () => {
    if (!versionId) return null;
    const next = await classifyAccounts(versionId, { dryRun: true }, { clientId });
    setReport(next);
    return next;
  }, [versionId, clientId]);

  const openClassification = useCallback(async () => {
    setClassifyOpen(true);
    setClassifying(true);
    try {
      await refreshReport();
    } finally {
      setClassifying(false);
    }
  }, [refreshReport]);

  // The only call that writes. Applies high-confidence roles, then reloads both
  // the bridge and the report so the panel reflects what actually landed.
  const runClassification = useCallback(async () => {
    setClassifying(true);
    try {
      await classifyAccounts(versionId, {}, { clientId });
      await Promise.all([load(), refreshReport()]);
    } catch (err) {
      setError(err?.message || "Could not classify the chart of accounts.");
    } finally {
      setClassifying(false);
    }
  }, [versionId, clientId, load, refreshReport]);

  const toggleYear = (year) =>
    setSelectedYears((prev) => {
      const next = prev.includes(year) ? prev.filter((y) => y !== year) : [...prev, year];
      return next.length ? next.sort() : prev; // never empty the selection
    });

  const addbackById = useMemo(
    () => new Map(addbacks.map((a) => [a.id, a])),
    [addbacks],
  );

  /**
   * How much of the chart of accounts this bridge actually rests on.
   *
   * "Incomplete" is any unclassified account at all: in a quality-of-earnings
   * deliverable there is no comfortable threshold below which a missing account
   * stops mattering, and the reader is entitled to know the denominator.
   */
  const coverage = useMemo(() => {
    if (!bridge) return null;
    const classified = bridge.ebitLines?.length ?? 0;
    const unclassified = bridge.unflaggedAccounts?.length ?? 0;
    const total = classified + unclassified;
    if (total === 0) return null;
    return { classified, unclassified, total, incomplete: unclassified > 0 };
  }, [bridge]);

  const headline = useMemo(() => {
    if (!bridge) return null;
    const last = bridge.periods[bridge.periods.length - 1];
    if (!last) return null;
    const key = periodKey(last);
    return {
      label: last.label,
      adjusted: bridge.adjusted?.[key],
      reported: bridge.reportedEbitda?.[key],
      revenue: bridge.revenue?.[key],
      margin: bridge.margin?.[key],
    };
  }, [bridge]);

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">
            {bridge?.metricLabel || "Adjusted EBITDA"}
          </h1>
          <p className="text-sm text-slate-500">
            {company?.name || "Quality of Earnings"} · sourced from{" "}
            {dataSource === "tax_return" ? "the tax return" : "company financials"}
          </p>
          {/*
            Rendered unconditionally, and exactly once. Swapping between an
            "empty state" instance and a "loaded" instance remounts the
            component, and each mount refetches and re-selects against the
            shared store — which flickered this page between the two states.
          */}
          <div className="mt-2">
            <KeyReportVersionSelector clientId={clientId} variant="filter" />
          </div>
        </div>
        {headline && (
          <div className="flex gap-6 text-right">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                Reported EBITDA {headline.label}
              </div>
              <div className="text-lg font-semibold text-slate-700">
                {money(headline.reported)}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">
                {bridge.metricLabel} {headline.label}
              </div>
              <div className="text-lg font-bold text-emerald-700">
                {money(headline.adjusted)}
              </div>
            </div>
          </div>
        )}
      </header>

      {versionId && (
      <Toolbar
        years={allYears}
        selectedYears={selectedYears}
        onToggleYear={toggleYear}
        aggregation={aggregation}
        onAggregation={setAggregation}
        dataSource={dataSource}
        onDataSource={setDataSource}
        onAdd={() => setWizardOpen(true)}
      />
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {!versionId && (
        <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-slate-500">
          Select a key-report version to build the bridge.
        </div>
      )}

      {versionId && (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="transition">
          {/*
            Coverage, stated above the numbers rather than under them.

            This used to be a grey line beneath the table: "3 accounts classified
            into EBIT lines · 36 left out", sitting below a confident four-year
            bridge ending in an Adjusted EBITDA figure. A broker will screenshot
            that figure into a teaser. A bridge built from 3 of 39 accounts is not
            a number to quote, and the interface has to say so where the number
            is read, not in a footnote after it.
          */}
          {bridge && coverage && coverage.incomplete && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
            >
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-amber-900">
                  {coverage.classified === 0
                    ? 'No accounts are classified yet — these figures are not a bridge'
                    : `Built from ${coverage.classified} of ${coverage.total} accounts`}
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-amber-800">
                  {coverage.classified === 0
                    ? 'Reported EBITDA currently equals net income. Classify the chart of accounts before using anything below.'
                    : `${coverage.unclassified} account${coverage.unclassified === 1 ? '' : 's'} are not classified into EBIT lines, so every figure below understates the bridge. Do not quote these numbers until the classification is complete.`}
                </p>
              </div>
              <button
                onClick={openClassification}
                className="shrink-0 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-900 hover:bg-amber-100"
              >
                Review classification
              </button>
            </div>
          )}

          <BridgeTable
            bridge={bridge}
            selectedLineKey={selectedLine?.key}
            onSelectLine={setSelectedLine}
          />

          {bridge && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <span className="text-slate-700">
                <strong>{bridge.ebitLines.length}</strong> account
                {bridge.ebitLines.length === 1 ? "" : "s"} classified into EBIT lines
                {bridge.unflaggedAccounts.length > 0 && (
                  <>
                    {" · "}
                    <strong>{bridge.unflaggedAccounts.length}</strong> left out
                  </>
                )}
              </span>
              <button
                onClick={openClassification}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Review classification
              </button>
              {bridge.ebitLines.length === 0 && (
                <span className="text-xs text-amber-700">
                  Nothing is classified yet, so Reported EBITDA equals net income.
                </span>
              )}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <CommentaryPanel
            key={selectedLine?.key ?? "none"}
            line={selectedLine}
            addback={selectedLine ? addbackById.get(selectedLine.key) : null}
            onDraft={(id) => draftCommentary(id, { clientId })}
            onSave={async (id, text) => {
              await saveCommentary(id, text, { clientId });
              await load();
            }}
          />

          {addbacks.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">
                Add-Back Library ({addbacks.length})
              </h3>
              <p className="mb-3 text-xs text-slate-500">
                Shared with the CIM builder — both read these same records.
              </p>
              <ul className="space-y-1.5">
                {addbacks.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-slate-700">{a.name}</span>
                    <button
                      onClick={async () => {
                        await deleteAddback(a.id, { clientId });
                        setSelectedLine(null);
                        await load();
                      }}
                      className="shrink-0 text-xs text-rose-600 hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      )}

      <ClassificationPanel
        open={classifyOpen}
        onClose={() => setClassifyOpen(false)}
        report={report}
        loading={classifying}
        busy={classifying}
        onClassify={runClassification}
        onSetRole={async (accountId, role) => {
          setClassifying(true);
          try {
            await setAccountRole(versionId, accountId, role, { clientId });
            await Promise.all([load(), refreshReport()]);
          } finally {
            setClassifying(false);
          }
        }}
        onSetType={async (accountId, accountType) => {
          setClassifying(true);
          try {
            await setAccountClassification(versionId, accountId, accountType, { clientId });
            await Promise.all([load(), refreshReport()]);
          } finally {
            setClassifying(false);
          }
        }}
      />

      <AddbackWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        accounts={bridge?.accounts || []}
        periods={bridge?.periods || []}
        dataSource={dataSource}
        onSave={async (payload) => {
          await createAddback(
            { ...payload, version_id: versionId, company_id: company?.id || clientId },
            { clientId },
          );
          await load();
        }}
      />
    </div>
  );
}
