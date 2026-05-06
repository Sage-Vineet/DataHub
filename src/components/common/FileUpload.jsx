import { useRef, useState } from 'react';
import { Upload, X, FileText, Image, File } from 'lucide-react';

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return Image;
  if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return FileText;
  return File;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export default function FileUpload({ onFilesChange, accept = '*', multiple = true, maxMB = 10 }) {
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef();

  const addFiles = (newFiles) => {
    setError('');
    const valid = [];
    [...newFiles].forEach(f => {
      if (f.size > maxMB * 1024 * 1024) {
        setError(`"${f.name}" exceeds ${maxMB}MB limit.`);
      } else {
        valid.push(f);
      }
    });
    const merged = multiple ? [...files, ...valid] : valid.slice(0, 1);
    setFiles(merged);
    onFilesChange && onFilesChange(merged);
  };

  const remove = (idx) => {
    const updated = files.filter((_, i) => i !== idx);
    setFiles(updated);
    onFilesChange && onFilesChange(updated);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
        onClick={() => inputRef.current.click()}
        className={`cursor-pointer rounded-[var(--radius-card)] border-2 border-dashed p-8 text-center transition-all duration-200
          ${dragging
            ? 'border-primary bg-[#EEF6E0] scale-[1.01]'
            : 'border-border bg-bg-card hover:border-primary hover:bg-[#F7FBF1]'}`}
      >
        <Upload
          size={32}
          className={`mx-auto mb-3 transition-colors ${dragging ? 'text-primary' : 'text-text-muted'}`}
        />
        <p className="text-sm font-semibold text-text-primary">
          {dragging ? 'Drop files here' : 'Drag & drop files or click to browse'}
        </p>
        <p className="mt-1 text-xs text-secondary">Supports PDF, Excel, Word, JPG, PNG - max {maxMB}MB each</p>
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept={accept}
          className="hidden"
          onChange={e => addFiles(e.target.files)}
        />
      </div>

      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-negative">{error}</p>
      )}

      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((f, idx) => {
            const Icon = getFileIcon(f.name);
            return (
              <div key={idx} className="flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-white p-3">
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-primary/10">
                  <Icon size={16} className="text-primary-dark" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{f.name}</p>
                  <p className="text-xs text-text-muted">{formatSize(f.size)}</p>
                </div>
                <button
                  onClick={e => { e.stopPropagation(); remove(idx); }}
                  className="rounded-md p-1 text-text-muted transition-colors hover:bg-red-50 hover:text-negative"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
