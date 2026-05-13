import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useParams } from 'react-router-dom';
import { useAuth } from '../../../context/AuthContext';
import {
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  Download,
  FileText,
  LayoutGrid,
  List,
  Loader2,
  Pencil,
  Scale,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  TrendingUp,
  Upload,
  AlertTriangle,
  X,
  XCircle,
} from 'lucide-react';
import {
  attachRequestDocument,
  approveRequest,
  createCompanyBulkRequestItems,
  createCompanyRequestItem,
  createRequestReminder,
  deleteRequest,
  getCompanyRequest,
  listFolderTree,
  listCompanyRequests,
  listRequestDocuments,
  updateRequest,
  updateRequestNarrative,
} from '../../../lib/api';
import NewRequestModal from '../../../components/NewRequestModal';
import RequestDocumentPreviewModal from '../../../components/RequestDocumentPreviewModal';
import { buildFolderOptionsFromTree } from '../../../lib/folderOptions';

const CATEGORY_META = {
  Finance: { icon: TrendingUp, color: '#00648F', bg: '#A7DCF7' },
  Legal: { icon: Scale, color: '#742982', bg: '#EBD5F0' },
  Compliance: { icon: ShieldCheck, color: '#8BC53D', bg: '#E6F3D3' },
  HR: { icon: ShieldCheck, color: '#F68C1F', bg: '#FDE7D2' },
  Tax: { icon: TrendingUp, color: '#476E2C', bg: '#E6F3D3' },
  'M&A': { icon: Scale, color: '#05164D', bg: '#E8ECF7' },
  Other: { icon: ShieldCheck, color: '#6D6E71', bg: '#F3F4F6' },
};

const STATUS_META = {
  pending: { label: 'Pending', bg: '#F3F4F6', color: '#6D6E71', icon: Clock },
  'in-review': { label: 'In Review', bg: '#DBEAFE', color: '#2563EB', icon: Loader2 },
  completed: { label: 'Completed', bg: '#DCFCE7', color: '#166534', icon: CheckCircle2 },
  overdue: { label: 'Overdue', bg: '#FEE2E2', color: '#B91C1C', icon: XCircle },
  blocked: { label: 'Blocked', bg: '#FEE2E2', color: '#991B1B', icon: AlertTriangle },
};

const PRIORITY_META = {
  critical: { label: 'Critical', bg: '#DC2626', color: '#FFFFFF' },
  high: { label: 'High', bg: '#F68C1F', color: '#FFFFFF' },
  medium: { label: 'Medium', bg: '#FACC15', color: '#111827' },
  low: { label: 'Low', bg: '#8BC53D', color: '#FFFFFF' },
};

const CATEGORY_ORDER = ['Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A', 'Other'];
const RESPONSE_TYPE_OPTIONS = ['Upload', 'Narrative', 'Both'];
const PRIORITY_OPTIONS = ['critical', 'high', 'medium', 'low'];
const BULK_TEMPLATE_HEADERS = ['title', 'sub_label', 'description', 'category', 'response_type', 'priority', 'due_date', 'assigned_to', 'visible'];

function normalizeVisibleFlag(value) {
  if (typeof value === 'boolean') return value;
  const normalized = `${value ?? ''}`.trim().toLowerCase();
  if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  return true;
}

function isEmptyBulkRow(row) {
  return Object.values(row || {}).every((value) => `${value ?? ''}`.trim() === '');
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildBulkTemplateWorkbook(folderOptions) {
  const folderNames = folderOptions.length
    ? folderOptions.map((folder) => (typeof folder === 'string' ? folder : folder.name)).filter(Boolean)
    : CATEGORY_ORDER;
  const sampleFolder = folderNames[0] || 'Compliance';
  const sampleCategory = mapToCategory({
    name: 'GST Certificate',
    subLabel: sampleFolder,
    description: 'Upload the latest signed GST certificate for review.',
    category: sampleFolder,
  });

  const templateSheet = XLSX.utils.json_to_sheet([
    {
      title: 'GST Certificate',
      sub_label: sampleFolder,
      description: 'Upload the latest signed GST certificate for review.',
      category: sampleCategory,
      response_type: 'Upload',
      priority: 'high',
      due_date: formatTomorrow(),
      assigned_to: '',
      visible: 'true',
    },
  ], { header: BULK_TEMPLATE_HEADERS });

  templateSheet['!cols'] = BULK_TEMPLATE_HEADERS.map((header) => ({
    wch: header === 'description' ? 42 : 18,
  }));

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ['Field', 'Required', 'Guidance'],
    ['title', 'Yes', 'Request title shown to the client.'],
    ['sub_label', 'No', 'Optional short label; use the folder name here if the request maps to a specific folder.'],
    ['description', 'Yes', 'Short request description or instructions.'],
    ['category', 'Yes', `Use one of: ${CATEGORY_ORDER.join(', ')}`],
    ['response_type', 'Yes', `Use one of: ${RESPONSE_TYPE_OPTIONS.join(', ')}`],
    ['priority', 'Yes', `Use one of: ${PRIORITY_OPTIONS.join(', ')}`],
    ['due_date', 'Yes', 'Format must be YYYY-MM-DD.'],
    ['assigned_to', 'No', 'Optional user id for assignment. Leave blank if unassigned.'],
    ['visible', 'No', 'Use true or false. Blank defaults to true.'],
  ]);

  instructionsSheet['!cols'] = [
    { wch: 18 },
    { wch: 10 },
    { wch: 70 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, templateSheet, 'Requests');
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, 'Instructions');
  return workbook;
}

function readBulkWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      try {
        const workbook = XLSX.read(event.target?.result, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) {
          reject(new Error('The uploaded workbook does not contain any sheets.'));
          return;
        }

        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
          defval: '',
          raw: false,
        });
        resolve(rows);
      } catch (error) {
        reject(new Error('Unable to read the uploaded Excel file.'));
      }
    };

    reader.onerror = () => reject(new Error('Unable to read the selected file.'));
    reader.readAsArrayBuffer(file);
  });
}

function mapToCategory(item) {
  const text = `${item.name} ${item.subLabel || ''} ${item.description || ''}`.toLowerCase();
  if (text.includes('revenue recognition') || text.includes('trial balance')) return 'Finance';
  if (text.includes('litigation') || text.includes('arbitration')) return 'Legal';
  if (text.includes('tax') || text.includes('regulatory') || text.includes('compliance') || text.includes('gst')) return 'Compliance';
  if (text.includes('hr') || text.includes('people') || text.includes('employment')) return 'HR';
  if (text.includes('m&a') || text.includes('merger') || text.includes('acquisition')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('finance')) return 'Finance';
  if ((item.category || '').toLowerCase().includes('legal')) return 'Legal';
  if ((item.category || '').toLowerCase().includes('tax')) return 'Tax';
  if ((item.category || '').toLowerCase().includes('hr')) return 'HR';
  if ((item.category || '').toLowerCase().includes('m&a')) return 'M&A';
  if ((item.category || '').toLowerCase().includes('compliance')) return 'Compliance';
  return 'Other';
}

function normalizeWorkflowStatus(status) {
  if (['awaiting-review', 'in-progress', 'submitted', 'in-review'].includes(status)) return 'in-review';
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'blocked';
  return 'pending';
}

function getDisplayStatus(workflowStatus, dueDate) {
  if (workflowStatus === 'blocked') return 'blocked';
  const date = new Date(dueDate);
  const isOverdue = date < new Date() && workflowStatus !== 'completed';
  if (isOverdue) return 'overdue';
  return workflowStatus;
}

function normalizePriority(priority) {
  const normalized = `${priority ?? ''}`.trim();
  return normalized || 'medium';
}

function getReminderFrequencyDays(priority, explicitDays) {
  const normalized = `${priority ?? ''}`.trim().toLowerCase();
  const priorityDays = normalized === 'critical' || normalized === 'high' ? 1 : normalized === 'medium' ? 2 : 7;
  const parsed = Number.parseInt(explicitDays, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed === 2 && normalized !== 'medium' ? priorityDays : parsed;
  }
  return priorityDays;
}

function getReminderFrequencyLabel(days) {
  if (days === 1) return 'daily';
  if (days === 7) return 'weekly';
  return `every ${days} days`;
}

function getPriorityMeta(priority) {
  const normalized = `${priority ?? ''}`.trim().toLowerCase();
  if (PRIORITY_META[normalized]) return PRIORITY_META[normalized];
  return {
    label: `${priority || 'Custom'}`,
    bg: '#DBEAFE',
    color: '#1D4ED8',
  };
}

function normalizeType(item) {
  const type = (item.responseType || '').toLowerCase();
  const hasFolderBinding = Boolean((item.subLabel || '').trim());
  if (type === 'upload') {
    return hasFolderBinding ? 'Both' : item.responseType;
  }
  if (type === 'both') return item.responseType;
  if (type === 'narrative') {
    return hasFolderBinding ? 'Both' : item.responseType;
  }
  return hasFolderBinding ? 'Both' : 'Narrative';
}

function formatToday() {
  return new Date().toISOString().slice(0, 10);
}

function getDocumentExt(doc) {
  if (doc?.ext) return `${doc.ext}`.toLowerCase();
  const name = doc?.name || '';
  const parts = name.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function mapRequestDocumentToUi(doc, fallbackUploadedBy = 'Client') {
  return {
    id: doc.id || doc.document_id,
    name: doc.name || doc.document_id || doc.id,
    uploadedBy: doc.uploaded_by_name || doc.uploadedBy || fallbackUploadedBy,
    uploadedAt: doc.uploaded_at
      ? doc.uploaded_at.slice(0, 10)
      : doc.created_at
      ? doc.created_at.slice(0, 10)
      : formatToday(),
    visible: doc.visible !== false,
    size: doc.size || '—',
    ext: getDocumentExt(doc),
    status: doc.status || 'under-review',
    fileUrl: doc.file_url || doc.fileUrl || '',
  };
}

function formatTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: meta.bg, color: meta.color }}>
      <Icon size={11} />
      {meta.label}
    </span>
  );
}
function mapApiRequestToUi(request) {
  if (!request) return null;
  const category = request.category || mapToCategory({
    name: request.title || '',
    subLabel: request.sub_label || '',
    description: request.description || '',
  });
  const reminderFrequencyDays = getReminderFrequencyDays(request.priority, request.reminder_frequency_days);
  return {
    id: request.id,
    name: request.title || 'Untitled Request',
    subLabel: request.sub_label || '',
    description: request.description || 'No description provided.',
    category,
    responseType: normalizeType({
      responseType: request.response_type || '',
      subLabel: request.sub_label || '',
    }),
    priority: normalizePriority(request.priority),
    workflowStatus: normalizeWorkflowStatus(request.status),
    dueDate: request.due_date ? request.due_date.slice(0, 10) : formatToday(),
    createdAt: request.created_at ? request.created_at.slice(0, 10) : formatToday(),
    updatedAt: request.updated_at ? request.updated_at.slice(0, 10) : (request.created_at ? request.created_at.slice(0, 10) : formatToday()),
    assignedTo: request.assigned_to || 'Unassigned',
    visible: request.visible !== false,
    approvalStatus: request.approval_status || 'approved',
    submissionSource: request.submission_source || 'broker',
    requestedBy: request.created_by_name || 'Unknown user',
    approvedBy: request.approved_by_name || '',
    narrativeResponse: '',
    linkedDocuments: [],
    reminderHistory: [],
    reminderFrequencyDays,
    notificationFrequency: getReminderFrequencyLabel(reminderFrequencyDays),
  };
}

function mapUiPatchToApi(patch) {
  const apiPatch = {};
  if (patch.name !== undefined) apiPatch.title = patch.name;
  if (patch.description !== undefined) apiPatch.description = patch.description;
  if (patch.priority !== undefined) apiPatch.priority = patch.priority;
  if (patch.workflowStatus !== undefined) apiPatch.status = patch.workflowStatus;
  if (patch.dueDate !== undefined) apiPatch.due_date = patch.dueDate;
  if (patch.assignedTo !== undefined && patch.assignedTo !== 'Unassigned') apiPatch.assigned_to = patch.assignedTo;
  if (patch.visible !== undefined) apiPatch.visible = patch.visible;
  return apiPatch;
}

function buildCreateRequestPayload(form) {
  const folderLabel = form.requestType === 'Information' ? '' : (form.category || '').trim();
  const resolvedCategory = mapToCategory({
    name: form.name?.trim() || '',
    subLabel: folderLabel,
    description: form.description?.trim() || '',
    category: folderLabel,
  });
  const responseType = form.requestType === 'Information' ? 'Narrative' : 'Both';

  return {
    title: form.name.trim(),
      sub_label: folderLabel,
      description: form.description.trim(),
      category: resolvedCategory,
      response_type: responseType,
      priority: normalizePriority(form.priority),
      status: 'pending',
      due_date: form.dueDate,
      assigned_to: null,
    visible: true,
  };
}
function VisibilityToggle({ value, onChange }) {
  return (
    <button
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${value ? 'bg-[#8BC53D]' : 'bg-gray-300'}`}
      aria-label="Toggle visibility"
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${value ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  );
}

function CategoryCard({ category, requestsInCategory, onClick }) {
  const meta = CATEGORY_META[category];
  const Icon = meta.icon;
  const total = requestsInCategory.length;
  const completed = requestsInCategory.filter(r => r.status === 'completed').length;
  const pending = total - completed;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  return (
    <button
      onClick={onClick}
      className="text-left bg-white rounded-2xl shadow-card hover:shadow-hover p-5 transition-all duration-200 hover:-translate-y-0.5 border border-transparent hover:border-[#8BC53D]/30"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: meta.bg }}>
          <Icon size={20} style={{ color: meta.color }} />
        </div>
        <span className="text-xs font-semibold text-[#6D6E71]">{total} Requests</span>
      </div>
      <h3 className="text-lg font-bold text-[#050505]">{category}</h3>
      <p className="text-sm text-[#6D6E71] mt-1">{completed} Completed � {pending} Pending</p>
      <div className="mt-4 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
      </div>
      <p className="mt-1 text-xs text-[#A5A5A5]">Progress: {pct}%</p>
    </button>
  );
}

function RequestRow({ item, onView, onApprove, approving }) {
  const priority = getPriorityMeta(item.priority);
  const canApprove = item.submissionSource === 'user' && item.approvalStatus === 'pending';
  const canReview = item.workflowStatus === 'in-review';
  return (
    <tr className="border-b border-gray-50 hover:bg-gray-50/70 transition-colors">
      <td className="px-4 py-3 text-xs font-bold text-[#6D6E71] font-mono">{item.id}</td>
      <td className="px-4 py-3">
        <p className="font-semibold text-[#050505] leading-tight">{item.name}</p>
        {item.subLabel && <p className="text-xs text-[#A5A5A5] mt-0.5">{item.subLabel}</p>}
        {item.submissionSource === 'user' && (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[#6D6E71]">Requested by {item.requestedBy}</span>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              item.approvalStatus === 'pending'
                ? 'bg-[#FEF3C7] text-[#A86F0B]'
                : 'bg-[#E6F3D3] text-[#476E2C]'
            }`}>
              {item.approvalStatus === 'pending' ? 'Awaiting Approval' : 'Approved'}
            </span>
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs px-2.5 py-1 rounded-full bg-gray-100 text-[#6D6E71] font-semibold">{item.responseType}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: priority.bg, color: priority.color }}>
          {priority.label}
        </span>
      </td>
      <td className="px-4 py-3 text-center text-sm font-semibold text-[#050505]">{item.linkedDocuments.length}</td>
      <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
      <td className="px-4 py-3 text-center">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${item.visible ? 'bg-[#E6F3D3] text-[#476E2C]' : 'bg-gray-100 text-[#A5A5A5]'}`}>
          {item.visible ? 'Yes' : 'No'}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        <div className="flex items-center justify-center gap-2">
          {canApprove && (
            <button
              onClick={() => onApprove(item)}
              disabled={approving}
              className="px-3 py-1.5 rounded-lg bg-[#8BC53D] text-white text-xs font-semibold hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60 transition-colors"
            >
              {approving ? 'Approving...' : 'Approve'}
            </button>
          )}
          {canReview && (
            <button
              onClick={() => onView(item)}
              className="px-3 py-1.5 rounded-lg bg-[#8BC53D] text-white text-xs font-semibold hover:bg-[#476E2C] transition-colors"
            >
              Review
            </button>
          )}
          <button
            onClick={() => onView(item)}
            className="px-3 py-1.5 rounded-lg bg-[#05164D] text-white text-xs font-semibold hover:bg-[#0b2a79] transition-colors"
          >
            View
          </button>
        </div>
      </td>
    </tr>
  );
}

function RequestTable({ rows, onView, onApprove, approvingRequestId }) {
  return (
    <div className="bg-white rounded-2xl shadow-card overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Request ID</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Request Name</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Type</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Priority</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Documents Count</th>
            <th className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Status</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Client Visibility</th>
            <th className="px-4 py-3 text-center text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <RequestRow
              key={r.id}
              item={r}
              onView={onView}
              onApprove={onApprove}
              approving={approvingRequestId === r.id}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CategoryGroupedTable({ grouped, onView, onApprove, approvingRequestId }) {
  return (
    <div className="bg-white rounded-2xl shadow-card overflow-x-auto">
      <table className="w-full min-w-[980px]">
        <thead>
          <tr className="bg-gray-50 border-b border-gray-100">
            {['Request ID', 'Request Name', 'Type', 'Priority', 'Documents', 'Status', 'Visibility', 'Action'].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grouped.map(g => {
            const meta = CATEGORY_META[g.category];
            const Icon = meta.icon;
            const rows = g.items.map(r => ({ ...r, status: getDisplayStatus(r.workflowStatus, r.dueDate) }));
            const completed = rows.filter(r => r.status === 'completed').length;
            const pct = rows.length ? Math.round((completed / rows.length) * 100) : 0;
            return (
              <Fragment key={g.category}>
                <tr>
                  <td colSpan={8} className="px-4 py-2.5 border-y border-gray-100" style={{ background: meta.bg + '60' }}>
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: meta.bg }}>
                        <Icon size={14} style={{ color: meta.color }} />
                      </div>
                      <span className="font-bold text-sm" style={{ color: meta.color }}>{g.category}</span>
                      <span className="text-xs text-[#6D6E71]">� {rows.length} requests � {completed} completed</span>
                      <div className="ml-auto flex items-center gap-2">
                        <span className="text-xs font-semibold" style={{ color: meta.color }}>{pct}%</span>
                        <div className="w-24 h-1.5 rounded-full overflow-hidden" style={{ background: meta.bg }}>
                          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
                {rows.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-4 text-center text-xs text-[#A5A5A5]">No requests in this category</td></tr>
                ) : rows.map(r => (
                  <RequestRow
                    key={r.id}
                    item={r}
                    onView={onView}
                    onApprove={onApprove}
                    approving={approvingRequestId === r.id}
                  />
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FileUpload({ onAddFiles, duplicateNames }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const processFiles = (files) => {
    if (!files.length) return;
    onAddFiles(files);
  };

  return (
    <div className="bg-white rounded-2xl shadow-card p-5">
      <h3 className="font-semibold text-[#050505] mb-3">File Upload</h3>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          processFiles(Array.from(e.dataTransfer.files));
        }}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${dragging ? 'border-[#8BC53D] bg-[#E6F3D3]/40' : 'border-gray-200 hover:border-[#00B0F0]/40 hover:bg-gray-50'}`}
      >
        <Upload size={22} className="mx-auto mb-2 text-[#A5A5A5]" />
        <p className="text-sm text-[#6D6E71]">Drag files here or click to upload</p>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
          className="mt-3 px-4 py-1.5 rounded-lg border border-gray-200 text-xs font-semibold text-[#6D6E71] hover:bg-gray-50"
        >
          Choose Files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => processFiles(Array.from(e.target.files || []))}
        />
      </div>
      <p className="text-[11px] text-[#A5A5A5] mt-2">Files can be attached to multiple requests. Warn on duplicates.</p>
      {duplicateNames.length > 0 && (
        <div className="mt-2 px-3 py-2 rounded-lg bg-[#FFF7ED] border border-[#FDBA74]">
          <p className="text-xs text-[#C2410C] font-medium">Duplicate warning: {duplicateNames.join(', ')}</p>
        </div>
      )}
    </div>
  );
}

function RequestDetailPage({ onBack, request, allRequests, onUpdateRequest, onSendReminder, onAttachDocument, onApproveRequest, approvingRequestId, onMarkReviewed, onDeleteRequest, deletingRequestId }) {
  const [duplicateWarning, setDuplicateWarning] = useState([]);
  const [narrativeDraft, setNarrativeDraft] = useState(request?.narrativeResponse || '');
  const [previewDocument, setPreviewDocument] = useState(null);
  const [requestDraft, setRequestDraft] = useState({
    name: request?.name || '',
    description: request?.description || '',
    priority: request?.priority || 'high',
    dueDate: request?.dueDate || formatToday(),
  });
  const [savingRequestDetails, setSavingRequestDetails] = useState(false);
  const [savingNarrative, setSavingNarrative] = useState(false);

  useEffect(() => {
    setNarrativeDraft(request?.narrativeResponse || '');
    setPreviewDocument(null);
    setRequestDraft({
      name: request?.name || '',
      description: request?.description || '',
      priority: request?.priority || 'high',
      dueDate: request?.dueDate || formatToday(),
    });
  }, [request?.id, request?.narrativeResponse]);

  if (!request) return null;

  const priority = getPriorityMeta(request.priority);
  const due = new Date(request.dueDate);
  const isOverdue = due < new Date() && request.workflowStatus !== 'completed' && request.workflowStatus !== 'blocked';
  const currentStatus = getDisplayStatus(request.workflowStatus, request.dueDate);
  const CategoryIcon = CATEGORY_META[request.category].icon;
  const needsApproval = request.submissionSource === 'user' && request.approvalStatus === 'pending';
  const canMarkReviewed = request.workflowStatus === 'in-review';
  const canEditRequestDetails = request.workflowStatus === 'pending';
  const canEditResponse = request.workflowStatus === 'in-review';
  const isCompleted = request.workflowStatus === 'completed';

  const allLinkedNames = allRequests.flatMap(r => r.linkedDocuments.map(d => d.name.toLowerCase()));

  const addFiles = (files) => {
    if (!canEditResponse) return;
    const duplicates = files.map(f => f.name).filter(name => allLinkedNames.includes(name.toLowerCase()));
    setDuplicateWarning(duplicates);

    const newDocs = files.map((f, idx) => ({
      id: `${request.id}-local-${Date.now()}-${idx}`,
      name: f.name,
      uploadedBy: 'Broker User',
      uploadedAt: formatToday(),
      visible: true,
      size: f.size?.toString() || '—',
      ext: getDocumentExt({ name: f.name }),
      status: 'under-review',
      fileUrl: '',
    }));

    onUpdateRequest(request.id, {
      linkedDocuments: [...request.linkedDocuments, ...newDocs],
      updatedAt: formatToday(),
    });
    if (onAttachDocument) {
      newDocs.forEach((doc) => {
        onAttachDocument(request.id, doc);
      });
    }
  };

  const sendReminder = () => {
    const entry = `Reminder sent on ${new Date().toLocaleString('en-IN')}`;
    onUpdateRequest(request.id, {
      reminderHistory: [entry, ...(request.reminderHistory || [])],
      updatedAt: formatToday(),
    });
    onSendReminder?.(request.id);
  };

  const saveRequestDetails = async () => {
    if (!canEditRequestDetails || savingRequestDetails) return;
    setSavingRequestDetails(true);
    await onUpdateRequest(request.id, {
      name: requestDraft.name.trim(),
      description: requestDraft.description.trim(),
      priority: requestDraft.priority,
      dueDate: requestDraft.dueDate,
      updatedAt: formatToday(),
    });
    setSavingRequestDetails(false);
  };

  const saveNarrative = async () => {
    if (!canEditResponse || savingNarrative) return;
    setSavingNarrative(true);
    await onUpdateRequest(request.id, {
      narrativeResponse: narrativeDraft,
      updatedAt: formatToday(),
    });
    setSavingNarrative(false);
  };

  return (
    <div className="space-y-6">
      <div className="bg-[#F8FAFC] rounded-2xl p-5 lg:p-7">
        <div className="flex items-center justify-between mb-4">
          <button onClick={onBack} className="flex items-center gap-2 text-sm text-[#6D6E71] hover:text-[#050505] transition-colors">
            <ArrowLeft size={14} /> Back
          </button>
          <button onClick={onBack} className="text-[#A5A5A5] hover:text-[#050505] p-1"><X size={18} /></button>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-5">
            <div className="rounded-2xl bg-white p-5 shadow-card">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-gray-100 px-2.5 py-1 font-mono text-xs font-bold text-[#6D6E71]">{request.id}</span>
                <StatusBadge status={currentStatus} />
              </div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#A5A5A5]">{request.subLabel || request.category}</p>
              {canEditRequestDetails ? (
                <div className="mt-3 space-y-4">
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Title</label>
                    <input
                      value={requestDraft.name}
                      onChange={(event) => setRequestDraft((current) => ({ ...current, name: event.target.value }))}
                      className="mt-1 w-full rounded-xl border border-gray-200 px-4 py-3 text-base font-semibold text-[#050505] sm:text-lg"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Description</label>
                    <textarea
                      rows={5}
                      value={requestDraft.description}
                      onChange={(event) => setRequestDraft((current) => ({ ...current, description: event.target.value }))}
                      className="mt-1 w-full resize-none rounded-xl border border-gray-200 px-4 py-3 text-sm leading-6 text-[#4B5563]"
                    />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Priority</label>
                      <select
                        value={requestDraft.priority}
                        onChange={(event) => setRequestDraft((current) => ({ ...current, priority: event.target.value }))}
                        className="mt-1 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm"
                      >
                        <option value="critical">Critical</option>
                        <option value="high">High</option>
                        <option value="medium">Medium</option>
                        <option value="low">Low</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[11px] font-semibold uppercase tracking-wide text-[#A5A5A5]">Due Date</label>
                      <input
                        type="date"
                        value={requestDraft.dueDate}
                        onChange={(event) => setRequestDraft((current) => ({ ...current, dueDate: event.target.value }))}
                        className="mt-1 w-full rounded-xl border border-gray-200 px-4 py-3 text-sm"
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={saveRequestDetails}
                    disabled={savingRequestDetails}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-[#A5A5A5]"
                  >
                    <Pencil size={14} />
                    {savingRequestDetails ? 'Saving...' : 'Save Request Details'}
                  </button>
                </div>
              ) : (
                <>
                  <h2 className="mt-2 text-2xl font-bold leading-tight text-[#050505] sm:text-3xl">{request.name}</h2>
                  <p className="mt-4 rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm leading-6 text-[#4B5563]">{request.description}</p>
                </>
              )}
            </div>

            <div className="bg-[#EFF6FF] rounded-2xl border border-[#BFDBFE] shadow-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="font-semibold text-[#050505] mb-1">Current Status</h3>
                  <StatusBadge status={currentStatus} />
                  <p className="mt-2 text-xs text-[#6D6E71]">
                    Requests move from pending to in review when the client submits files or information. Mark reviewed after broker review is complete.
                  </p>
                </div>
                {canMarkReviewed && (
                  <button
                    type="button"
                    onClick={() => onMarkReviewed?.(request.id)}
                    className="rounded-xl bg-[#8BC53D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C]"
                  >
                    Mark Reviewed
                  </button>
                )}
              </div>
            </div>

            {canEditResponse && (request.responseType === 'Upload' || request.responseType === 'Both') && (
              <FileUpload onAddFiles={addFiles} duplicateNames={duplicateWarning} />
            )}

            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-3">Linked Documents ({request.linkedDocuments.length})</h3>
              <div className="space-y-2">
                {request.linkedDocuments.map(doc => (
                  <div key={doc.id} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50 hover:bg-gray-100 transition-colors">
                    <FileText size={15} className="text-[#00B0F0]" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#050505] truncate">{doc.name}</p>
                      <p className="text-xs text-[#A5A5A5]">{doc.uploadedBy} � {doc.uploadedAt}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setPreviewDocument(doc)}
                      disabled={!doc.fileUrl}
                      className="rounded-lg border border-[#D8E2F0] bg-white px-3 py-1.5 text-xs font-semibold text-[#05164D] transition-colors hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-[#A5A5A5]"
                    >
                      View
                    </button>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[#E6F3D3] text-[#476E2C]">Client Visible</span>
                  </div>
                ))}
              </div>
            </div>

            {(request.responseType === 'Narrative' || request.responseType === 'Both') && (
              <div className="bg-white rounded-2xl shadow-card p-5">
                <h3 className="font-semibold text-[#050505] mb-3">Narrative Response</h3>
                <textarea
                  rows={5}
                  value={narrativeDraft}
                  readOnly={!canEditResponse}
                  onChange={(event) => setNarrativeDraft(event.target.value)}
                  placeholder="Enter explanation, comments, or notes related to this request"
                  className={`w-full resize-none rounded-xl border px-4 py-3 text-sm ${
                    canEditResponse
                      ? 'border-gray-200 bg-white text-[#4B5563]'
                      : 'border-gray-100 bg-gray-50 text-[#4B5563]'
                  }`}
                />
                {canEditResponse && (
                  <button
                    type="button"
                    onClick={saveNarrative}
                    disabled={savingNarrative}
                    className="mt-3 rounded-xl bg-[#05164D] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#0b2a79] disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-[#A5A5A5]"
                  >
                    {savingNarrative ? 'Saving...' : 'Save Narrative'}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-4 xl:sticky xl:top-5 h-fit">
            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-4">Request Summary</h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                {[
                  { label: 'Current Status', value: <StatusBadge status={currentStatus} /> },
                  { label: 'Priority', value: <span className="inline-flex rounded-full px-2.5 py-1 text-xs font-bold" style={{ background: priority.bg, color: priority.color }}>{priority.label}</span> },
                  { label: 'Category', value: <span className="inline-flex items-center gap-1.5 font-semibold text-[#050505]"><CategoryIcon size={14} style={{ color: CATEGORY_META[request.category].color }} />{request.category}</span> },
                  { label: 'Due Date', value: <span className={`font-semibold ${isOverdue ? 'text-[#B91C1C]' : 'text-[#050505]'}`}>{request.dueDate}</span> },
                  { label: 'Response Type', value: <span className="font-semibold text-[#050505]">{request.responseType}</span> },
                  { label: 'Assigned To', value: <span className="font-semibold text-[#050505]">{request.assignedTo}</span> },
                  { label: 'Created Date', value: <span className="font-semibold text-[#050505]">{request.createdAt}</span> },
                  { label: 'Last Updated', value: <span className="font-semibold text-[#050505]">{request.updatedAt}</span> },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#A5A5A5]">{item.label}</p>
                    <div className="text-sm">{item.value}</div>
                  </div>
                ))}
              </div>
            </div>

            {!isCompleted && (
            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-3">Client Visibility</h3>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#6D6E71]">{request.visible ? 'Visible' : 'Hidden'}</span>
                <VisibilityToggle
                  value={request.visible}
                  onChange={() => onUpdateRequest(request.id, { visible: !request.visible, updatedAt: formatToday() })}
                />
              </div>
              <p className="mt-2 text-xs text-[#A5A5A5]">
                {request.visible ? 'Client can see this request.' : 'Hidden from client dashboard.'}
              </p>
            </div>
            )}

            <div className="bg-white rounded-2xl shadow-card p-5">
              <h3 className="font-semibold text-[#050505] mb-3">Approval Workflow</h3>
              <div className="space-y-3 text-xs">
                <div>
                  <p className="text-[#A5A5A5]">Submission Source</p>
                  <p className="font-semibold capitalize text-[#050505]">{request.submissionSource}</p>
                </div>
                <div>
                  <p className="text-[#A5A5A5]">Approval Status</p>
                  <p className="font-semibold text-[#050505]">
                    {request.approvalStatus === 'pending' ? 'Awaiting broker approval' : 'Approved and available for client delivery'}
                  </p>
                </div>
                {!!request.approvedBy && (
                  <div>
                    <p className="text-[#A5A5A5]">Approved By</p>
                    <p className="font-semibold text-[#050505]">{request.approvedBy}</p>
                  </div>
                )}
              </div>
              {needsApproval && (
                <button
                  onClick={() => onApproveRequest(request.id)}
                  disabled={approvingRequestId === request.id}
                  className="mt-4 w-full rounded-xl bg-[#8BC53D] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {approvingRequestId === request.id ? 'Approving...' : 'Approve And Send To Client'}
                </button>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow-card p-5 space-y-2">
              <button
                onClick={sendReminder}
                className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors"
              >
                Send Reminder
              </button>
              <button
                onClick={() => {
                  const content = JSON.stringify(request, null, 2);
                  const blob = new Blob([content], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${request.id}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="w-full py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors flex items-center justify-center gap-2"
              >
                <Download size={14} /> Export Request
              </button>
              {!isCompleted && (
                <button
                  onClick={() => onUpdateRequest(request.id, { workflowStatus: 'blocked', updatedAt: formatToday() })}
                  className="w-full py-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-semibold transition-colors"
                >
                  Block Request
                </button>
              )}
              <button
                onClick={() => onDeleteRequest?.(request.id)}
                disabled={deletingRequestId === request.id}
                className="w-full rounded-xl border border-[#FECACA] bg-[#FEF2F2] py-2.5 text-sm font-semibold text-[#B91C1C] transition-colors hover:bg-[#FEE2E2] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="inline-flex items-center justify-center gap-2">
                  <Trash2 size={14} />
                  {deletingRequestId === request.id ? 'Deleting...' : 'Delete Request'}
                </span>
              </button>
              {!!request.reminderHistory?.length && (
                <div className="pt-2 border-t border-gray-100">
                  <p className="text-xs font-semibold text-[#6D6E71] mb-1.5 flex items-center gap-1"><Bell size={12} /> Reminder History</p>
                  <div className="space-y-1.5">
                    {request.reminderHistory.slice(0, 3).map((entry, idx) => (
                      <p key={idx} className="text-[11px] text-[#A5A5A5]">{entry}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <RequestDocumentPreviewModal document={previewDocument} onClose={() => setPreviewDocument(null)} />
    </div>
  );
}

export default function WorkspaceRequests() {
  const { clientId } = useParams();
  const { user } = useAuth();
  const [company, setCompany] = useState(null);
  const [requestState, setRequestState] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [folderOptions, setFolderOptions] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [bulkFile, setBulkFile] = useState(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [approvingRequestId, setApprovingRequestId] = useState(null);
  const [deletingRequestId, setDeletingRequestId] = useState(null);

  const loadRequests = async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');
    try {
      const list = await listCompanyRequests(clientId);
      setRequestState(list.map(mapApiRequestToUi).filter(Boolean));
    } catch (err) {
      setError(err.message || 'Unable to load requests.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!clientId) return;
    loadRequests();
    setFoldersLoading(true);
    listFolderTree(clientId)
      .then((tree) => {
        setFolderOptions(buildFolderOptionsFromTree(tree));
      })
      .catch(() => setFolderOptions([]))
      .finally(() => setFoldersLoading(false));
    getCompanyRequest(clientId)
      .then((data) => setCompany(data))
      .catch(() => setCompany(null));
  }, [clientId]);

  useEffect(() => {
    if (!clientId) return undefined;
    const refreshOnReturn = () => {
      if (document.visibilityState === 'visible') {
        loadRequests();
      }
    };
    window.addEventListener('focus', refreshOnReturn);
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => {
      window.removeEventListener('focus', refreshOnReturn);
      document.removeEventListener('visibilitychange', refreshOnReturn);
    };
  }, [clientId]);
  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(''), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  const [selectedCategory, setSelectedCategory] = useState(null);
  const [categoryView, setCategoryView] = useState('table');
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [activeRequestId, setActiveRequestId] = useState(null);

  useEffect(() => {
    if (!activeRequestId) return;
    listRequestDocuments(activeRequestId)
      .then((docs) => {
        setRequestState((prev) => prev.map((r) => {
          if (r.id !== activeRequestId) return r;
          const mapped = docs.map((doc) => mapRequestDocumentToUi(doc, 'Client'));
          return { ...r, linkedDocuments: mapped };
        }));
      })
      .catch(() => {});
  }, [activeRequestId]);
  
  const [isNewRequestOpen, setIsNewRequestOpen] = useState(false);

  useEffect(() => {
    if (isNewRequestOpen) return;
    setBulkFile(null);
  }, [isNewRequestOpen]);

  const grouped = useMemo(() => {
    const categories = Array.from(new Set(requestState.map(r => r.category)))
      .sort((a, b) => {
        const ia = CATEGORY_ORDER.indexOf(a);
        const ib = CATEGORY_ORDER.indexOf(b);
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      });
    return categories.map(cat => ({
      category: cat,
      items: requestState.filter(r => r.category === cat),
    })).filter(g => g.items.length > 0);
  }, [requestState]);

  const priorityFilterOptions = useMemo(() => ([
    'all',
    ...Array.from(new Set(requestState.map((request) => request.priority).filter(Boolean))),
  ]), [requestState]);

  const rowsForCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return requestState
      .filter(r => {
        if (r.category !== selectedCategory) return false;
        const s = search.toLowerCase();
        const matchesSearch = !s || r.name.toLowerCase().includes(s) || r.id.toLowerCase().includes(s);
        const displayStatus = getDisplayStatus(r.workflowStatus, r.dueDate);
        const matchesStatus = statusFilter === 'all' || displayStatus === statusFilter;
        const matchesPriority = priorityFilter === 'all' || r.priority === priorityFilter;
        return matchesSearch && matchesStatus && matchesPriority;
      })
      .map(r => ({ ...r, status: getDisplayStatus(r.workflowStatus, r.dueDate) }));
  }, [selectedCategory, requestState, search, statusFilter, priorityFilter]);

  const activeRequest = requestState.find(r => r.id === activeRequestId) || null;

  const updateRequestState = async (id, patch) => {
    setRequestState(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
    try {
      let canonicalRequest = null;
      if (patch.narrativeResponse !== undefined) {
        canonicalRequest = await updateRequestNarrative(id, {
          content: patch.narrativeResponse,
          updated_by: user?.id || null,
        });
      }
      const apiPatch = mapUiPatchToApi(patch);
      if (Object.keys(apiPatch).length > 0) {
        canonicalRequest = await updateRequest(id, apiPatch);
      }
      if (canonicalRequest?.id) {
        const normalized = mapApiRequestToUi(canonicalRequest);
        setRequestState(prev => prev.map(r => (r.id === id ? { ...r, ...normalized } : r)));
      }
      return true;
    } catch (err) {
      setError(err.message || 'Unable to update request.');
      return false;
    }
  };

  const createRequest = async (form) => {
    if (!clientId) return;
    setError('');
    setSuccess('');
    try {
      const payload = {
        ...buildCreateRequestPayload(form),
        created_by: user?.id || null,
      };
      await createCompanyRequestItem(clientId, payload);
      await loadRequests();
      setIsNewRequestOpen(false);
      setSuccess('Request created successfully.');
    } catch (err) {
      setError(err.message || 'Unable to create request.');
    }
  };

  const handleApproveRequest = async (requestOrId) => {
    const requestId = typeof requestOrId === 'object' ? requestOrId?.id : requestOrId;
    if (!requestId) return;

    setApprovingRequestId(requestId);
    setError('');
    setSuccess('');

    try {
      const approved = await approveRequest(requestId);
      const normalized = mapApiRequestToUi(approved);
      setRequestState((prev) => prev.map((item) => (item.id === requestId ? { ...item, ...normalized } : item)));
      setSuccess('Request approved and sent to the client portal.');
    } catch (err) {
      setError(err.message || 'Unable to approve request.');
    } finally {
      setApprovingRequestId(null);
    }
  };

  const handleMarkReviewed = async (requestId) => {
    if (!requestId) return;
    const ok = await updateRequestState(requestId, {
      workflowStatus: 'completed',
      updatedAt: formatToday(),
    });
    if (ok) setSuccess('Request marked reviewed and completed.');
  };

  const handleDeleteRequest = async (requestId) => {
    if (!requestId) return;
    if (!window.confirm('Delete this request from the broker portal?')) return;

    setDeletingRequestId(requestId);
    setError('');
    setSuccess('');
    try {
      await deleteRequest(requestId);
      setRequestState((prev) => prev.filter((item) => item.id !== requestId));
      if (activeRequestId === requestId) setActiveRequestId(null);
      setSuccess('Request deleted successfully.');
    } catch (err) {
      setError(err.message || 'Unable to delete request.');
    } finally {
      setDeletingRequestId(null);
    }
  };

  const downloadBulkTemplate = () => {
    const workbook = buildBulkTemplateWorkbook(folderOptions);
    const content = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    downloadFile(
      new Blob([content], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `${(company?.name || 'client').replace(/\s+/g, '-').toLowerCase()}-request-template.xlsx`
    );
    setSuccess('Bulk request template downloaded.');
  };

  const uploadBulkRequests = async () => {
    if (!clientId) return;
    if (!bulkFile) {
      setError('Select a filled Excel sheet before uploading.');
      return;
    }

    setBulkUploading(true);
    setError('');
    setSuccess('');

    try {
      const rows = await readBulkWorkbook(bulkFile);
      const requests = rows
        .filter((row) => !isEmptyBulkRow(row))
        .map((row) => ({
          title: `${row.title ?? ''}`.trim(),
          sub_label: `${row.sub_label ?? ''}`.trim(),
          description: `${row.description ?? ''}`.trim(),
          category: `${row.category ?? ''}`.trim(),
          response_type: `${row.response_type ?? ''}`.trim(),
          priority: `${row.priority ?? ''}`.trim().toLowerCase(),
          status: 'pending',
          due_date: `${row.due_date ?? ''}`.trim(),
          assigned_to: `${row.assigned_to ?? ''}`.trim(),
          visible: normalizeVisibleFlag(row.visible),
          created_by: user?.id || null,
        }));

      if (requests.length === 0) {
        throw new Error('The uploaded Excel sheet does not contain any request rows.');
      }

      const result = await createCompanyBulkRequestItems(clientId, { requests });
      await loadRequests();
      setBulkFile(null);
      setIsNewRequestOpen(false);
      setSuccess(`${result?.count || requests.length} requests created successfully.`);
    } catch (err) {
      const message = err.message || 'Unable to upload bulk requests.';
      setError(message);
    } finally {
      setBulkUploading(false);
    }
  };

  if (activeRequest) {
    return (
      <RequestDetailPage
        onBack={() => setActiveRequestId(null)}
        request={activeRequest}
        allRequests={requestState}
        onUpdateRequest={updateRequestState}
        onApproveRequest={handleApproveRequest}
        approvingRequestId={approvingRequestId}
        onMarkReviewed={handleMarkReviewed}
        onDeleteRequest={handleDeleteRequest}
        deletingRequestId={deletingRequestId}
        onSendReminder={(id) => createRequestReminder(id, {
          sent_at: new Date().toISOString(),
          sent_by: user?.id || null,
        }).catch(() => {})}
        onAttachDocument={(id, doc) => attachRequestDocument(id, { document_id: doc.id, visible: true }).catch(() => {})}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#050505]">{company?.name || 'Client'} Request Categories</h1>
        </div>
        {!selectedCategory && (
          <div className="flex items-center gap-3">
            <div className="flex items-center bg-gray-100 rounded-xl p-0.5">
              <button
                onClick={() => setCategoryView('cards')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${categoryView === 'cards' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
              >
                <LayoutGrid size={13} /> Cards
              </button>
              <button
                onClick={() => setCategoryView('table')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${categoryView === 'table' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
              >
                <List size={13} /> Table
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsNewRequestOpen(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#8BC53D] hover:bg-[#476E2C] text-white rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 hover:scale-[1.02] shadow-md"
            >
              <Send size={15} />
              New Request
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">
          {error}
        </div>
      )}
      {success && (
        <div className="px-4 py-3 bg-green-50 rounded-2xl border border-green-100 text-sm text-green-700">
          {success}
        </div>
      )}

      {!selectedCategory ? (
        categoryView === 'cards' ? (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {loading ? (
              <div className="col-span-full text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
            ) : grouped.length === 0 ? (
              <div className="col-span-full rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center text-sm text-[#6D6E71]">
                No requests available for this company yet. Create a request to start reminder tracking.
              </div>
            ) : grouped.map(g => (
              <CategoryCard
                key={g.category}
                category={g.category}
                requestsInCategory={g.items}
                onClick={() => setSelectedCategory(g.category)}
              />
            ))}
          </div>
        ) : (
          loading ? (
            <div className="text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
          ) : grouped.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center text-sm text-[#6D6E71]">
              No requests available for this company yet. Create a request to start reminder tracking.
            </div>
          ) : (
            <CategoryGroupedTable
              grouped={grouped}
              onView={(r) => setActiveRequestId(r.id)}
              onApprove={handleApproveRequest}
              approvingRequestId={approvingRequestId}
            />
          )
        )
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              onClick={() => setSelectedCategory(null)}
              className="flex items-center gap-2 text-sm text-[#6D6E71] hover:text-[#050505]"
            >
              <ArrowLeft size={14} /> Back to Categories
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-xl px-3 py-2">
                <Search size={15} className="text-[#A5A5A5]" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search requests..."
                  className="text-sm outline-none bg-transparent"
                />
              </div>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#050505]"
              >
                <option value="all">All Status</option>
                <option value="pending">Pending</option>
                <option value="in-review">In Review</option>
                <option value="completed">Completed</option>
                <option value="overdue">Overdue</option>
                <option value="blocked">Blocked</option>
              </select>
              <select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#050505]"
              >
                {priorityFilterOptions.map((option) => (
                  <option key={option} value={option}>
                    {option === 'all' ? 'All Priorities' : option}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  setSearch('');
                  setStatusFilter('all');
                  setPriorityFilter('all');
                }}
                className="px-3 py-2 rounded-xl border border-gray-200 bg-white text-sm text-[#6D6E71] hover:bg-gray-50"
              >
                Clear Filters
              </button>
            </div>
          </div>

          {loading ? (
            <div className="text-center text-sm text-[#A5A5A5] py-10">Loading requests...</div>
          ) : rowsForCategory.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-14 text-center text-sm text-[#6D6E71]">
              No requests matched this category and filter combination.
            </div>
          ) : (
            <RequestTable
              rows={rowsForCategory}
              onView={(r) => setActiveRequestId(r.id)}
              onApprove={handleApproveRequest}
              approvingRequestId={approvingRequestId}
            />
          )}
        </div>
      )}

      <NewRequestModal
        isOpen={isNewRequestOpen}
        onClose={() => setIsNewRequestOpen(false)}
        onCreate={createRequest}
        folderOptions={folderOptions}
        foldersLoading={foldersLoading}
        extraContent={(
          <div className="rounded-2xl border border-[#BFDBFE] bg-[#EFF6FF] p-4 space-y-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[#2563EB]">Bulk Upload</p>
                <h4 className="text-sm font-bold text-[#050505]">Create multiple requests from an Excel sheet</h4>
                <p className="text-xs text-[#6D6E71] mt-1">Download the template first, fill each row, then upload the completed file.</p>
              </div>
              <button
                type="button"
                onClick={downloadBulkTemplate}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#93C5FD] bg-white px-4 py-2.5 text-xs font-semibold text-[#1D4ED8] hover:bg-[#DBEAFE]"
              >
                <Download size={14} />
                Download Excel Sheet
              </button>
            </div>

            <div className="rounded-xl border border-dashed border-[#93C5FD] bg-white p-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(e) => setBulkFile(e.target.files?.[0] || null)}
                  className="w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#EFF6FF] file:px-3 file:py-2 file:text-xs file:font-semibold file:text-[#1D4ED8] hover:file:bg-[#DBEAFE]"
                />
                <button
                  type="button"
                  onClick={uploadBulkRequests}
                  disabled={bulkUploading || !bulkFile}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#05164D] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#0b2a79] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {bulkUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                  Upload Filled Sheet
                </button>
              </div>
              <p className="mt-2 text-[11px] text-[#6D6E71]">
                {bulkFile ? `Selected file: ${bulkFile.name}` : 'Accepted format: .xlsx or .xls'}
              </p>
            </div>
          </div>
        )}
      />
    </div>
  );
}
