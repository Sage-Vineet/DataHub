import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, FileUp, Loader2, RefreshCw, CheckCircle, AlertCircle, ArrowRight, Save, Play, X, FileText } from "lucide-react";
import {
  continueManualReportProcessing,
  listCompanyFolders,
  listFolderDocuments,
  listFolderTree,
  uploadFile,
  getManualGlColumns,
  saveManualGlMapping,
  uploadManualReport,
} from "../../lib/api";
import { useToast } from "../../context/ToastContext";

const REPORT_TYPES = {
  GENERAL_LEDGER: "GENERAL_LEDGER",
  BALANCE_SHEET: "BALANCE_SHEET",
};

export default function ManualGLUpload({ companyId }) {
  const { showToast } = useToast();
  const [step, setStep] = useState(1); // 1: Stage, 2: Map, 3: Processed
  const [sourceMode, setSourceMode] = useState("dataroom");
  const [files, setFiles] = useState([]); // Array for manual upload
  const [documents, setDocuments] = useState([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState([]); // Array for dataroom
  const [activeUploadId, setActiveUploadId] = useState("");
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingDocuments, setIsLoadingDocuments] = useState(true);

  // Step 2 State
  const [isLoadingColumns, setIsLoadingColumns] = useState(false);
  const [columns, setColumns] = useState([]);
  const [previewData, setPreviewData] = useState([]);
  const [mapping, setMapping] = useState({
    date: "",
    account_name: "",
    account_number: "",
    debit: "",
    credit: "",
    split_amount: "",
    balance: "",
    description: "",
    transaction_type: "",
    reference: "",
    account_type: "",
  });
  const [isSavingMapping, setIsSavingMapping] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [validationErrors, setValidationErrors] = useState([]);
  const [reportType, setReportType] = useState("");
  const [balanceSheetData, setBalanceSheetData] = useState(null);
  const [balanceSheetValidation, setBalanceSheetValidation] = useState(null);

  const refreshDocuments = useCallback(async () => {
    if (!companyId) {
      setDocuments([]);
      setIsLoadingDocuments(false);
      return;
    }

    try {
      setIsLoadingDocuments(true);
      const tree = await listFolderTree(companyId);
      const folderIds = [];
      const folderNameById = {};
      const walk = (nodes = []) => {
        nodes.forEach((node) => {
          folderIds.push(node.id);
          folderNameById[node.id] = node.name || "";
          walk(node.children || []);
        });
      };
      walk(tree || []);

      if (!folderIds.length) {
        const fallbackFolders = await listCompanyFolders(companyId);
        fallbackFolders.forEach((folder) => {
          folderIds.push(folder.id);
          folderNameById[folder.id] = folder.name || "";
        });
      }

      const docsPerFolder = await Promise.all(
        Array.from(new Set(folderIds)).map(async (folderId) => {
          const docs = await listFolderDocuments(folderId);
          return (docs || []).map((doc) => ({
            id: doc.id,
            folderId,
            folderName: folderNameById[folderId] || "",
            name: doc.name,
            fileUrl: doc.file_url,
            uploadId: doc.upload_id,
          }));
        }),
      );

      const allDocs = docsPerFolder.flat().filter((doc) => !!doc.uploadId);
      setDocuments(allDocs);
    } catch (error) {
      showToast({
        type: "error",
        title: "Documents load failed",
        message: error?.message || "Could not load Data Room documents.",
      });
    } finally {
      setIsLoadingDocuments(false);
    }
  }, [companyId, showToast]);

  useEffect(() => {
    refreshDocuments();
  }, [refreshDocuments]);

  const selectedDocuments = useMemo(
    () => documents.filter((doc) => selectedDocumentIds.includes(doc.id)),
    [documents, selectedDocumentIds],
  );

  const formatDocumentLabel = useCallback((doc) => {
    if (!doc) return "";
    const folderLabel = String(doc.folderName || "").trim();
    return folderLabel ? `${doc.name} (${folderLabel})` : doc.name;
  }, []);

  const pickMatchingColumn = (availableColumns = [], candidates = []) => {
    const normalized = availableColumns.map((column) => ({
      column,
      key: String(column || "").trim().toLowerCase(),
    }));
    for (const candidate of candidates) {
      const found = normalized.find((item) => item.key.includes(candidate));
      if (found) return found.column;
    }
    return "";
  };

  const suggestMapping = (availableColumns = []) => ({
    date: pickMatchingColumn(availableColumns, ["transaction date", "posting date", "date"]),
    account_name: pickMatchingColumn(availableColumns, ["distribution account", "account name", "account"]),
    debit: pickMatchingColumn(availableColumns, ["debit", "dr"]),
    credit: pickMatchingColumn(availableColumns, ["credit", "cr"]),
    split_amount: pickMatchingColumn(availableColumns, ["split amount", "split", "amount"]),
    balance: pickMatchingColumn(availableColumns, ["balance", "running balance"]),
    description: pickMatchingColumn(availableColumns, ["description", "memo", "split"]),
    transaction_type: pickMatchingColumn(availableColumns, ["transaction type", "type", "category"]),
    reference: pickMatchingColumn(availableColumns, ["reference", "ref", "document", "txn id", "journal"]),
    account_type: pickMatchingColumn(availableColumns, ["account type", "type"]),
  });

  const onSubmitStage = async () => {
    if (!companyId) {
      showToast({
        type: "error",
        title: "Missing company",
        message: "Open this page under a client workspace first.",
      });
      return;
    }

    const itemsToProcess = sourceMode === "manual" 
      ? files.map(f => ({ type: 'manual', file: f }))
      : selectedDocuments.map(doc => ({ type: 'dataroom', doc }));

    if (itemsToProcess.length === 0) {
      showToast({ type: "error", title: "No selection", message: "Please select at least one file to continue." });
      return;
    }

    try {
      setIsSubmitting(true);
      setBalanceSheetData(null);
      setBalanceSheetValidation(null);
      
      const stagedResults = [];
      for (const item of itemsToProcess) {
        let payload = null;
        if (item.type === 'manual') {
          const uploaded = await uploadFile(item.file, {
            fileName: item.file.name,
            prefix: `manual-gl/${companyId}`,
          });
          payload = {
            uploadId: uploaded.id,
            fileName: uploaded.fileName || item.file.name,
            fileUrl: uploaded.fileUrl,
          };
        } else {
          payload = {
            uploadId: item.doc.uploadId,
            fileName: item.doc.name,
            fileUrl: item.doc.fileUrl,
          };
        }
        
        const staged = await uploadManualReport(payload, { clientId: companyId });
        stagedResults.push(staged);
      }

      let firstManualMappingRequired = null;
      let processedCount = 0;
      let totalCount = stagedResults.length;

      for (const staged of stagedResults) {
        const detectedType = staged?.reportType || REPORT_TYPES.GENERAL_LEDGER;
        const stagedDataId = staged?.stagedDataId || staged.uploadId;

        if (detectedType === REPORT_TYPES.BALANCE_SHEET) {
          try {
            const res = await continueManualReportProcessing(
              { reportType: REPORT_TYPES.BALANCE_SHEET, stagedDataId },
              { clientId: companyId }
            );
            setBalanceSheetData(res?.data || staged?.stagedData?.structuredData || null);
            setBalanceSheetValidation(res?.validation || null);
            processedCount++;
          } catch (error) {
            // Log BS error but continue
            console.error("BS Processing failed", error);
          }
        } else {
          try {
            const autoRes = await continueManualReportProcessing(
              { reportType: REPORT_TYPES.GENERAL_LEDGER, stagedDataId, mapping: {} },
              { clientId: companyId }
            );
            if (autoRes.success) {
              processedCount++;
            }
          } catch (error) {
            if (error?.payload?.requiresManualMapping && !firstManualMappingRequired) {
              firstManualMappingRequired = { staged, error };
            }
          }
        }
      }

      setFiles([]);
      setSelectedDocumentIds([]);

      if (firstManualMappingRequired) {
        const { staged, error } = firstManualMappingRequired;
        const stagedDataId = staged?.stagedDataId || staged.uploadId;
        setReportType(staged?.reportType || REPORT_TYPES.GENERAL_LEDGER);
        setActiveUploadId(stagedDataId);
        
        const fallbackMapping = error.payload.autoMapping && typeof error.payload.autoMapping === "object"
          ? error.payload.autoMapping
          : {};
        setValidationErrors(Array.isArray(error?.payload?.errors) ? error.payload.errors : []);
        setStep(2);
        await fetchColumns(stagedDataId, { preferredMapping: fallbackMapping });
        
        showToast({
          type: "warning",
          title: "Manual mapping needed",
          message: `Staged ${totalCount} file(s). ${processedCount} auto-processed. 1 needs review.`,
        });
      } else if (processedCount > 0) {
        setStep(3);
        showToast({
          type: "success",
          title: "Processing complete",
          message: `Successfully processed ${processedCount} file(s).`,
        });
      } else {
        showToast({
          type: "error",
          title: "Processing failed",
          message: "Could not process any of the uploaded files automatically.",
        });
      }
    } catch (error) {
      showToast({ type: "error", title: "Stage failed", message: error?.message || "Could not stage the documents." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const fetchColumns = async (uploadId, options = {}) => {
    setIsLoadingColumns(true);
    try {
      const res = await getManualGlColumns(uploadId, { clientId: companyId });
      if (res.success) {
        const availableColumns = res.columns || [];
        const backendAutoMapping = res.autoMapping || {};
        setColumns(availableColumns);
        setPreviewData(res.preview || []);
        setMapping((current) => {
          const suggested = {
            ...suggestMapping(availableColumns),
            ...backendAutoMapping,
            ...(options.preferredMapping || {}),
          };
          const next = { ...current };
          Object.keys(next).forEach((key) => {
            if (next[key] && !availableColumns.includes(next[key])) {
              next[key] = "";
            }
          });
          Object.entries(suggested).forEach(([key, value]) => {
            if (!next[key] && value) {
              next[key] = value;
            }
          });
          return next;
        });
      }
    } catch (error) {
      showToast({ type: "error", title: "Fetch columns failed", message: error?.message || "Could not fetch GL columns." });
    } finally {
      setIsLoadingColumns(false);
    }
  };

  const onSaveMapping = async () => {
    try {
      setIsSavingMapping(true);
      await saveManualGlMapping({ uploadId: activeUploadId, mapping }, { clientId: companyId });
      showToast({ type: "success", title: "Mapping saved", message: "Column mapping saved successfully." });
    } catch (error) {
      showToast({ type: "error", title: "Save failed", message: error?.message || "Could not save mapping." });
    } finally {
      setIsSavingMapping(false);
    }
  };

  const onProcessData = async () => {
    if (reportType && reportType !== REPORT_TYPES.GENERAL_LEDGER) {
      showToast({
        type: "error",
        title: "Invalid action",
        message: "Column mapping is only required for General Ledger uploads.",
      });
      return;
    }

    if (!mapping.date || !mapping.account_name || !((mapping.debit && mapping.credit) || mapping.split_amount)) {
      showToast({
        type: "error",
        title: "Mapping incomplete",
        message: "Map Date, Account Name, and either both Debit+Credit or Split Amount.",
      });
      return;
    }

    setValidationErrors([]);
    try {
      setIsProcessing(true);
      const res = await continueManualReportProcessing(
        {
          reportType: REPORT_TYPES.GENERAL_LEDGER,
          stagedDataId: activeUploadId,
          mapping,
        },
        { clientId: companyId }
      );
      if (res.success) {
        const skippedRows = Number(res.skippedRows || 0);
        showToast({
          type: skippedRows > 0 ? "warning" : "success",
          title: skippedRows > 0 ? "Processed with warnings" : "Processing complete",
          message: skippedRows > 0
            ? `GL data normalized and stored. Skipped ${skippedRows} invalid row(s).`
            : "GL data has been successfully normalized and stored.",
        });
        setStep(3);
      }
    } catch (error) {
      if (error?.payload?.requiresManualMapping) {
        if (error.payload.autoMapping && typeof error.payload.autoMapping === "object") {
          setMapping((current) => ({ ...current, ...error.payload.autoMapping }));
        }
        if (Array.isArray(error?.payload?.errors) && error.payload.errors.length) {
          setValidationErrors(error.payload.errors);
        }
        showToast({
          type: "error",
          title: "Mapping needs review",
          message: "Required columns are missing or low-confidence. Please adjust mapping and retry.",
        });
        return;
      }

      if (Array.isArray(error?.payload?.errors) && error.payload.errors.length) {
        setValidationErrors(error.payload.errors);
        showToast({ type: "error", title: "Validation failed", message: "Please check row-wise errors below." });
        return;
      }
      showToast({ type: "error", title: "Process failed", message: error?.message || "Could not process GL data." });
    } finally {
      setIsProcessing(false);
    }
  };

  const resetFlow = () => {
    setStep(1);
    setFiles([]);
    setSelectedDocumentIds([]);
    setActiveUploadId("");
    setColumns([]);
    setPreviewData([]);
    setMapping({
      date: "",
      account_name: "",
      account_number: "",
      debit: "",
      credit: "",
      split_amount: "",
      balance: "",
      description: "",
      transaction_type: "",
      reference: "",
      account_type: "",
    });
    setValidationErrors([]);
    setReportType("");
    setBalanceSheetData(null);
    setBalanceSheetValidation(null);
  };

  const isGeneralLedgerFlow = !reportType || reportType === REPORT_TYPES.GENERAL_LEDGER;
  const isBalanceSheetFlow = reportType === REPORT_TYPES.BALANCE_SHEET;
  
  const hasSelection = sourceMode === "dataroom" ? selectedDocumentIds.length > 0 : files.length > 0;
  const isStageActionDisabled = isSubmitting || !hasSelection;
  
  const canProcessMapping = Boolean(
    isGeneralLedgerFlow &&
    mapping.date &&
    mapping.account_name &&
    ((mapping.debit && mapping.credit) || mapping.split_amount)
  );

  const selectedSourceName = useMemo(() => {
    if (sourceMode === "manual") {
      if (files.length === 0) return "None selected";
      if (files.length === 1) return files[0].name;
      return `${files.length} files selected`;
    } else {
      if (selectedDocumentIds.length === 0) return "None selected";
      if (selectedDocumentIds.length === 1) {
        const doc = documents.find((d) => d.id === selectedDocumentIds[0]);
        return formatDocumentLabel(doc);
      }
      return `${selectedDocumentIds.length} documents selected`;
    }
  }, [sourceMode, files, selectedDocumentIds, documents, formatDocumentLabel]);

  const renderMappingSelect = (fieldKey, label, required = false) => (
    <div className="flex flex-col space-y-1">
      <label className="text-[13px] font-medium text-text-primary">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      <select
        className="input-base text-[13px]"
        value={mapping[fieldKey]}
        onChange={(e) => setMapping({ ...mapping, [fieldKey]: e.target.value })}
      >
        <option value="">-- Select Column --</option>
        {columns.map((col) => (
          <option key={col} value={col}>{col}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="card-base overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Database size={16} className="text-primary" />
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-text-primary">Manual Financial Processing</h3>
            <p className="text-[12px] text-secondary">
              Upload a file, detect report type, then process General Ledger or Balance Sheet flow.
            </p>
          </div>
        </div>
        {step === 1 && (
          <button
            type="button"
            onClick={refreshDocuments}
            className="btn-secondary h-9 px-3 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isLoadingDocuments}
          >
            <RefreshCw size={14} className={isLoadingDocuments ? "animate-spin" : ""} />
            Refresh
          </button>
        )}
      </div>

      <div className="p-6">
        {/* Step Indicator */}
        <div className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className={`rounded-md border px-3 py-2 text-[13px] font-medium ${step >= 1 ? "border-primary bg-primary/10 text-primary" : "border-border bg-bg-page text-secondary"}`}>
            1. Select File
          </div>
          <div className={`rounded-md border px-3 py-2 text-[13px] font-medium ${step >= 2 ? "border-primary bg-primary/10 text-primary" : "border-border bg-bg-page text-secondary"}`}>
            {isBalanceSheetFlow ? "2. Validate Snapshot" : "2. Map Columns"}
          </div>
          <div className={`rounded-md border px-3 py-2 text-[13px] font-medium ${step >= 3 ? "border-primary bg-primary/10 text-primary" : "border-border bg-bg-page text-secondary"}`}>
            {isBalanceSheetFlow ? "3. Saved Snapshot" : "3. Processed"}
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-5">
            <div className="rounded-lg border border-border bg-bg-page p-1">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className={`h-9 rounded-md px-3 text-[13px] font-medium transition-colors ${sourceMode === "dataroom" ? "bg-bg-card text-primary shadow-sm border border-primary/40" : "text-secondary hover:bg-bg-card/70"}`}
                  onClick={() => setSourceMode("dataroom")}
                >
                  Use Data Room Document
                </button>
                <button
                  type="button"
                  className={`h-9 rounded-md px-3 text-[13px] font-medium transition-colors ${sourceMode === "manual" ? "bg-bg-card text-primary shadow-sm border border-primary/40" : "text-secondary hover:bg-bg-card/70"}`}
                  onClick={() => setSourceMode("manual")}
                >
                  Manual Upload
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div className="rounded-lg border border-border bg-bg-page/50 p-4">
                {sourceMode === "dataroom" ? (
                  <>
                    <label className="text-[12px] font-semibold uppercase tracking-wide text-secondary">Data Room Documents</label>
                    <div className="mt-2 max-h-56 overflow-y-auto border border-border rounded-lg bg-bg-card/50 p-2 space-y-1">
                      {isLoadingDocuments ? (
                        <div className="flex items-center justify-center p-4 gap-2 text-secondary text-[13px]">
                          <Loader2 size={14} className="animate-spin" />
                          Loading documents...
                        </div>
                      ) : !documents.length ? (
                        <div className="p-4 text-center text-secondary text-[13px]">
                          No uploaded Data Room documents found.
                        </div>
                      ) : (
                        documents.map((doc) => (
                          <label key={doc.id} className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer transition-all hover:bg-primary/5 ${selectedDocumentIds.includes(doc.id) ? "bg-primary/10 ring-1 ring-primary/30" : ""}`}>
                            <input
                              type="checkbox"
                              className="w-4 h-4 rounded border-gray-300 text-primary focus:ring-primary"
                              checked={selectedDocumentIds.includes(doc.id)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedDocumentIds([...selectedDocumentIds, doc.id]);
                                } else {
                                  setSelectedDocumentIds(selectedDocumentIds.filter(id => id !== doc.id));
                                }
                              }}
                            />
                            <div className="flex flex-col min-w-0">
                              <span className="text-[13px] font-medium text-text-primary truncate">{doc.name}</span>
                              <span className="text-[11px] text-secondary truncate">{doc.folderName}</span>
                            </div>
                          </label>
                        ))
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <label className="text-[12px] font-semibold uppercase tracking-wide text-secondary">Financial Files</label>
                    <div className="mt-2 border-2 border-dashed border-border rounded-lg p-6 bg-bg-card/30 flex flex-col items-center justify-center text-center hover:bg-bg-card/50 transition-colors group relative cursor-pointer">
                      <input
                        type="file"
                        className="absolute inset-0 opacity-0 cursor-pointer"
                        accept=".csv,.xlsx,.xls"
                        multiple
                        onChange={(event) => {
                          const newFiles = Array.from(event.target.files || []);
                          setFiles(prev => [...prev, ...newFiles]);
                        }}
                      />
                      <FileUp size={28} className="text-secondary group-hover:text-primary transition-colors mb-2" />
                      <p className="text-[13px] font-medium text-text-primary">Click or drag files to upload</p>
                      <p className="text-[11px] text-secondary mt-1">Supports multiple CSV, XLSX, XLS files</p>
                    </div>

                    {files.length > 0 && (
                      <div className="mt-4 space-y-2">
                        {files.map((f, i) => (
                          <div key={i} className="flex items-center justify-between gap-3 p-2 bg-bg-card rounded-md border border-border">
                            <div className="flex items-center gap-2 min-w-0">
                              <FileText size={14} className="text-primary shrink-0" />
                              <span className="text-[12px] text-text-primary truncate">{f.name}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setFiles(files.filter((_, idx) => idx !== i))}
                              className="p-1 hover:bg-red-50 hover:text-red-500 rounded transition-colors text-secondary"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-bg-page/40 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[12px] text-secondary truncate">
                Selected source: <span className="font-medium text-text-primary">{selectedSourceName || "None selected"}</span>
              </p>
              <button
                type="button"
                onClick={onSubmitStage}
                disabled={isStageActionDisabled}
                className="btn-primary w-full sm:w-auto disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                {isSubmitting ? "Staging..." : "Stage & Continue"}
              </button>
            </div>
          </div>
        )}

        {step === 2 && isGeneralLedgerFlow && (
          <div className="space-y-6">
            {isLoadingColumns ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="animate-spin text-primary mr-2" size={24} />
                <span className="text-secondary">Loading columns...</span>
              </div>
            ) : (
              <>
                <div className="rounded-lg border border-border bg-bg-page px-4 py-3 text-[12px] text-secondary">
                  Required mapping: <span className="font-semibold text-text-primary">Date, Account Name</span>, and either
                  <span className="font-semibold text-text-primary"> Debit + Credit</span> or
                  <span className="font-semibold text-text-primary"> Split Amount</span>.
                </div>

                <div className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-bg-page p-4 sm:grid-cols-2 xl:grid-cols-3">
                  {renderMappingSelect("date", "Date", true)}
                  {renderMappingSelect("account_name", "Account Name", true)}
                  {renderMappingSelect("account_number", "Account Number")}
                  {renderMappingSelect("debit", "Debit")}
                  {renderMappingSelect("credit", "Credit")}
                  {renderMappingSelect("split_amount", "Split Amount")}
                  {renderMappingSelect("balance", "Balance")}
                  {renderMappingSelect("description", "Description")}
                  {renderMappingSelect("transaction_type", "Transaction Type")}
                  {renderMappingSelect("reference", "Reference")}
                  {renderMappingSelect("account_type", "Account Type")}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isProcessing || isSavingMapping}
                  >
                    <ArrowRight size={14} className="rotate-180" />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={onSaveMapping}
                    disabled={isSavingMapping}
                    className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isSavingMapping ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    Save Mapping
                  </button>
                  <button
                    type="button"
                    onClick={onProcessData}
                    disabled={isProcessing || !canProcessMapping}
                    className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isProcessing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    Process Data
                  </button>
                </div>

                {validationErrors.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                    <h4 className="text-red-700 font-semibold mb-2 flex items-center gap-2">
                      <AlertCircle size={16} /> Validation Errors
                    </h4>
                    <ul className="list-disc pl-5 text-red-600 text-[13px] max-h-40 overflow-y-auto">
                      {validationErrors.map((err, i) => (
                        <li key={i}>Row {err.row}: {err.message}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="mt-2 rounded-lg border border-border overflow-hidden">
                  <div className="p-3 bg-bg-page border-b border-border flex items-center justify-between gap-2">
                    <h4 className="text-[14px] font-semibold text-text-primary">Data Preview</h4>
                    <p className="text-[12px] text-secondary">{previewData.length} row(s) shown</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-bg-page text-[12px] text-text-muted uppercase tracking-wider">
                          {columns.map((col) => (
                            <th key={col} className="p-3 border-b border-border whitespace-nowrap">{col}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.length > 0 ? (
                          previewData.map((row, i) => (
                            <tr key={i} className="text-[13px] text-secondary hover:bg-bg-page/60 transition-colors">
                              {columns.map((col) => (
                                <td key={col} className="p-3 border-b border-border whitespace-nowrap">
                                  {String(row[col] || "")}
                                </td>
                              ))}
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={Math.max(columns.length, 1)} className="p-6 text-center text-[13px] text-secondary">
                              No preview rows available.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="py-10 flex flex-col items-center justify-center text-center rounded-lg border border-primary/30 bg-primary/5 px-4">
            <CheckCircle className="text-primary mb-4" size={48} />
            <h3 className="text-xl font-bold text-text-primary mb-2">
              {isBalanceSheetFlow ? "Balance Sheet Flow Complete" : "Processing Complete"}
            </h3>
            {isBalanceSheetFlow ? (
              <>
                <p className="text-secondary max-w-md">
                  {balanceSheetValidation?.isValid
                    ? "Balance Sheet validated and saved as a snapshot."
                    : "Balance Sheet uploaded, but validation failed. Review the returned data and fix the source file."}
                </p>

                {balanceSheetValidation && (
                  <div className="mt-4 w-full max-w-3xl rounded-lg border border-border bg-bg-card p-4 text-left">
                    <h4 className="text-[14px] font-semibold text-text-primary mb-2">Validation Summary</h4>
                    <p className={`text-[13px] ${balanceSheetValidation.isValid ? "text-green-700" : "text-red-600"}`}>
                      {balanceSheetValidation.message}
                    </p>
                    {balanceSheetValidation.totals && (
                      <div className="mt-2 grid grid-cols-1 gap-1 text-[12px] text-secondary sm:grid-cols-2">
                        <p>Total Assets: {balanceSheetValidation.totals.totalAssets}</p>
                        <p>Total Liabilities: {balanceSheetValidation.totals.totalLiabilities}</p>
                        <p>Total Equity: {balanceSheetValidation.totals.totalEquity}</p>
                        <p>Difference: {balanceSheetValidation.difference}</p>
                      </div>
                    )}
                  </div>
                )}

                {balanceSheetData && (
                  <div className="mt-4 w-full max-w-3xl rounded-lg border border-border bg-bg-card p-4 text-left">
                    <h4 className="text-[14px] font-semibold text-text-primary mb-2">Staged Balance Sheet Data</h4>
                    <p className="text-[12px] text-secondary mb-2">
                      As of Date: <span className="font-medium text-text-primary">{balanceSheetData.asOfDate || "Not detected"}</span>
                    </p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                      <div>
                        <h5 className="text-[13px] font-semibold text-text-primary mb-1">Assets</h5>
                        <ul className="text-[12px] text-secondary space-y-1 max-h-40 overflow-y-auto">
                          {(balanceSheetData.assets || []).map((item, index) => (
                            <li key={`asset-${index}`}>{item.name}: {item.amount}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h5 className="text-[13px] font-semibold text-text-primary mb-1">Liabilities</h5>
                        <ul className="text-[12px] text-secondary space-y-1 max-h-40 overflow-y-auto">
                          {(balanceSheetData.liabilities || []).map((item, index) => (
                            <li key={`liability-${index}`}>{item.name}: {item.amount}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <h5 className="text-[13px] font-semibold text-text-primary mb-1">Equity</h5>
                        <ul className="text-[12px] text-secondary space-y-1 max-h-40 overflow-y-auto">
                          {(balanceSheetData.equity || []).map((item, index) => (
                            <li key={`equity-${index}`}>{item.name}: {item.amount}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-secondary max-w-md">
                The General Ledger data has been successfully mapped, normalized, and stored into the Data Room collection. It is now ready for report generation.
              </p>
            )}
            <button type="button" onClick={resetFlow} className="btn-secondary mt-6">
              Process Another File
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
