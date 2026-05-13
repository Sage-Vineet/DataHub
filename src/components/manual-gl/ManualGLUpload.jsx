import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, FileUp, Loader2, RefreshCw, CheckCircle, AlertCircle, ArrowRight, Save, Play, X, FileText, Lock } from "lucide-react";
import {
  listCompanyFolders,
  listFolderDocuments,
  listFolderTree,
  uploadFile,
  getManualGlColumns,
  saveManualGlMapping,
  stageMultiYearManualGl,
  validateManualStagedBalanceSheet,
} from "../../lib/api";
import { useToast } from "../../context/ToastContext";

export default function ManualGLUpload({
  companyId,
  isLocked = false,
  lockMessage = "",
  onStageComplete = null,
}) {
  const { showToast } = useToast();
  const [step, setStep] = useState(1); // 1: Stage, 2: Map (if needed), 3: Staged
  const [sourceMode, setSourceMode] = useState("dataroom");
  const [files, setFiles] = useState([]); // GL files for manual upload
  const [startingBalanceSheetFile, setStartingBalanceSheetFile] = useState(null);
  const [endingBalanceSheetFile, setEndingBalanceSheetFile] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState([]); // GL docs from dataroom
  const [selectedStartingDocumentId, setSelectedStartingDocumentId] = useState("");
  const [selectedEndingDocumentId, setSelectedEndingDocumentId] = useState("");
  const [activeUploadId, setActiveUploadId] = useState("");
  const [pendingStageRequest, setPendingStageRequest] = useState(null);
  const [stageResult, setStageResult] = useState(null);

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
    if (!isLocked) {
      refreshDocuments();
    }
  }, [isLocked, refreshDocuments]);

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
    if (isLocked) {
      showToast({
        type: "warning",
        title: "Manual Upload is locked",
        message: lockMessage || "Manual Upload is currently disabled for this workspace.",
      });
      return;
    }

    if (!companyId) {
      showToast({
        type: "error",
        title: "Missing company",
        message: "Open this page under a client workspace first.",
      });
      return;
    }

    const hasGlSelection =
      sourceMode === "manual"
        ? files.length > 0
        : selectedDocumentIds.length > 0;

    if (!hasGlSelection) {
      showToast({ type: "error", title: "No selection", message: "Please select at least one file to continue." });
      return;
    }

    let stagePayloadForRetry = null;
    try {
      setIsSubmitting(true);
      setActiveUploadId("");
      setBalanceSheetValidation(null);

      const uploadPrefix = `manual-gl/${companyId}`;
      let glUploadIds = [];
      let startingBalanceSheetUploadId = "";
      let endingBalanceSheetUploadId = "";

      if (sourceMode === "manual") {
        glUploadIds = (
          await Promise.all(
            files.map(async (file) => {
              const uploaded = await uploadFile(file, {
                fileName: file.name,
                prefix: uploadPrefix,
              });
              return uploaded?.id || "";
            }),
          )
        ).filter(Boolean);

        if (startingBalanceSheetFile) {
          const uploaded = await uploadFile(startingBalanceSheetFile, {
            fileName: startingBalanceSheetFile.name,
            prefix: uploadPrefix,
          });
          startingBalanceSheetUploadId = uploaded?.id || "";
        }

        if (endingBalanceSheetFile) {
          const uploaded = await uploadFile(endingBalanceSheetFile, {
            fileName: endingBalanceSheetFile.name,
            prefix: uploadPrefix,
          });
          endingBalanceSheetUploadId = uploaded?.id || "";
        }
      } else {
        const selectedSet = new Set(selectedDocumentIds);
        const glDocs = documents.filter((doc) => selectedSet.has(doc.id));
        glUploadIds = glDocs.map((doc) => doc.uploadId).filter(Boolean);

        if (selectedStartingDocumentId) {
          const doc = documents.find((item) => item.id === selectedStartingDocumentId);
          startingBalanceSheetUploadId = doc?.uploadId || "";
        }
        if (selectedEndingDocumentId) {
          const doc = documents.find((item) => item.id === selectedEndingDocumentId);
          endingBalanceSheetUploadId = doc?.uploadId || "";
        }
      }

      const excludedUploadIds = new Set(
        [startingBalanceSheetUploadId, endingBalanceSheetUploadId].filter(Boolean),
      );
      const normalizedGlUploadIds = Array.from(
        new Set(glUploadIds.filter((id) => id && !excludedUploadIds.has(id))),
      );

      if (!normalizedGlUploadIds.length) {
        showToast({
          type: "error",
          title: "No GL files",
          message: "Please provide at least one General Ledger file.",
        });
        return;
      }

      const stagePayload = {
        glUploadIds: normalizedGlUploadIds,
        startingBalanceSheetUploadId,
        endingBalanceSheetUploadId,
        mapping: {},
      };
      stagePayloadForRetry = stagePayload;

      const staged = await stageMultiYearManualGl(stagePayload, { clientId: companyId });
      const validation =
        staged?.validation ||
        (staged?.batchId
          ? (await validateManualStagedBalanceSheet({
            clientId: companyId,
            params: { batchId: staged.batchId },
          }).catch(() => null))?.validation || null
          : null);

      setPendingStageRequest(stagePayload);
      setStageResult(staged);
      setBalanceSheetValidation(validation);
      setValidationErrors([]);
      setStep(3);

      setFiles([]);
      setSelectedDocumentIds([]);
      setSelectedStartingDocumentId("");
      setSelectedEndingDocumentId("");
      setStartingBalanceSheetFile(null);
      setEndingBalanceSheetFile(null);

      showToast({
        type: "success",
        title: "Staging complete",
        message: `Batch ${staged.batchId} staged. Inserted ${staged.insertedTransactions || 0}, skipped duplicates ${staged.duplicateTransactionsSkipped || 0}.`,
      });
      if (typeof onStageComplete === "function") {
        await onStageComplete(staged);
      }
    } catch (error) {
      if (error?.payload?.requiresManualMapping) {
        const payload = error.payload;
        setPendingStageRequest(
          stagePayloadForRetry || {
            glUploadIds: [],
            startingBalanceSheetUploadId: "",
            endingBalanceSheetUploadId: "",
            mapping: {},
          },
        );
        setActiveUploadId(payload.failedUploadId || "");
        setValidationErrors(
          Array.isArray(payload.missingRequired) && payload.missingRequired.length
            ? payload.missingRequired.map((field) => ({ row: 0, message: `Missing mapping: ${field}` }))
            : [],
        );
        setStep(2);
        if (payload.failedUploadId) {
          await fetchColumns(payload.failedUploadId, {
            preferredMapping: payload.suggestedMapping || {},
          });
        }
        showToast({
          type: "warning",
          title: "Manual mapping needed",
          message: payload.error || "Please review mapping and retry staging.",
        });
        return;
      }
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
    if (isLocked) return;
    if (!activeUploadId) {
      showToast({
        type: "error",
        title: "No upload selected",
        message: "No failed upload is available for mapping save.",
      });
      return;
    }

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
    if (isLocked) return;
    if (!mapping.date || !mapping.account_name || !((mapping.debit && mapping.credit) || mapping.split_amount)) {
      showToast({
        type: "error",
        title: "Mapping incomplete",
        message: "Map Date, Account Name, and either both Debit+Credit or Split Amount.",
      });
      return;
    }

    if (!pendingStageRequest || !Array.isArray(pendingStageRequest.glUploadIds) || pendingStageRequest.glUploadIds.length === 0) {
      showToast({
        type: "error",
        title: "Retry unavailable",
        message: "No pending staging request was found. Please start from step 1.",
      });
      return;
    }

    setValidationErrors([]);
    try {
      setIsProcessing(true);
      const payload = {
        ...pendingStageRequest,
        mapping,
      };

      const staged = await stageMultiYearManualGl(payload, { clientId: companyId });
      const validation =
        staged?.validation ||
        (staged?.batchId
          ? (await validateManualStagedBalanceSheet({
            clientId: companyId,
            params: { batchId: staged.batchId },
          }).catch(() => null))?.validation || null
          : null);

      setStageResult(staged);
      setBalanceSheetValidation(validation);
      setPendingStageRequest(payload);

      showToast({
        type: "success",
        title: "Staging complete",
        message: `Batch ${staged.batchId} staged. Inserted ${staged.insertedTransactions || 0}, skipped duplicates ${staged.duplicateTransactionsSkipped || 0}.`,
      });
      if (typeof onStageComplete === "function") {
        await onStageComplete(staged);
      }
      setStep(3);
    } catch (error) {
      if (error?.payload?.requiresManualMapping) {
        const payload = error.payload;
        if (payload.suggestedMapping && typeof payload.suggestedMapping === "object") {
          setMapping((current) => ({ ...current, ...payload.suggestedMapping }));
        }
        if (Array.isArray(payload.missingRequired) && payload.missingRequired.length) {
          setValidationErrors(payload.missingRequired.map((field) => ({
            row: 0,
            message: `Missing mapping: ${field}`,
          })));
        }
        if (payload.failedUploadId) {
          setActiveUploadId(payload.failedUploadId);
          await fetchColumns(payload.failedUploadId, {
            preferredMapping: payload.suggestedMapping || {},
          });
        }
        showToast({
          type: "error",
          title: "Mapping needs review",
          message: payload.error || "Required mapping fields are missing. Please adjust and retry.",
        });
        return;
      }
      showToast({ type: "error", title: "Retry failed", message: error?.message || "Could not restage GL data." });
    } finally {
      setIsProcessing(false);
    }
  };

  const resetFlow = () => {
    setStep(1);
    setFiles([]);
    setStartingBalanceSheetFile(null);
    setEndingBalanceSheetFile(null);
    setSelectedDocumentIds([]);
    setSelectedStartingDocumentId("");
    setSelectedEndingDocumentId("");
    setActiveUploadId("");
    setPendingStageRequest(null);
    setStageResult(null);
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
    setBalanceSheetValidation(null);
  };

  const hasSelection = sourceMode === "dataroom" ? selectedDocumentIds.length > 0 : files.length > 0;
  const isStageActionDisabled = isSubmitting || !hasSelection;

  const canProcessMapping = Boolean(
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
              Stage multi-year GL files with optional starting and ending balance sheets for normalized reporting.
            </p>
          </div>
        </div>
        {isLocked ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-5 py-4 text-amber-900">
            <div className="flex items-start gap-3">
              <Lock size={18} className="mt-0.5 shrink-0" />
              <div>
                <p className="text-[14px] font-semibold">Manual Upload is currently locked</p>
                <p className="mt-1 text-[13px] leading-relaxed">
                  {lockMessage || "Manual Upload is disabled for this workspace."}
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {!isLocked && step === 1 && (
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
            1. Select Files
          </div>
          <div className={`rounded-md border px-3 py-2 text-[13px] font-medium ${step >= 2 ? "border-primary bg-primary/10 text-primary" : "border-border bg-bg-page text-secondary"}`}>
            2. Map Columns (If Required)
          </div>
          <div className={`rounded-md border px-3 py-2 text-[13px] font-medium ${step >= 3 ? "border-primary bg-primary/10 text-primary" : "border-border bg-bg-page text-secondary"}`}>
            3. Staged & Validated
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

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded-md border border-border bg-bg-card p-3">
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-secondary mb-1">
                          Starting Balance Sheet (Optional)
                        </label>
                        <select
                          className="input-base text-[13px]"
                          value={selectedStartingDocumentId}
                          onChange={(event) => setSelectedStartingDocumentId(event.target.value)}
                        >
                          <option value="">None</option>
                          {documents.map((doc) => (
                            <option key={`start-${doc.id}`} value={doc.id}>
                              {formatDocumentLabel(doc)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="rounded-md border border-border bg-bg-card p-3">
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-secondary mb-1">
                          Ending Balance Sheet (Optional)
                        </label>
                        <select
                          className="input-base text-[13px]"
                          value={selectedEndingDocumentId}
                          onChange={(event) => setSelectedEndingDocumentId(event.target.value)}
                        >
                          <option value="">None</option>
                          {documents.map((doc) => (
                            <option key={`end-${doc.id}`} value={doc.id}>
                              {formatDocumentLabel(doc)}
                            </option>
                          ))}
                        </select>
                      </div>
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

                    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="rounded-md border border-border bg-bg-card p-3">
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-secondary mb-1">
                          Starting Balance Sheet (Optional)
                        </label>
                        <input
                          type="file"
                          accept=".csv,.xlsx,.xls"
                          onChange={(event) => {
                            const file = event.target.files?.[0] || null;
                            setStartingBalanceSheetFile(file);
                          }}
                          className="input-base text-[13px]"
                        />
                        {startingBalanceSheetFile ? (
                          <p className="mt-2 text-[12px] text-text-primary truncate">
                            {startingBalanceSheetFile.name}
                          </p>
                        ) : null}
                      </div>
                      <div className="rounded-md border border-border bg-bg-card p-3">
                        <label className="block text-[11px] font-semibold uppercase tracking-wide text-secondary mb-1">
                          Ending Balance Sheet (Optional)
                        </label>
                        <input
                          type="file"
                          accept=".csv,.xlsx,.xls"
                          onChange={(event) => {
                            const file = event.target.files?.[0] || null;
                            setEndingBalanceSheetFile(file);
                          }}
                          className="input-base text-[13px]"
                        />
                        {endingBalanceSheetFile ? (
                          <p className="mt-2 text-[12px] text-text-primary truncate">
                            {endingBalanceSheetFile.name}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-bg-page/40 px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[12px] text-secondary truncate">
                  Selected GL source: <span className="font-medium text-text-primary">{selectedSourceName || "None selected"}</span>
                </p>
                <p className="text-[11px] text-secondary truncate">
                  Starting BS: <span className="font-medium text-text-primary">{sourceMode === "manual" ? (startingBalanceSheetFile?.name || "Not provided") : (selectedStartingDocumentId ? (formatDocumentLabel(documents.find((doc) => doc.id === selectedStartingDocumentId)) || "Selected") : "Not provided")}</span>
                  {" | "}
                  Ending BS: <span className="font-medium text-text-primary">{sourceMode === "manual" ? (endingBalanceSheetFile?.name || "Not provided") : (selectedEndingDocumentId ? (formatDocumentLabel(documents.find((doc) => doc.id === selectedEndingDocumentId)) || "Selected") : "Not provided")}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={onSubmitStage}
                disabled={isStageActionDisabled}
                className="btn-primary w-full sm:w-auto disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? <Loader2 size={14} className="animate-spin" /> : <FileUp size={14} />}
                {isSubmitting ? "Staging..." : "Stage Multi-Year Data"}
              </button>
            </div>
          </div>
        )}

        {!isLocked && step === 2 && (
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

        {!isLocked && step === 3 && (
          <div className="py-10 flex flex-col items-center justify-center text-center rounded-lg border border-primary/30 bg-primary/5 px-4">
            <CheckCircle className="text-primary mb-4" size={48} />
            <h3 className="text-xl font-bold text-text-primary mb-2">
              Multi-year Staging Complete
            </h3>
            <p className="text-secondary max-w-2xl">
              Multi-year GL transactions are normalized into staged tables and ready for manual report generation.
            </p>

            {stageResult ? (
              <div className="mt-4 w-full max-w-3xl rounded-lg border border-border bg-bg-card p-4 text-left">
                <h4 className="text-[14px] font-semibold text-text-primary mb-2">Batch Summary</h4>
                <div className="grid grid-cols-1 gap-1 text-[12px] text-secondary sm:grid-cols-2">
                  <p>Batch ID: <span className="font-medium text-text-primary">{stageResult.batchId}</span></p>
                  <p>Inserted Transactions: <span className="font-medium text-text-primary">{stageResult.insertedTransactions || 0}</span></p>
                  <p>Duplicates Skipped: <span className="font-medium text-text-primary">{stageResult.duplicateTransactionsSkipped || 0}</span></p>
                  <p>Warnings: <span className="font-medium text-text-primary">{Array.isArray(stageResult.warnings) ? stageResult.warnings.length : 0}</span></p>
                  <p>GL Files Parsed: <span className="font-medium text-text-primary">{Array.isArray(stageResult.filesParsed) ? stageResult.filesParsed.length : 0}</span></p>
                  <p>Years Detected: <span className="font-medium text-text-primary">{Array.isArray(stageResult.yearsDetected) && stageResult.yearsDetected.length ? stageResult.yearsDetected.join(", ") : "-"}</span></p>
                </div>
              </div>
            ) : null}

            {balanceSheetValidation ? (
              <div className="mt-4 w-full max-w-3xl rounded-lg border border-border bg-bg-card p-4 text-left">
                <h4 className="text-[14px] font-semibold text-text-primary mb-2">Balance Sheet Validation</h4>
                <p className={`text-[13px] ${balanceSheetValidation.isValid ? "text-green-700" : "text-red-600"}`}>
                  {balanceSheetValidation.isValid
                    ? "Opening + Net Income +/- Adjustments matches Closing balance."
                    : "Validation detected mismatches. Review details before final reporting."}
                </p>
                <div className="mt-2 grid grid-cols-1 gap-1 text-[12px] text-secondary sm:grid-cols-2">
                  <p>Opening Balance: {balanceSheetValidation.openingBalance ?? 0}</p>
                  <p>Closing Balance: {balanceSheetValidation.closingBalance ?? 0}</p>
                  <p>Net Income: {balanceSheetValidation.netIncome ?? 0}</p>
                  <p>Adjustments: {balanceSheetValidation.adjustments ?? 0}</p>
                  <p>Mismatched Accounts: {Array.isArray(balanceSheetValidation.mismatches) ? balanceSheetValidation.mismatches.length : 0}</p>
                  <p>Missing in Ending: {Array.isArray(balanceSheetValidation.missingInEnding) ? balanceSheetValidation.missingInEnding.length : 0}</p>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-[12px] text-secondary">
                No balance sheet validation was run because starting and ending balance sheets were not both provided.
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
