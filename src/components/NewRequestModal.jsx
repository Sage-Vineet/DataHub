import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

const CATEGORY_OPTIONS = ['Finance', 'Legal', 'Compliance', 'HR', 'Tax', 'M&A', 'Other'];
const REQUEST_TYPES = ['Document', 'Information'];

function getTomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

const DEFAULT_FORM = {
  requestType: 'Document',
  category: '',
  name: '',
  description: '',
  file: null,
  priority: 'high',
  dueDate: '',
};

export default function NewRequestModal({
  isOpen,
  onClose,
  onCreate,
  folderOptions = [],
  foldersLoading = false,
  extraContent = null,
}) {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [errors, setErrors] = useState({});
  const [mode, setMode] = useState('single');
  const options = useMemo(() => (
    folderOptions.length
      ? folderOptions.map((opt) => (typeof opt === 'string' ? opt : opt.name)).filter(Boolean)
      : CATEGORY_OPTIONS
  ), [folderOptions]);

  useEffect(() => {
    if (!isOpen) return;
    const initialCategory = options[0] || '';
    setForm({ ...DEFAULT_FORM, category: initialCategory });
    setErrors({});
    setMode('single');
  }, [isOpen, options]);

  useEffect(() => {
    if (!isOpen) return;
    if (!form.category && options[0]) {
      setForm((s) => ({ ...s, category: options[0] }));
    }
  }, [isOpen, options, form.category]);

  useEffect(() => {
    if (!isOpen) return;
    const handle = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const submit = (e) => {
    e.preventDefault();
    const nextErrors = {};
    if (form.requestType !== 'Information' && !form.category) nextErrors.category = 'Folder is required';
    if (!form.name.trim()) {
      nextErrors.name = form.requestType === 'Information' ? 'Information title is required' : 'Document name is required';
    }
    if (!form.description.trim()) {
      nextErrors.description = 'Description is required';
    }
    if (!form.priority) nextErrors.priority = 'Priority is required';
    const minDueDate = getTomorrowDate();
    if (!form.dueDate) nextErrors.dueDate = 'Due date is required';
    if (form.dueDate && form.dueDate < minDueDate) nextErrors.dueDate = 'Select a future due date.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    onCreate?.(form);
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-start justify-center bg-white/30 backdrop-blur-sm p-4 pt-12"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-[640px] mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <p className="text-xs text-[#A5A5A5] uppercase tracking-wide">New Request</p>
            <h3 className="text-xl font-bold text-[#050505]">New Request</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 text-[#6D6E71]">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-6 grid gap-4">
          {extraContent && (
            <div className="space-y-4">
              <div className="inline-flex rounded-2xl bg-gray-100 p-1">
                <button
                  type="button"
                  onClick={() => setMode('single')}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${mode === 'single' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
                >
                  Normal Request
                </button>
                <button
                  type="button"
                  onClick={() => setMode('bulk')}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${mode === 'bulk' ? 'bg-white text-[#050505] shadow-sm' : 'text-[#6D6E71] hover:text-[#050505]'}`}
                >
                  Bulk Upload
                </button>
              </div>

              {mode === 'bulk' && extraContent}
            </div>
          )}

          {mode === 'single' && (
            <>
              <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Request Type *</label>
              <select
                value={form.requestType}
                onChange={(e) => setForm(s => ({
                  ...s,
                  requestType: e.target.value,
                  file: e.target.value === 'Information' ? null : s.file,
                }))}
                className="w-full px-3 py-2.5 rounded-xl border text-sm border-gray-200"
              >
                {REQUEST_TYPES.map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </div>
            {form.requestType !== 'Information' && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Folder Selection *</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm(s => ({ ...s, category: e.target.value }))}
                  className={`w-full px-3 py-2.5 rounded-xl border text-sm ${errors.category ? 'border-red-400' : 'border-gray-200'}`}
                  disabled={foldersLoading}
                >
                  {foldersLoading && <option value="">Loading folders...</option>}
                  {!foldersLoading && options.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
                {errors.category && <p className="text-xs text-red-500">{errors.category}</p>}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">
              {form.requestType === 'Information' ? 'Information Title *' : 'Document Name *'}
            </label>
            <input
              value={form.name}
              onChange={(e) => setForm(s => ({ ...s, name: e.target.value }))}
              placeholder={form.requestType === 'Information' ? 'Enter information title' : 'Enter document name'}
              className={`w-full px-3 py-2.5 rounded-xl border text-sm ${errors.name ? 'border-red-400' : 'border-gray-200'}`}
            />
            {errors.name && <p className="text-xs text-red-500">{errors.name}</p>}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">
              Description *
            </label>
            <textarea
              rows={4}
              value={form.description}
              onChange={(e) => setForm(s => ({ ...s, description: e.target.value }))}
              placeholder="Add a short description"
              className={`w-full px-3 py-2.5 rounded-xl border text-sm resize-none ${errors.description ? 'border-red-400' : 'border-gray-200'}`}
            />
            {errors.description && <p className="text-xs text-red-500">{errors.description}</p>}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Priority *</label>
              <select
                value={form.priority}
                onChange={(e) => setForm(s => ({ ...s, priority: e.target.value }))}
                className={`w-full px-3 py-2.5 rounded-xl border text-sm ${errors.priority ? 'border-red-400' : 'border-gray-200'}`}
              >
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
              {errors.priority && <p className="text-xs text-red-500">{errors.priority}</p>}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Due Date *</label>
            <input
              type="date"
              min={getTomorrowDate()}
              value={form.dueDate}
              onChange={(e) => setForm(s => ({ ...s, dueDate: e.target.value }))}
              className={`w-full px-3 py-2.5 rounded-xl border text-sm ${errors.dueDate ? 'border-red-400' : 'border-gray-200'}`}
            />
            {errors.dueDate
              ? <p className="text-xs text-red-500">{errors.dueDate}</p>
              : <p className="text-[11px] text-[#A5A5A5]">Required for notification logic</p>}
          </div>

          <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide mb-3">Priority-Based Notification Logic</p>
            {form.priority === 'critical' && (
              <div className="flex items-start gap-2 text-xs text-[#6D6E71]">
                <span className="mt-0.5 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">Critical</span>
                <div>
                  <p className="font-semibold text-[#050505]">Send immediate reminder, then daily follow-ups</p>
                  <p>Highest urgency for broker and client tracking</p>
                </div>
              </div>
            )}
            {form.priority === 'high' && (
              <div className="flex items-start gap-2 text-xs text-[#6D6E71]">
                <span className="mt-0.5 px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-[10px] font-bold">High</span>
                <div>
                  <p className="font-semibold text-[#050505]">Send immediate reminder, then daily follow-ups</p>
                  <p>Urgent cadence for open requests</p>
                </div>
              </div>
            )}
            {form.priority === 'medium' && (
              <div className="flex items-start gap-2 text-xs text-[#6D6E71]">
                <span className="mt-0.5 px-2 py-0.5 rounded-full bg-orange-100 text-orange-600 text-[10px] font-bold">Medium</span>
                <div>
                  <p className="font-semibold text-[#050505]">Send notification every 2 days</p>
                  <p>Medium urgency (orange badge)</p>
                </div>
              </div>
            )}
            {form.priority === 'low' && (
              <div className="flex items-start gap-2 text-xs text-[#6D6E71]">
                <span className="mt-0.5 px-2 py-0.5 rounded-full bg-green-100 text-green-600 text-[10px] font-bold">Low</span>
                <div>
                  <p className="font-semibold text-[#050505]">Send immediate reminder, then weekly follow-ups</p>
                  <p>Low urgency cadence</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-5 py-2.5 rounded-xl bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C]"
            >
              Submit
            </button>
          </div>
            </>
          )}

          {mode === 'bulk' && (
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
