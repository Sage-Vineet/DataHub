import { useEffect, useState } from 'react';
import { Archive, Download, Eye, File, FileText, Loader2, X, AlertCircle, CheckCircle, Clock } from 'lucide-react';
import * as XLSX from 'xlsx';
import { useAuth } from '../context/AuthContext';
import { fetchProtectedFileBlob, recordDocumentActivity } from '../lib/api';

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const TEXT_EXTENSIONS = ['txt', 'md', 'json', 'log', 'xml', 'html', 'htm', 'yaml', 'yml'];
const DELIMITED_EXTENSIONS = ['csv', 'tsv'];
const SPREADSHEET_EXTENSIONS = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'];

function getMimeIcon(ext) {
  const normalized = (ext || '').toLowerCase();
  if (normalized === 'pdf') return { Icon: FileText, color: '#E74C3C', bg: '#FDECEA' };
  if ([...SPREADSHEET_EXTENSIONS, ...DELIMITED_EXTENSIONS].includes(normalized)) return { Icon: FileText, color: '#27AE60', bg: '#E8F8F0' };
  if (['doc', 'docx'].includes(normalized)) return { Icon: FileText, color: '#2980B9', bg: '#EBF5FB' };
  if (['ppt', 'pptx'].includes(normalized)) return { Icon: FileText, color: '#E67E22', bg: '#FEF5E7' };
  if (IMAGE_EXTENSIONS.includes(normalized)) return { Icon: Eye, color: '#9B59B6', bg: '#F5EEF8' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(normalized)) return { Icon: Archive, color: '#7F8C8D', bg: '#F2F3F4' };
  if (TEXT_EXTENSIONS.includes(normalized)) return { Icon: FileText, color: '#6D6E71', bg: '#F4F6F7' };
  return { Icon: File, color: '#95A5A6', bg: '#F2F3F4' };
}

function getFileKind(ext) {
  const normalized = (ext || '').toLowerCase();
  if (normalized === 'pdf') return 'PDF Document';
  if (IMAGE_EXTENSIONS.includes(normalized)) return 'Image File';
  if (DELIMITED_EXTENSIONS.includes(normalized)) return 'Delimited Spreadsheet';
  if (TEXT_EXTENSIONS.includes(normalized)) return 'Text Document';
  if (SPREADSHEET_EXTENSIONS.includes(normalized)) return 'Spreadsheet';
  if (['doc', 'docx'].includes(normalized)) return 'Word Document';
  if (['ppt', 'pptx'].includes(normalized)) return 'Presentation';
  return normalized ? `${normalized.toUpperCase()} File` : 'Document';
}

function canInlinePreview(ext) {
  const normalized = (ext || '').toLowerCase();
  return ['pdf', ...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...SPREADSHEET_EXTENSIONS, ...DELIMITED_EXTENSIONS].includes(normalized);
}

const STATUS_META = {
  verified: { label: 'Verified', color: '#476E2C', bg: '#E6F3D3', Icon: CheckCircle },
  'under-review': { label: 'Under Review', color: '#b45e08', bg: '#FAC086', Icon: Clock },
  rejected: { label: 'Rejected', color: '#C62026', bg: '#F9D6D6', Icon: AlertCircle },
};

function getStatusMeta(status) {
  return STATUS_META[status] || STATUS_META['under-review'];
}

function buildSpreadsheetPreview(workbook) {
  const sheetNames = workbook.SheetNames || [];
  return sheetNames
    .map((name) => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
        raw: false,
      });
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const normalizedRows = rows.slice(0, 101).map((row) =>
        Array.from({ length: Math.min(width, 16) }, (_, index) => row[index] ?? '')
      );
      return {
        name,
        totalRows: rows.length,
        totalColumns: width,
        rows: normalizedRows,
        truncated: rows.length > 101 || width > 16,
      };
    })
    .filter((sheet) => sheet.rows.length > 0);
}

export default function RequestDocumentPreviewModal({ document: previewDocument, onClose }) {
  const { user } = useAuth();
  const [blobUrl, setBlobUrl] = useState('');
  const [textPreview, setTextPreview] = useState('');
  const [spreadsheetPreview, setSpreadsheetPreview] = useState([]);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const normalizedExt = (previewDocument?.ext || '').toLowerCase();
  const { Icon, color, bg } = getMimeIcon(previewDocument?.ext);
  const isImage = IMAGE_EXTENSIONS.includes(normalizedExt);
  const isPdf = normalizedExt === 'pdf';
  const isText = TEXT_EXTENSIONS.includes(normalizedExt);
  const isSpreadsheet = [...SPREADSHEET_EXTENSIONS, ...DELIMITED_EXTENSIONS].includes(normalizedExt);
  const canPreview = canInlinePreview(previewDocument?.ext) && Boolean(previewDocument?.fileUrl);
  const statusMeta = getStatusMeta(previewDocument?.status);
  const StatusIcon = statusMeta.Icon;
  const activeSheet = spreadsheetPreview[activeSheetIndex] || spreadsheetPreview[0];
  const shouldRecordActivity = !['broker', 'admin'].includes(`${user?.role || user?.effective_role || ''}`.toLowerCase());

  useEffect(() => {
    if (!previewDocument?.id || !shouldRecordActivity) return;
    recordDocumentActivity(previewDocument.id, 'view').catch(() => {});
  }, [previewDocument?.id, shouldRecordActivity]);

  useEffect(() => {
    let revokedUrl = '';
    let active = true;

    /* eslint-disable react-hooks/set-state-in-effect -- This effect owns the external file fetch lifecycle and resets stale preview state before loading the next file. */
    setBlobUrl('');
    setTextPreview('');
    setSpreadsheetPreview([]);
    setActiveSheetIndex(0);
    setPreviewError('');

    if (!previewDocument?.fileUrl || !canPreview) {
      return undefined;
    }

    setLoadingPreview(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchProtectedFileBlob(previewDocument.fileUrl)
      .then(async (blob) => {
        if (!active) return;
        const objectUrl = URL.createObjectURL(blob);
        revokedUrl = objectUrl;
        setBlobUrl(objectUrl);
        if (isText) {
          const text = await blob.text();
          if (!active) return;
          setTextPreview(text);
        }
        if (isSpreadsheet) {
          const workbook = DELIMITED_EXTENSIONS.includes(normalizedExt)
            ? XLSX.read(await blob.text(), { type: 'string', FS: normalizedExt === 'tsv' ? '\t' : ',' })
            : XLSX.read(await blob.arrayBuffer(), { type: 'array', cellDates: true });
          if (!active) return;
          const sheets = buildSpreadsheetPreview(workbook);
          setSpreadsheetPreview(sheets);
          if (!sheets.length) setPreviewError('No readable sheets were found in this spreadsheet.');
        }
      })
      .catch((err) => {
        if (!active) return;
        setPreviewError(err.message || 'Unable to load document preview.');
      })
      .finally(() => {
        if (active) setLoadingPreview(false);
      });

    return () => {
      active = false;
      if (revokedUrl) URL.revokeObjectURL(revokedUrl);
    };
  }, [previewDocument?.id, previewDocument?.fileUrl, canPreview, isText, isSpreadsheet, normalizedExt]);

  useEffect(() => {
    if (!previewDocument) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [previewDocument, onClose]);

  if (!previewDocument) return null;

  const handleDownload = async () => {
    if (!previewDocument?.fileUrl) return;
    let objectUrl = blobUrl;
    let shouldRevoke = false;
    if (!objectUrl) {
      const blob = await fetchProtectedFileBlob(previewDocument.fileUrl);
      objectUrl = URL.createObjectURL(blob);
      shouldRevoke = true;
    }
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = previewDocument.name || 'document';
    link.click();
    if (shouldRecordActivity) {
      recordDocumentActivity(previewDocument.id, 'download').catch(() => {});
    }
    if (shouldRevoke) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const metaItems = [
    { label: 'Name', value: previewDocument.name || '—' },
    { label: 'Type', value: getFileKind(previewDocument.ext) },
    { label: 'Uploaded on', value: previewDocument.uploadedAt || '—' },
    { label: 'Uploaded by', value: previewDocument.uploadedBy || '—' },
    { label: 'File size', value: previewDocument.size || '—' },
    { label: 'Status', value: statusMeta.label },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/35 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="h-[94vh] w-full max-w-6xl overflow-hidden rounded-[28px] bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 p-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl" style={{ background: bg }}>
              <Icon size={20} style={{ color }} />
            </div>
            <div className="min-w-0">
              <p className="truncate font-semibold text-[#050505]">{previewDocument.name}</p>
              <p className="text-xs text-[#A5A5A5]">{previewDocument.size || 'Unknown size'} · {(previewDocument.ext || 'file').toUpperCase()}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-[#6D6E71] transition-colors hover:bg-gray-100">
            <X size={18} />
          </button>
        </div>

        <div className="grid h-[calc(94vh-81px)] lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="overflow-hidden border-r border-gray-100 bg-[#F8FAFC] p-5 lg:p-6">
            <div className="h-full overflow-hidden rounded-[24px] border border-gray-100 bg-white shadow-sm">
              {loadingPreview ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-[#6D6E71]">
                  <Loader2 size={28} className="animate-spin" />
                  <p className="text-sm font-medium">Loading preview...</p>
                </div>
              ) : previewError ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: bg }}>
                    <Icon size={28} style={{ color }} />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-[#050505]">Preview unavailable</p>
                    <p className="mt-1 text-sm text-[#6D6E71]">{previewError}</p>
                  </div>
                </div>
              ) : isImage && blobUrl ? (
                <div className="h-full overflow-auto bg-[radial-gradient(circle_at_top,#f8fafc,#eef2f7)] p-6">
                  <img src={blobUrl} alt={previewDocument.name} className="mx-auto h-auto max-w-full rounded-2xl border border-gray-100 shadow-lg" />
                </div>
              ) : isPdf && blobUrl ? (
                <iframe title={previewDocument.name} src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=1`} className="h-full w-full bg-white" />
              ) : isSpreadsheet && activeSheet ? (
                <div className="flex h-full flex-col bg-white">
                  <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-[#FCFCFD] p-3">
                    {spreadsheetPreview.map((sheet, index) => (
                      <button
                        type="button"
                        key={sheet.name}
                        onClick={() => setActiveSheetIndex(index)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                          index === activeSheetIndex
                            ? 'bg-[#05164D] text-white'
                            : 'bg-white text-[#6D6E71] ring-1 ring-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        {sheet.name}
                      </button>
                    ))}
                  </div>
                  <div className="border-b border-gray-100 px-4 py-2 text-xs font-medium text-[#6D6E71]">
                    Showing up to 100 rows and 16 columns from {activeSheet.totalRows} rows x {activeSheet.totalColumns} columns.
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto">
                    <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
                      <tbody>
                        {activeSheet.rows.map((row, rowIndex) => (
                          <tr key={`row-${rowIndex}`} className={rowIndex === 0 ? 'bg-[#F8FAFC]' : 'bg-white'}>
                            {row.map((cell, cellIndex) => (
                              <td
                                key={`cell-${rowIndex}-${cellIndex}`}
                                className={`max-w-[260px] whitespace-nowrap border-b border-r border-gray-100 px-3 py-2 text-[#2B2F38] ${
                                  rowIndex === 0 ? 'font-semibold text-[#050505]' : ''
                                }`}
                              >
                                <span className="block overflow-hidden text-ellipsis">{String(cell || '')}</span>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {activeSheet.truncated ? (
                    <div className="border-t border-gray-100 bg-[#FCFCFD] px-4 py-2 text-xs text-[#6D6E71]">
                      Preview trimmed for performance. Download the file to view the full workbook.
                    </div>
                  ) : null}
                </div>
              ) : isText ? (
                <div className="h-full overflow-auto bg-[#FCFCFD] p-6">
                  <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-6 text-[#2B2F38]">
                    {textPreview || 'No text content available.'}
                  </pre>
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-3xl" style={{ background: bg }}>
                    <Icon size={38} style={{ color }} />
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-[#050505]">{previewDocument.name}</p>
                    <p className="mt-1 text-sm text-[#6D6E71]">
                      {previewDocument.fileUrl ? 'This file type does not support inline preview yet.' : 'This document is not available for preview yet.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="flex h-full flex-col bg-white">
            <div className="border-b border-gray-100 p-5">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: statusMeta.bg, color: statusMeta.color }}>
                  <StatusIcon size={12} />
                  {statusMeta.label}
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {metaItems.map((item) => (
                  <div key={item.label} className="rounded-2xl bg-[#F8FAFC] px-4 py-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">{item.label}</p>
                    <p className="mt-1 break-words text-sm font-semibold text-[#050505]">{item.value}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="p-5">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!previewDocument.fileUrl}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[#05164D] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#0b2a79] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-[#A5A5A5]"
              >
                <Download size={15} />
                Download file
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
