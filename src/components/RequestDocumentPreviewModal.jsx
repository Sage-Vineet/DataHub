import { useEffect, useState } from 'react';
import { Archive, Download, Eye, File, FileText, Loader2, X, AlertCircle, CheckCircle, Clock } from 'lucide-react';
import { fetchProtectedFileBlob } from '../lib/api';

function getMimeIcon(ext) {
  const normalized = (ext || '').toLowerCase();
  if (normalized === 'pdf') return { Icon: FileText, color: '#E74C3C', bg: '#FDECEA' };
  if (['xlsx', 'xls', 'csv'].includes(normalized)) return { Icon: FileText, color: '#27AE60', bg: '#E8F8F0' };
  if (['doc', 'docx'].includes(normalized)) return { Icon: FileText, color: '#2980B9', bg: '#EBF5FB' };
  if (['ppt', 'pptx'].includes(normalized)) return { Icon: FileText, color: '#E67E22', bg: '#FEF5E7' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(normalized)) return { Icon: Eye, color: '#9B59B6', bg: '#F5EEF8' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(normalized)) return { Icon: Archive, color: '#7F8C8D', bg: '#F2F3F4' };
  if (['txt', 'md', 'json'].includes(normalized)) return { Icon: FileText, color: '#6D6E71', bg: '#F4F6F7' };
  return { Icon: File, color: '#95A5A6', bg: '#F2F3F4' };
}

function getFileKind(ext) {
  const normalized = (ext || '').toLowerCase();
  if (normalized === 'pdf') return 'PDF Document';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(normalized)) return 'Image File';
  if (['txt', 'md', 'json'].includes(normalized)) return 'Text Document';
  if (['xlsx', 'xls', 'csv'].includes(normalized)) return 'Spreadsheet';
  if (['doc', 'docx'].includes(normalized)) return 'Word Document';
  if (['ppt', 'pptx'].includes(normalized)) return 'Presentation';
  return normalized ? `${normalized.toUpperCase()} File` : 'Document';
}

function canInlinePreview(ext) {
  const normalized = (ext || '').toLowerCase();
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'md', 'json'].includes(normalized);
}

const STATUS_META = {
  verified: { label: 'Verified', color: '#476E2C', bg: '#E6F3D3', Icon: CheckCircle },
  'under-review': { label: 'Under Review', color: '#b45e08', bg: '#FAC086', Icon: Clock },
  rejected: { label: 'Rejected', color: '#C62026', bg: '#F9D6D6', Icon: AlertCircle },
};

function getStatusMeta(status) {
  return STATUS_META[status] || STATUS_META['under-review'];
}

export default function RequestDocumentPreviewModal({ document: previewDocument, onClose }) {
  const [blobUrl, setBlobUrl] = useState('');
  const [textPreview, setTextPreview] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const normalizedExt = (previewDocument?.ext || '').toLowerCase();
  const { Icon, color, bg } = getMimeIcon(previewDocument?.ext);
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(normalizedExt);
  const isPdf = normalizedExt === 'pdf';
  const isText = ['txt', 'md', 'json'].includes(normalizedExt);
  const canPreview = canInlinePreview(previewDocument?.ext) && Boolean(previewDocument?.fileUrl);
  const statusMeta = getStatusMeta(previewDocument?.status);
  const StatusIcon = statusMeta.Icon;

  useEffect(() => {
    let revokedUrl = '';
    let active = true;

    setBlobUrl('');
    setTextPreview('');
    setPreviewError('');

    if (!previewDocument?.fileUrl || !canPreview) {
      return undefined;
    }

    setLoadingPreview(true);
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
  }, [previewDocument?.id, previewDocument?.fileUrl, canPreview, isText]);

  useEffect(() => {
    if (!previewDocument) return undefined;
    const handleEscape = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [previewDocument, onClose]);

  if (!previewDocument) return null;

  const handleDownload = () => {
    if (!blobUrl) return;
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = previewDocument.name || 'document';
    link.click();
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
                disabled={!blobUrl}
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
