import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Folder, FolderOpen, File, FileText, Search, Download, Eye, Upload,
  ChevronRight, ChevronDown, Trash2, Home, Archive, X, ArrowLeft, Check,
  MoreVertical, LayoutGrid, List, AlertCircle, Pencil, FolderPlus,
  ArrowUpDown, ArrowUp, ArrowDown, CheckCircle, Clock, Share2, Users, Loader2,
} from 'lucide-react';
import { useFileExplorerStore, findById, getPathTo } from '../../store/fileExplorerStore';
import { fetchProtectedFileBlob, listCompanyRequests, listUsersRequest } from '../../lib/api';

// ── File Type Helpers ────────────────────────────────────────────────────────
function getMimeIcon(ext) {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return { Icon: FileText, color: '#E74C3C', bg: '#FDECEA' };
  if (['xlsx', 'xls', 'csv'].includes(e)) return { Icon: FileText, color: '#27AE60', bg: '#E8F8F0' };
  if (['doc', 'docx'].includes(e)) return { Icon: FileText, color: '#2980B9', bg: '#EBF5FB' };
  if (['ppt', 'pptx'].includes(e)) return { Icon: FileText, color: '#E67E22', bg: '#FEF5E7' };
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(e)) return { Icon: Eye, color: '#9B59B6', bg: '#F5EEF8' };
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return { Icon: Archive, color: '#7F8C8D', bg: '#F2F3F4' };
  if (['txt', 'md'].includes(e)) return { Icon: FileText, color: '#6D6E71', bg: '#F4F6F7' };
  return { Icon: File, color: '#95A5A6', bg: '#F2F3F4' };
}

const STATUS_META = {
  verified:     { label: 'Verified',      color: '#476E2C', bg: '#E6F3D3', Icon: CheckCircle },
  'under-review': { label: 'Under Review', color: '#b45e08', bg: '#FAC086', Icon: Clock },
  rejected:     { label: 'Rejected',      color: '#C62026', bg: '#F9D6D6', Icon: AlertCircle },
};

const FOLDER_PALETTE = ['#00B0F0','#742982','#F68C1F','#8BC53D','#05164D','#b45e08','#476E2C','#00648F'];

function randomFolderColor() {
  return FOLDER_PALETTE[Math.floor(Math.random() * FOLDER_PALETTE.length)];
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

const ACCESS_TYPE_OPTIONS = [
  { key: 'read', label: 'Read' },
  { key: 'write', label: 'Write' },
];

function accessTypeToPermissions(accessType) {
  if (accessType === 'write') {
    return { read: true, write: true, download: true };
  }
  return { read: true, write: false, download: true };
}

function permissionsToAccessType(permissions = {}) {
  return permissions.write ? 'write' : 'read';
}

function sortItems(items, sortBy, sortDir) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let cmp = 0;
    if (sortBy === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortBy === 'date') {
      const da = a.uploadedAt || a.createdAt || '';
      const db = b.uploadedAt || b.createdAt || '';
      cmp = da.localeCompare(db);
    } else if (sortBy === 'size') {
      cmp = (parseFloat(a.size) || 0) - (parseFloat(b.size) || 0);
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
}

function searchTree(node, query) {
  const results = [];
  const q = query.toLowerCase();
  const search = (n) => {
    if (n.id !== 'root' && n.name.toLowerCase().includes(q)) results.push(n);
    if (n.children) n.children.forEach(search);
  };
  search(node);
  return results;
}

function countItems(node) {
  let files = 0, folders = 0;
  const walk = (n) => {
    (n.children || []).forEach(c => {
      if (c.type === 'folder') { folders++; walk(c); } else files++;
    });
  };
  walk(node);
  return { files, folders };
}

function countFiles(node) {
  let files = 0;
  (node.children || []).forEach((c) => {
    if (c.type === 'file') files += 1;
    if (c.type === 'folder') files += countFiles(c);
  });
  return files;
}

function collectFolderIds(node, ids = []) {
  if (!node) return ids;
  if (node.type === 'folder' && node.id !== 'root') ids.push(node.id);
  (node.children || []).forEach((child) => collectFolderIds(child, ids));
  return ids;
}

// ── FolderTreeNode ───────────────────────────────────────────────────────────
function FolderTreeNode({ node, depth = 0, canAccessFolder, requestCountsByFolderName }) {
  const {
    currentPath, expandedFolders, toggleExpand, navigateTo,
    dragOver, setDragOver, draggingItems, moveItemsTo, clearDrag,
  } = useFileExplorerStore();

  if (!canAccessFolder(node.id)) return null;

  const isExpanded = expandedFolders.includes(node.id);
  const isActive = currentPath[currentPath.length - 1] === node.id;
  const isDragTarget = dragOver === node.id;
  const subFolders = (node.children || []).filter(c => c.type === 'folder' && canAccessFolder(c.id));
  const filesCount = countFiles(node);
  const requestCount = requestCountsByFolderName
    ? (requestCountsByFolderName[node.name?.toLowerCase?.() || ''] || 0)
    : 0;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 px-2 py-1.5 rounded-xl cursor-pointer text-sm transition-all duration-150 select-none
          ${isActive ? 'bg-[#05164D]/10 text-[#05164D] font-semibold' : 'text-[#4A4A4A] hover:bg-gray-100'}
          ${isDragTarget ? 'bg-[#8BC53D]/20 ring-2 ring-[#8BC53D] ring-inset' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => navigateTo(node.id)}
        onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragOver(node.id); }}
        onDragLeave={e => { e.stopPropagation(); setDragOver(null); }}
        onDrop={e => {
          e.preventDefault();
          e.stopPropagation();
          if (draggingItems.length > 0) moveItemsTo(draggingItems, node.id);
          clearDrag();
        }}
      >
        <button
          className="w-4 h-4 flex items-center justify-center flex-shrink-0 rounded hover:bg-gray-200"
          onClick={e => { e.stopPropagation(); if (subFolders.length) toggleExpand(node.id); }}
        >
          {subFolders.length > 0
            ? isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
            : <span className="w-3" />}
        </button>
        <span className="relative flex-shrink-0" style={{ color: node.color || '#6D6E71' }}>
          {isExpanded || isActive ? <FolderOpen size={15} /> : <Folder size={15} />}
          {requestCount > 0 && (
            <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-[#8BC53D] text-[9px] font-bold text-white shadow">
              {requestCount}
              <span className="absolute left-full ml-1 px-1.5 py-0.5 rounded bg-[#05164D] text-white text-[9px] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                Requests
              </span>
            </span>
          )}
        </span>
        <span className="truncate flex-1 text-xs font-medium">{node.name}</span>
        {node.children && (
          <span className="text-[10px] text-[#A5A5A5] ml-auto flex-shrink-0">
            {filesCount} files
          </span>
        )}
        {isDragTarget && (
          <span className="text-[10px] text-[#8BC53D] font-bold">Drop</span>
        )}
      </div>
      {isExpanded && subFolders.map(child => (
        <FolderTreeNode
          key={child.id}
          node={child}
          depth={depth + 1}
          canAccessFolder={canAccessFolder}
          requestCountsByFolderName={requestCountsByFolderName}
        />
      ))}
    </div>
  );
}

// ── FolderTree Sidebar ────────────────────────────────────────────────────────
function FolderTree({ tree, onUpload, role, getFolderPermissions, requestCountsByFolderName }) {
  const { navigateTo, startNewFolder, currentPath, uploadFiles } = useFileExplorerStore();
  const { files, folders } = countItems(tree);
  const fileInputRef = useRef(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState('');
  const currentFolderId = currentPath[currentPath.length - 1];
  const canWrite = role === 'broker' || getFolderPermissions(currentFolderId).write;
  const canAccessFolder = (id) => role === 'broker' || getFolderPermissions(id).read;
  const showRequests = requestCountsByFolderName && Object.keys(requestCountsByFolderName).length > 0;
  const totalRequests = showRequests
    ? Object.values(requestCountsByFolderName).reduce((sum, value) => sum + value, 0)
    : 0;

  const handleSidebarUpload = (e) => {
    if (!canWrite) return;
    if (e.target.files?.length) {
      uploadFiles(currentFolderId, e.target.files);
      e.target.value = '';
    }
  };

  return (
    <aside className="w-60 flex-shrink-0 bg-white border-r border-gray-100 flex flex-col overflow-hidden">
      {/* Storage Summary */}
      <div className="p-4 border-b border-gray-100">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-xl bg-[#05164D] flex items-center justify-center">
            <Archive size={14} className="text-white" />
          </div>
          <div>
            <p className="text-xs font-bold text-[#050505]">File Explorer</p>
            <p className="text-[10px] text-[#A5A5A5]">{files} files · {folders} folders</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { if (canWrite) onUpload(); }}
            disabled={!canWrite}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${canWrite ? 'bg-[#8BC53D] text-white hover:bg-[#7ab535]' : 'bg-gray-100 text-[#A5A5A5] cursor-not-allowed'}`}
          >
            <Upload size={11} /> Upload
          </button>
          <button
            onClick={() => { if (canWrite) startNewFolder(currentFolderId); }}
            disabled={!canWrite}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${canWrite ? 'bg-[#05164D]/8 text-[#05164D] hover:bg-[#05164D]/15 border-[#05164D]/15' : 'bg-gray-100 text-[#A5A5A5] border-gray-200 cursor-not-allowed'}`}
          >
            <FolderPlus size={11} /> New
          </button>
        </div>
      </div>

      {/* Folder Tree */}
      <div className="flex-1 overflow-y-auto p-2">
        <p className="text-[10px] font-bold text-[#A5A5A5] uppercase tracking-wider px-2 mb-2">Folders</p>
        {/* Root / Home */}
        <div
          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-xl cursor-pointer text-xs font-medium transition-all
            ${currentPath.length === 1 && currentPath[0] === 'root' ? 'bg-[#05164D]/10 text-[#05164D] font-semibold' : 'text-[#4A4A4A] hover:bg-gray-100'}`}
          onClick={() => navigateTo('root')}
        >
          <span className="relative flex-shrink-0">
            <Home size={14} className="text-[#05164D]" />
            {totalRequests > 0 && (
              <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] px-1 items-center justify-center rounded-full bg-[#8BC53D] text-[9px] font-bold text-white shadow">
                {totalRequests}
                <span className="absolute left-full ml-1 px-1.5 py-0.5 rounded bg-[#05164D] text-white text-[9px] opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                  Requests
                </span>
              </span>
            )}
          </span>
          <span>All Documents</span>
          <span className="text-[10px] text-[#A5A5A5] ml-auto flex-shrink-0">
            {files} files
          </span>
        </div>
        {(tree.children || []).filter(c => c.type === 'folder' && canAccessFolder(c.id)).map(node => (
          <FolderTreeNode
            key={node.id}
            node={node}
            depth={0}
            canAccessFolder={canAccessFolder}
            requestCountsByFolderName={requestCountsByFolderName}
          />
        ))}
      </div>

      {/* Hidden input */}
      <input ref={fileInputRef} type="file" multiple hidden onChange={handleSidebarUpload} />
    </aside>
  );
}

// ── Breadcrumbs ───────────────────────────────────────────────────────────────
function Breadcrumbs({ tree, currentPath }) {
  const { navigateTo } = useFileExplorerStore();
  return (
    <nav className="flex items-center gap-0.5 text-sm min-w-0">
      {currentPath.map((id, idx) => {
        const node = findById(tree, id);
        const isLast = idx === currentPath.length - 1;
        return (
          <span key={id} className="flex items-center gap-0.5 min-w-0">
            {idx > 0 && <ChevronRight size={13} className="flex-shrink-0 text-[#A5A5A5]" />}
            {isLast ? (
              <span className="font-semibold text-[#050505] truncate max-w-[160px]">
                {id === 'root' ? 'All Documents' : node?.name || id}
              </span>
            ) : (
              <button
                className="text-[#6D6E71] hover:text-[#05164D] transition-colors truncate max-w-[120px] font-medium"
                onClick={() => navigateTo(id)}
              >
                {id === 'root' ? 'Home' : node?.name || id}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ── TopBar ────────────────────────────────────────────────────────────────────
function TopBar({ tree, currentPath, onUpload, role, currentFolderPermissions }) {
  const {
    view, setView, sortBy, sortDir, setSortBy, searchQuery, setSearchQuery,
    startNewFolder, goBack, selectedItems, deleteItems,
  } = useFileExplorerStore();
  const currentFolderId = currentPath[currentPath.length - 1];
  const canWrite = role === 'broker' || currentFolderPermissions.write;

  return (
    <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 flex-wrap flex-shrink-0">
      {/* Back + Breadcrumbs */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {currentPath.length > 1 && (
          <button
            onClick={goBack}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-[#6D6E71] transition-colors flex-shrink-0"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <Breadcrumbs tree={tree} currentPath={currentPath} />
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 w-56 focus-within:ring-2 focus-within:ring-[#8BC53D]/30 focus-within:border-[#8BC53D] transition-all">
        <Search size={14} className="text-[#A5A5A5] flex-shrink-0" />
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search files & folders…"
          className="bg-transparent text-xs outline-none text-[#050505] placeholder-[#A5A5A5] w-full"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="text-[#A5A5A5] hover:text-[#6D6E71]">
            <X size={12} />
          </button>
        )}
      </div>

      {/* Action bar when items selected */}
      {selectedItems.length > 0 && role === 'broker' && (
        <div className="flex items-center gap-1 px-2 py-1 bg-[#05164D]/8 rounded-xl border border-[#05164D]/15">
          <span className="text-xs font-semibold text-[#05164D]">{selectedItems.length} selected</span>
          <button
            onClick={() => deleteItems(selectedItems)}
            className="ml-2 p-1 rounded-lg hover:bg-red-50 text-red-500 transition-colors"
            title="Delete selected"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={() => useFileExplorerStore.getState().clearSelection()}
            className="p-1 rounded-lg hover:bg-gray-100 text-[#6D6E71] transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Sort */}
      <div className="flex items-center gap-1">
        {['name', 'date', 'size'].map(key => (
          <button
            key={key}
            onClick={() => setSortBy(key)}
            className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all
              ${sortBy === key ? 'bg-[#05164D]/8 text-[#05164D]' : 'text-[#6D6E71] hover:bg-gray-100'}`}
          >
            {key.charAt(0).toUpperCase() + key.slice(1)}
            {sortBy === key && (sortDir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
          </button>
        ))}
      </div>

      {/* View Toggle */}
      <div className="flex items-center bg-gray-100 rounded-xl p-0.5">
        <button
          onClick={() => setView('grid')}
          className={`p-1.5 rounded-lg transition-all ${view === 'grid' ? 'bg-white shadow-sm text-[#05164D]' : 'text-[#6D6E71]'}`}
        >
          <LayoutGrid size={15} />
        </button>
        <button
          onClick={() => setView('list')}
          className={`p-1.5 rounded-lg transition-all ${view === 'list' ? 'bg-white shadow-sm text-[#05164D]' : 'text-[#6D6E71]'}`}
        >
          <List size={15} />
        </button>
      </div>

      {/* New Folder */}
      <button
        onClick={() => { if (canWrite) startNewFolder(currentFolderId); }}
        disabled={!canWrite}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition-colors ${canWrite ? 'border-gray-200 text-[#6D6E71] hover:bg-gray-50' : 'border-gray-200 text-[#A5A5A5] bg-gray-100 cursor-not-allowed'}`}
      >
        <FolderPlus size={14} /> New Folder
      </button>

      {/* Upload */}
      <button
        onClick={() => { if (canWrite) onUpload(); }}
        disabled={!canWrite}
        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors shadow-sm ${canWrite ? 'bg-[#8BC53D] text-white hover:bg-[#7ab535]' : 'bg-gray-200 text-[#A5A5A5] cursor-not-allowed'}`}
      >
        <Upload size={14} /> Upload
      </button>
    </div>
  );
}

// ── NewFolderInput ─────────────────────────────────────────────────────────────
function NewFolderInput({ parentId }) {
  const { createFolder, cancelNewFolder } = useFileExplorerStore();
  const [name, setName] = useState('New Folder');
  const inputRef = useRef(null);

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  const submit = () => createFolder(parentId, name);

  return (
    <div className="flex flex-col items-center p-4 rounded-2xl bg-[#8BC53D]/8 border-2 border-[#8BC53D] border-dashed w-[140px] gap-2">
      <div className="w-12 h-12 rounded-xl bg-[#8BC53D]/20 flex items-center justify-center">
        <Folder size={24} className="text-[#8BC53D]" />
      </div>
      <input
        ref={inputRef}
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={submit}
        onKeyDown={e => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') cancelNewFolder();
        }}
        className="w-full text-xs text-center bg-white border border-[#8BC53D]/50 rounded-lg px-2 py-1 outline-none focus:ring-2 focus:ring-[#8BC53D]/40"
      />
    </div>
  );
}

// ── StatusPill ────────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META['under-review'];
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold"
      style={{ color: m.color, background: m.bg }}
    >
      <m.Icon size={9} />
      {m.label}
    </span>
  );
}

// ── RenameInput ───────────────────────────────────────────────────────────────
function RenameInput({ item }) {
  const { renameItem, stopRenaming } = useFileExplorerStore();
  const [name, setName] = useState(item.name);
  const inputRef = useRef(null);

  useEffect(() => {
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  }, []);

  return (
    <input
      ref={inputRef}
      value={name}
      onChange={e => setName(e.target.value)}
      onBlur={() => renameItem(item.id, name)}
      onKeyDown={e => {
        if (e.key === 'Enter') renameItem(item.id, name);
        if (e.key === 'Escape') stopRenaming();
      }}
      onClick={e => e.stopPropagation()}
      className="w-full text-xs text-center bg-white border border-[#05164D]/30 rounded-lg px-2 py-0.5 outline-none focus:ring-2 focus:ring-[#05164D]/20 mt-1"
    />
  );
}

// ── FileCard (grid) ────────────────────────────────────────────────────────────
function FileCard({ item, role, permissions, sharedMeta, onShareAccess, onMoveFolder }) {
  const {
    selectedItems, selectItem, renamingId, draggingItems, setDraggingItems,
    dragOver, setDragOver, moveItemsTo, clearDrag, navigateTo,
    showContextMenu, showPreview, startRenaming,
  } = useFileExplorerStore();

  const isSelected = selectedItems.includes(item.id);
  const isDragTarget = dragOver === item.id && item.type === 'folder';
  const isRenaming = renamingId === item.id;
  const canManage = role === 'broker';
  const canRead = permissions?.read ?? true;
  const canDownload = permissions?.download ?? true;

  const { Icon, color, bg } = item.type === 'folder'
    ? { Icon: Folder, color: item.color || '#6D6E71', bg: `${item.color || '#6D6E71'}20` }
    : getMimeIcon(item.ext);

  const handleClick = (e) => {
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) selectItem(item.id, true);
    else selectItem(item.id, false);
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (item.type === 'folder') navigateTo(item.id);
    else showPreview(item);
  };

  const handleDragStart = (e) => {
    if (!canManage) return;
    const toMove = selectedItems.includes(item.id) ? selectedItems : [item.id];
    setDraggingItems(toMove);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(toMove));
  };

  const handleDragOver = (e) => {
    if (!canManage || item.type !== 'folder') return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(item.id);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canManage) return;
    if (item.type === 'folder' && draggingItems.length > 0) {
      moveItemsTo(draggingItems, item.id);
    }
    clearDrag();
  };

  const handleDownload = (e) => {
    e.stopPropagation();
    if (!canDownload) return;
    const a = document.createElement('a');
    a.href = '#'; a.download = item.name; a.click();
  };

  return (
    <div
      draggable={canManage}
      onDragStart={handleDragStart}
      onDragEnd={() => clearDrag()}
      onDragOver={handleDragOver}
      onDragLeave={e => { e.stopPropagation(); setDragOver(null); }}
      onDrop={handleDrop}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={e => { e.preventDefault(); if (canManage) showContextMenu(e.clientX, e.clientY, item.id); }}
      className={`group relative flex flex-col items-center p-4 rounded-2xl border transition-all duration-150 cursor-pointer select-none
        ${isSelected ? 'bg-[#05164D]/5 border-[#05164D]/30 ring-2 ring-[#05164D]/20' : 'bg-white border-gray-100 hover:border-gray-200 hover:shadow-md'}
        ${isDragTarget ? 'bg-[#8BC53D]/10 border-[#8BC53D] ring-2 ring-[#8BC53D]/40 scale-105' : ''}
        ${draggingItems.includes(item.id) ? 'opacity-50' : ''}`}
      style={{ width: 140, minWidth: 0 }}
    >
      {/* Folder Actions */}
      {item.type === 'folder' && canManage && (
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <FolderActionMenu
            onShareAccess={() => onShareAccess(item)}
            onRename={() => startRenaming(item.id)}
            onMove={() => onMoveFolder(item)}
            onDelete={() => useFileExplorerStore.getState().deleteItems([item.id])}
          />
        </div>
      )}

      {/* Checkbox */}
      {isSelected && (
        <div className="absolute top-2 left-2 w-5 h-5 rounded-full bg-[#05164D] flex items-center justify-center">
          <Check size={11} className="text-white" />
        </div>
      )}

      {/* Icon */}
      <div
        className="w-14 h-14 rounded-2xl flex items-center justify-center mb-2 transition-transform group-hover:scale-105"
        style={{ background: bg }}
      >
        {item.type === 'folder' && isDragTarget
          ? <FolderOpen size={28} style={{ color }} />
          : <Icon size={28} style={{ color }} />}
      </div>

      {/* Name */}
      {isRenaming ? (
        <RenameInput item={item} />
      ) : (
        <p className="text-xs font-semibold text-[#050505] text-center w-full truncate leading-tight"
          title={item.name}>{item.name}</p>
      )}

      {/* Meta */}
      {item.type === 'file' ? (
        <div className="mt-1 flex flex-col items-center gap-0.5">
          <span className="text-[10px] text-[#A5A5A5]">{item.size}</span>
          <StatusPill status={item.status} />
        </div>
      ) : (
        <div className="mt-1 flex flex-col items-center gap-1">
          <span className="text-[10px] text-[#A5A5A5]">{(item.children || []).length} items</span>
          {sharedMeta?.count > 0 && (
            <span
              title={sharedMeta.tooltip}
              className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#E6F3D3] text-[#476E2C]"
            >
              <Share2 size={10} />
              Shared
            </span>
          )}
        </div>
      )}

      {/* Hover Actions */}
      {item.type === 'file' && (
        <div className="absolute top-2 right-2 hidden group-hover:flex gap-1">
          <button
            onClick={e => { e.stopPropagation(); if (canRead) showPreview(item); }}
            disabled={!canRead}
            className={`w-6 h-6 rounded-lg bg-white shadow border border-gray-100 flex items-center justify-center ${canRead ? 'hover:bg-gray-50' : 'opacity-40 cursor-not-allowed'}`}
          >
            <Eye size={11} className="text-[#6D6E71]" />
          </button>
          <button
            onClick={handleDownload}
            disabled={!canDownload}
            className={`w-6 h-6 rounded-lg bg-white shadow border border-gray-100 flex items-center justify-center ${canDownload ? 'hover:bg-gray-50' : 'opacity-40 cursor-not-allowed'}`}
          >
            <Download size={11} className="text-[#6D6E71]" />
          </button>
        </div>
      )}

      {/* Drop label */}
      {isDragTarget && (
        <div className="absolute inset-0 rounded-2xl flex items-end justify-center pb-2 pointer-events-none">
          <span className="text-[10px] font-bold text-[#8BC53D] bg-white px-2 py-0.5 rounded-full shadow">
            Drop here
          </span>
        </div>
      )}
    </div>
  );
}

// ── FileRow (list) ─────────────────────────────────────────────────────────────
function FileRow({ item, role, permissions, sharedMeta, onShareAccess, onMoveFolder }) {
  const {
    selectedItems, selectItem, renamingId, draggingItems, setDraggingItems,
    dragOver, setDragOver, moveItemsTo, clearDrag, navigateTo,
    showContextMenu, showPreview, startRenaming,
  } = useFileExplorerStore();

  const isSelected = selectedItems.includes(item.id);
  const isDragTarget = dragOver === item.id && item.type === 'folder';
  const isRenaming = renamingId === item.id;
  const canManage = role === 'broker';
  const canRead = permissions?.read ?? true;
  const canDownload = permissions?.download ?? true;

  const { Icon, color, bg } = item.type === 'folder'
    ? { Icon: Folder, color: item.color || '#6D6E71', bg: `${item.color || '#6D6E71'}20` }
    : getMimeIcon(item.ext);

  const handleDownload = (e) => {
    e.stopPropagation();
    if (!canDownload) return;
    const a = document.createElement('a');
    a.href = '#'; a.download = item.name; a.click();
  };

  return (
    <tr
      draggable={canManage}
      onDragStart={e => {
        if (!canManage) return;
        const toMove = selectedItems.includes(item.id) ? selectedItems : [item.id];
        setDraggingItems(toMove);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify(toMove));
      }}
      onDragEnd={() => clearDrag()}
      onDragOver={e => {
        if (!canManage || item.type !== 'folder') return;
        e.preventDefault(); e.stopPropagation(); setDragOver(item.id);
      }}
      onDragLeave={e => { e.stopPropagation(); setDragOver(null); }}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation();
        if (!canManage) return;
        if (item.type === 'folder' && draggingItems.length > 0)
          moveItemsTo(draggingItems, item.id);
        clearDrag();
      }}
      onClick={e => {
        if (e.ctrlKey || e.metaKey) selectItem(item.id, true);
        else selectItem(item.id, false);
      }}
      onDoubleClick={() => item.type === 'folder' ? navigateTo(item.id) : showPreview(item)}
      onContextMenu={e => { e.preventDefault(); if (canManage) showContextMenu(e.clientX, e.clientY, item.id); }}
      className={`group cursor-pointer transition-all duration-100 select-none
        ${isSelected ? 'bg-[#05164D]/5' : 'hover:bg-gray-50'}
        ${isDragTarget ? 'bg-[#8BC53D]/10 ring-1 ring-inset ring-[#8BC53D]' : ''}
        ${draggingItems.includes(item.id) ? 'opacity-50' : ''}`}
    >
      <td className="pl-4 pr-2 py-2.5 w-8">
        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all
          ${isSelected ? 'bg-[#05164D] border-[#05164D]' : 'border-gray-300 group-hover:border-[#05164D]/40'}`}>
          {isSelected && <Check size={11} className="text-white" />}
        </div>
      </td>
      <td className="px-2 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
            {item.type === 'folder' && isDragTarget
              ? <FolderOpen size={16} style={{ color }} />
              : <Icon size={16} style={{ color }} />}
          </div>
          <div className="min-w-0">
            {isRenaming ? (
              <RenameInput item={item} />
            ) : (
              <p className="text-sm font-medium text-[#050505] truncate">{item.name}</p>
            )}
            {item.type === 'folder' && (
              <div className="flex items-center gap-2">
                <p className="text-xs text-[#A5A5A5]">{(item.children || []).length} items</p>
                {sharedMeta?.count > 0 && (
                  <span
                    title={sharedMeta.tooltip}
                    className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-[#E6F3D3] text-[#476E2C]"
                  >
                    <Share2 size={10} />
                    Shared
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 text-xs text-[#6D6E71] whitespace-nowrap">
        {item.uploadedAt || item.createdAt || '—'}
      </td>
      <td className="px-3 py-2.5 text-xs text-[#6D6E71] whitespace-nowrap">
        {item.size || '—'}
      </td>
      <td className="px-3 py-2.5">
        {item.type === 'file' && <StatusPill status={item.status} />}
      </td>
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {item.type === 'file' && (
            <>
              <button
                onClick={e => { e.stopPropagation(); if (canRead) showPreview(item); }}
                disabled={!canRead}
                className={`p-1 rounded-lg ${canRead ? 'hover:bg-gray-100 text-[#6D6E71]' : 'text-[#C0C4CC] cursor-not-allowed'}`}
              ><Eye size={13} /></button>
              <button
                onClick={handleDownload}
                disabled={!canDownload}
                className={`p-1 rounded-lg ${canDownload ? 'hover:bg-gray-100 text-[#6D6E71]' : 'text-[#C0C4CC] cursor-not-allowed'}`}
              ><Download size={13} /></button>
            </>
          )}
          {item.type === 'folder' && canManage && (
            <FolderActionMenu
              className="opacity-100"
              onShareAccess={() => onShareAccess(item)}
              onRename={() => startRenaming(item.id)}
              onMove={() => onMoveFolder(item)}
              onDelete={() => useFileExplorerStore.getState().deleteItems([item.id])}
            />
          )}
          {item.type === 'file' && canManage && (
            <>
              <button
                onClick={e => { e.stopPropagation(); startRenaming(item.id); }}
                className="p-1 rounded-lg hover:bg-gray-100 text-[#6D6E71]"
              ><Pencil size={13} /></button>
              <button
                onClick={e => { e.stopPropagation(); useFileExplorerStore.getState().deleteItems([item.id]); }}
                className="p-1 rounded-lg hover:bg-red-50 text-red-400"
              ><Trash2 size={13} /></button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── FileGrid / FileTable ──────────────────────────────────────────────────────
function FileGrid({
  items,
  currentFolderId,
  role,
  getFolderPermissions,
  getSharedMeta,
  onShareAccess,
  onMoveFolder,
  currentFolderPermissions,
}) {
  const { newFolderParentId } = useFileExplorerStore();
  return (
    <div className="flex flex-wrap gap-3 p-1 content-start">
      {newFolderParentId === currentFolderId && (role === 'broker' || currentFolderPermissions.write) && (
        <NewFolderInput parentId={currentFolderId} />
      )}
      {items.map(item => {
        const permissions = item.type === 'folder'
          ? getFolderPermissions(item.id)
          : currentFolderPermissions;
        const sharedMeta = item.type === 'folder' ? getSharedMeta(item.id) : null;
        return (
          <FileCard
            key={item.id}
            item={item}
            role={role}
            permissions={permissions}
            sharedMeta={sharedMeta}
            onShareAccess={onShareAccess}
            onMoveFolder={onMoveFolder}
          />
        );
      })}
    </div>
  );
}

function FileTable({
  items,
  currentFolderId,
  role,
  getFolderPermissions,
  getSharedMeta,
  onShareAccess,
  onMoveFolder,
  currentFolderPermissions,
}) {
  const { newFolderParentId } = useFileExplorerStore();
  return (
    <div>
      <table className="w-full">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="pl-4 pr-2 py-2 w-8"></th>
            <th className="px-2 py-2 text-left text-xs font-semibold text-[#6D6E71]">Name</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-[#6D6E71]">Modified</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-[#6D6E71]">Size</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-[#6D6E71]">Status</th>
            <th className="px-3 py-2 text-left text-xs font-semibold text-[#6D6E71]">Actions</th>
          </tr>
        </thead>
        <tbody>
          {newFolderParentId === currentFolderId && (role === 'broker' || currentFolderPermissions.write) && (
            <tr><td colSpan={6} className="px-4 py-2">
              <NewFolderInput parentId={currentFolderId} />
            </td></tr>
          )}
          {items.map(item => {
            const permissions = item.type === 'folder'
              ? getFolderPermissions(item.id)
              : currentFolderPermissions;
            const sharedMeta = item.type === 'folder' ? getSharedMeta(item.id) : null;
            return (
              <FileRow
                key={item.id}
                item={item}
                role={role}
                permissions={permissions}
                sharedMeta={sharedMeta}
                onShareAccess={onShareAccess}
                onMoveFolder={onMoveFolder}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FolderActionMenu({ onShareAccess, onRename, onMove, onDelete, className }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handle = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  return (
    <div className={`relative ${className || ''}`} ref={menuRef}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="w-7 h-7 rounded-lg bg-white border border-gray-100 shadow-sm flex items-center justify-center hover:bg-gray-50"
        aria-label="Folder actions"
      >
        <MoreVertical size={13} className="text-[#6D6E71]" />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 z-20 animate-fadeIn">
          <button
            onClick={() => { onShareAccess(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50"
          >
            <Share2 size={14} className="text-[#05164D]" />
            Share Access
          </button>
          <button
            onClick={() => { onRename(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50"
          >
            <Pencil size={14} className="text-[#6D6E71]" />
            Rename Folder
          </button>
          <button
            onClick={() => { onMove(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50"
          >
            <ArrowUpDown size={14} className="text-[#6D6E71]" />
            Move Folder
          </button>
          <div className="my-1 border-t border-gray-100" />
          <button
            onClick={() => { onDelete(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-red-500 hover:bg-red-50"
          >
            <Trash2 size={14} />
            Delete Folder
          </button>
        </div>
      )}
    </div>
  );
}

function ShareAccessModal({ isOpen, folder, entries, people, onSave, onClose }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const directory = new Map((people || []).map((person) => [person.id, person]));
    setSelected(entries.map((entry) => {
      const person = directory.get(entry.subjectId || entry.id);
      return {
        ...entry,
        id: entry.subjectId || entry.id,
        subjectId: entry.subjectId || entry.id,
        type: 'user',
        name: person?.name || entry.name,
        meta: person?.meta || entry.meta || '',
        accessType: permissionsToAccessType(entry.permissions),
        permissions: { ...entry.permissions },
      };
    }));
    setSearch('');
    setSaving(false);
  }, [isOpen, folder?.id, entries, people]);

  if (!isOpen || !folder) return null;

  const filtered = (people || []).filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) || (t.meta || '').toLowerCase().includes(search.toLowerCase())
  );

  const isSelected = (target) => selected.some(s => s.id === target.id);
  const toggleTarget = (target) => {
    setSelected(prev => {
      if (prev.some(s => s.id === target.id)) {
        return prev.filter(s => s.id !== target.id);
      }
      return [...prev, {
        ...target,
        subjectId: target.id,
        type: 'user',
        accessType: 'read',
        permissions: accessTypeToPermissions('read'),
      }];
    });
  };

  const updateAccessType = (targetId, accessType) => {
    setSelected(prev => prev.map(s => (
      s.id === targetId ? { ...s, accessType, permissions: accessTypeToPermissions(accessType) } : s
    )));
  };

  const save = async () => {
    if (selected.length === 0 || saving) return;
    setSaving(true);
    onClose?.();
    try {
      await onSave(selected);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 backdrop-blur-sm animate-fadeIn">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <p className="text-xs text-[#A5A5A5] uppercase tracking-wide">Share Access</p>
            <h3 className="text-xl font-bold text-[#050505]">{folder.name}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 text-[#6D6E71]">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <h4 className="text-sm font-semibold text-[#050505] mb-2">Select Persons</h4>
            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 mb-3">
              <Search size={14} className="text-[#A5A5A5]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search persons..."
                className="bg-transparent text-sm outline-none w-full"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-2 max-h-44 overflow-y-auto pr-1">
              {filtered.map(target => (
                <button
                  key={target.id}
                  onClick={() => toggleTarget(target)}
                  className={`flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition-colors ${
                    isSelected(target) ? 'border-[#8BC53D] bg-[#E6F3D3]/40' : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-[#8BC53D]/20">
                    <Users size={14} className="text-[#476E2C]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#050505] truncate">{target.name}</p>
                    <p className="text-[11px] text-[#A5A5A5] truncate">{target.meta}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-[#050505] mb-2">Access Type</h4>
            {selected.length === 0 ? (
              <p className="text-sm text-[#A5A5A5]">Select persons to assign access.</p>
            ) : (
              <div className="space-y-2">
                {selected.map(target => (
                  <div key={target.id} className="flex flex-wrap items-center gap-3 px-3 py-2 bg-gray-50 rounded-xl">
                    <span className="text-sm font-semibold text-[#050505] min-w-[160px]">{target.name}</span>
                    <div className="flex flex-wrap items-center gap-2">
                      {ACCESS_TYPE_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => updateAccessType(target.id, option.key)}
                          className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                            target.accessType === option.key
                              ? 'bg-[#8BC53D] text-white'
                              : 'bg-white text-[#6D6E71] border border-gray-200 hover:bg-gray-50'
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h4 className="text-sm font-semibold text-[#050505] mb-2">Access Summary</h4>
            {selected.length === 0 ? (
              <p className="text-sm text-[#A5A5A5]">No access assigned yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {selected.map(target => (
                  <div key={target.id} className="flex items-center justify-between px-3 py-2 border border-gray-200 rounded-xl">
                    <span className="text-sm font-semibold text-[#050505]">{target.name}</span>
                    <span className="text-[10px] px-2.5 py-1 rounded-full bg-[#E6F3D3] text-[#476E2C] font-semibold uppercase">
                      {target.accessType}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={selected.length === 0 || saving}
            className="px-5 py-2.5 rounded-xl bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving...' : 'Save Access'}
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveFolderModal({ isOpen, folder, tree, onMove, onClose }) {
  const [targetId, setTargetId] = useState('root');

  useEffect(() => {
    if (!isOpen) return;
    setTargetId('root');
  }, [isOpen, folder?.id]);

  if (!isOpen || !folder) return null;

  const options = [];
  const walk = (node, depth = 0) => {
    if (node.type === 'folder' && node.id !== folder.id) {
      options.push({ id: node.id, name: node.name, depth });
    }
    (node.children || []).forEach(child => {
      if (child.type === 'folder') walk(child, depth + 1);
    });
  };
  walk(tree, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/30 backdrop-blur-sm animate-fadeIn">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <p className="text-xs text-[#A5A5A5] uppercase tracking-wide">Move Folder</p>
            <h3 className="text-xl font-bold text-[#050505]">{folder.name}</h3>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-gray-100 text-[#6D6E71]">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">
          <label className="text-xs font-semibold text-[#6D6E71] uppercase tracking-wide">Destination</label>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            className="mt-2 w-full px-3 py-2 rounded-xl border border-gray-200 text-sm"
          >
            {options.map(opt => (
              <option key={opt.id} value={opt.id}>
                {'\u00A0'.repeat(opt.depth * 2)}{opt.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-end gap-3 p-5 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onMove(folder.id, targetId)}
            className="px-5 py-2.5 rounded-xl bg-[#05164D] text-white text-sm font-semibold hover:bg-[#041240]"
          >
            Move Folder
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ContextMenu ───────────────────────────────────────────────────────────────
function ContextMenu({ tree }) {
  const {
    contextMenu, hideContextMenu, deleteItems, startRenaming, showPreview,
    startNewFolder, navigateTo, selectedItems, moveItemsTo, tree: storeTree,
  } = useFileExplorerStore();

  const ref = useRef(null);
  useEffect(() => {
    const handle = (e) => {
      if (ref.current && !ref.current.contains(e.target)) hideContextMenu();
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [hideContextMenu]);

  if (!contextMenu) return null;
  const item = contextMenu.itemId ? findById(storeTree, contextMenu.itemId) : null;
  if (!item) return null;

  const ids = selectedItems.length > 1 && selectedItems.includes(contextMenu.itemId)
    ? selectedItems
    : [contextMenu.itemId];

  // Adjust to stay in viewport
  const menuW = 200, menuH = 280;
  const x = Math.min(contextMenu.x, window.innerWidth - menuW - 8);
  const y = Math.min(contextMenu.y, window.innerHeight - menuH - 8);

  const MenuItem = ({ icon: Icon2, label, onClick, danger }) => (
    <button
      onClick={() => { onClick(); hideContextMenu(); }}
      className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors text-left
        ${danger ? 'text-red-500 hover:bg-red-50' : 'text-[#050505] hover:bg-gray-50'}`}
    >
      <Icon2 size={14} className="flex-shrink-0" />
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      className="fixed z-50 bg-white rounded-2xl shadow-xl border border-gray-100 py-2 w-52 animate-fadeIn"
      style={{ left: x, top: y }}
    >
      <div className="px-3 pb-2 mb-1 border-b border-gray-100">
        <p className="text-xs font-semibold text-[#050505] truncate">{ids.length > 1 ? `${ids.length} items` : item.name}</p>
        <p className="text-[10px] text-[#A5A5A5]">{item.type === 'folder' ? 'Folder' : item.ext?.toUpperCase() || 'File'}</p>
      </div>
      <div className="px-1">
        {item.type === 'folder' && (
          <MenuItem icon={FolderOpen} label="Open" onClick={() => navigateTo(item.id)} />
        )}
        {item.type === 'file' && (
          <MenuItem icon={Eye} label="Preview" onClick={() => showPreview(item)} />
        )}
        {item.type === 'file' && (
          <MenuItem icon={Download} label="Download" onClick={() => {
            const a = document.createElement('a'); a.href = '#'; a.download = item.name; a.click();
          }} />
        )}
        {ids.length === 1 && (
          <MenuItem icon={Pencil} label="Rename" onClick={() => startRenaming(item.id)} />
        )}
        {item.type === 'folder' && ids.length === 1 && (
          <MenuItem icon={FolderPlus} label="New Folder Inside" onClick={() => startNewFolder(item.id)} />
        )}
        <div className="my-1 border-t border-gray-100" />
        <MenuItem icon={Trash2} label={`Delete${ids.length > 1 ? ` (${ids.length})` : ''}`} onClick={() => deleteItems(ids)} danger />
      </div>
    </div>
  );
}

// ── PreviewModal ───────────────────────────────────────────────────────────────
function PreviewModal() {
  const { previewItem, hidePreview } = useFileExplorerStore();
  const [blobUrl, setBlobUrl] = useState('');
  const [textPreview, setTextPreview] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const normalizedExt = (previewItem?.ext || '').toLowerCase();
  const { Icon, color, bg } = getMimeIcon(previewItem?.ext);
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(normalizedExt);
  const isPdf = normalizedExt === 'pdf';
  const isText = ['txt', 'md', 'json'].includes(normalizedExt);
  const isWordDoc = ['doc', 'docx'].includes(normalizedExt);
  const canPreview = canInlinePreview(previewItem?.ext) && Boolean(previewItem?.fileUrl);
  const statusMeta = STATUS_META[previewItem?.status] || STATUS_META['under-review'];
  const StatusIcon = statusMeta.Icon;

  useEffect(() => {
    let revokedUrl = '';
    let active = true;

    setBlobUrl('');
    setTextPreview('');
    setPreviewError('');

    if (!previewItem?.fileUrl || !canPreview) {
      return undefined;
    }

    setLoadingPreview(true);
    fetchProtectedFileBlob(previewItem.fileUrl)
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
  }, [previewItem?.id, previewItem?.fileUrl, canPreview, isText]);

  if (!previewItem) return null;

  const handleDownload = () => {
    if (!blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = previewItem.name;
    a.click();
  };

  const metaItems = [
    { label: 'Name', value: previewItem.name || '—' },
    { label: 'Type', value: getFileKind(previewItem.ext) },
    { label: 'Uploaded on', value: previewItem.uploadedAt || '—' },
    { label: 'Uploaded by', value: previewItem.uploadedBy || '—' },
    { label: 'File size', value: previewItem.size || '—' },
    { label: 'Status', value: statusMeta.label },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white/35 backdrop-blur-sm animate-fadeIn p-4"
      onClick={hidePreview}
    >
      <div
        className="bg-white rounded-[28px] shadow-2xl w-full max-w-6xl h-[94vh] overflow-hidden animate-fadeIn"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
              <Icon size={20} style={{ color }} />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-[#050505] truncate">{previewItem.name}</p>
              <p className="text-xs text-[#A5A5A5]">{previewItem.size} · {previewItem.ext?.toUpperCase()}</p>
            </div>
          </div>
          <button onClick={hidePreview} className="p-2 rounded-xl hover:bg-gray-100 text-[#6D6E71] transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] h-[calc(94vh-81px)]">
          <div className="bg-[#F8FAFC] p-5 lg:p-6 overflow-hidden border-r border-gray-100">
            <div className="h-full rounded-[24px] bg-white border border-gray-100 shadow-sm overflow-hidden">
              {loadingPreview ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-[#6D6E71]">
                  <Loader2 size={28} className="animate-spin" />
                  <p className="text-sm font-medium">Loading preview…</p>
                </div>
              ) : previewError ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: bg }}>
                    <Icon size={28} style={{ color }} />
                  </div>
                  <div>
                    <p className="text-base font-semibold text-[#050505]">Preview unavailable</p>
                    <p className="text-sm text-[#6D6E71] mt-1">{previewError}</p>
                  </div>
                </div>
              ) : isImage && blobUrl ? (
                <div className="h-full overflow-auto bg-[radial-gradient(circle_at_top,#f8fafc,#eef2f7)] p-6">
                  <img
                    src={blobUrl}
                    alt={previewItem.name}
                    className="mx-auto max-w-full h-auto rounded-2xl shadow-lg border border-gray-100"
                  />
                </div>
              ) : isPdf && blobUrl ? (
                <iframe
                  title={previewItem.name}
                  src={`${blobUrl}#toolbar=0&navpanes=0&scrollbar=1`}
                  className="w-full h-full bg-white"
                />
              ) : isText ? (
                <div className="h-full overflow-auto bg-[#FCFCFD] p-6">
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-[#2B2F38] font-mono">
                    {textPreview || 'No text content available.'}
                  </pre>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center">
                  <div className="w-20 h-20 rounded-3xl flex items-center justify-center" style={{ background: bg }}>
                    <Icon size={38} style={{ color }} />
                  </div>
                  <div>
                    <p className="text-lg font-semibold text-[#050505]">{previewItem.name}</p>
                    <p className="text-sm text-[#6D6E71] mt-1">
                      {isWordDoc
                        ? 'Word documents are supported here, but browser inline preview is limited. Use download to open the full file.'
                        : 'Inline preview is not available for this file type yet. You can still download it.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <aside className="bg-white p-5 lg:p-6 overflow-y-auto">
            <div className="space-y-5">
              <div className="rounded-3xl border border-gray-100 bg-[linear-gradient(135deg,#f8fafc,#eef5ff)] p-5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: bg }}>
                    <Icon size={24} style={{ color }} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-[#050505] truncate">{previewItem.name}</p>
                    <p className="text-xs text-[#6D6E71]">{getFileKind(previewItem.ext)}</p>
                  </div>
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold" style={{ color: statusMeta.color, background: statusMeta.bg }}>
                  <StatusIcon size={12} />
                  {statusMeta.label}
                </div>
              </div>

              <div className="grid gap-3">
                {metaItems.map(({ label, value }) => (
                  <div key={label} className="rounded-2xl border border-gray-100 bg-[#FBFCFE] p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#A5A5A5]">{label}</p>
                    <p className="text-sm font-semibold text-[#050505] mt-1 break-words">{value}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-2xl bg-[#F8FAFC] border border-gray-100 p-4">
                <p className="text-sm font-semibold text-[#050505]">Preview Notes</p>
                <p className="text-xs leading-5 text-[#6D6E71] mt-2">
                  PDFs and images open directly inside this preview. Multi-page PDFs stay scrollable in the preview area, and Word documents remain available through download when the browser cannot render them inline.
                </p>
              </div>
            </div>
          </aside>
        </div>

        <div className="flex gap-3 p-5 border-t border-gray-100 bg-white">
          <button
            onClick={handleDownload}
            disabled={!blobUrl}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-colors ${blobUrl ? 'bg-[#05164D] text-white hover:bg-[#041240]' : 'bg-gray-200 text-[#A5A5A5] cursor-not-allowed'}`}
          >
            <Download size={15} /> Download
          </button>
          <button
            onClick={hidePreview}
            className="px-4 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-[#6D6E71] hover:bg-gray-50 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── UploadProgress Toast ────────────────────────────────────────────────────
function UploadProgressToast() {
  const { uploadProgress } = useFileExplorerStore();
  if (!uploadProgress) return null;
  const pct = Math.round((uploadProgress.done / uploadProgress.total) * 100);
  const done = uploadProgress.done >= uploadProgress.total;

  return (
    <div className="fixed bottom-6 right-6 z-50 bg-white rounded-2xl shadow-xl border border-gray-100 p-4 w-72 animate-fadeIn">
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${done ? 'bg-[#8BC53D]/20' : 'bg-[#05164D]/10'}`}>
          {done ? <CheckCircle size={16} className="text-[#8BC53D]" /> : <Upload size={16} className="text-[#05164D] animate-bounce" />}
        </div>
        <div>
          <p className="text-sm font-semibold text-[#050505]">{done ? 'Upload complete!' : 'Uploading…'}</p>
          <p className="text-xs text-[#A5A5A5]">{uploadProgress.done} / {uploadProgress.total} files</p>
        </div>
      </div>
      <div className="w-full bg-gray-100 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full transition-all duration-300 ${done ? 'bg-[#8BC53D]' : 'bg-[#05164D]'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────────────────────────
function EmptyState({ currentFolderId, onUpload, canWrite }) {
  const { startNewFolder } = useFileExplorerStore();
  return (
    <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
      <div className="w-20 h-20 rounded-3xl bg-gray-100 flex items-center justify-center mb-4">
        <FolderOpen size={36} className="text-gray-400" />
      </div>
      <p className="font-semibold text-[#050505] text-lg mb-1">This folder is empty</p>
      <p className="text-sm text-[#A5A5A5] mb-6">Drop files here or use the buttons to add content</p>
      <div className="flex gap-3">
        <button
          onClick={() => { if (canWrite) onUpload(); }}
          disabled={!canWrite}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${canWrite ? 'bg-[#8BC53D] text-white hover:bg-[#7ab535]' : 'bg-gray-200 text-[#A5A5A5] cursor-not-allowed'}`}
        >
          <Upload size={15} /> Upload Files
        </button>
        <button
          onClick={() => { if (canWrite) startNewFolder(currentFolderId); }}
          disabled={!canWrite}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors border ${canWrite ? 'border-gray-200 text-[#6D6E71] hover:bg-gray-50' : 'border-gray-200 text-[#A5A5A5] bg-gray-100 cursor-not-allowed'}`}
        >
          <FolderPlus size={15} /> New Folder
        </button>
      </div>
    </div>
  );
}

// ── SystemFileDragOverlay ─────────────────────────────────────────────────────
function SystemFileDragOverlay({ currentFolderName }) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#8BC53D]/10 border-2 border-dashed border-[#8BC53D] rounded-xl m-2 pointer-events-none">
      <div className="text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#8BC53D]/20 flex items-center justify-center mx-auto mb-3">
          <Upload size={32} className="text-[#8BC53D]" />
        </div>
        <p className="font-bold text-[#476E2C] text-lg">Drop to upload</p>
        <p className="text-sm text-[#8BC53D] mt-1">Into <strong>{currentFolderName}</strong></p>
      </div>
    </div>
  );
}

// ── DuplicateWarning ───────────────────────────────────────────────────────────
function DuplicateWarning({ names, onClose }) {
  return (
    <div className="flex items-start gap-3 p-4 bg-[#FEF5E7] border border-[#F68C1F]/40 rounded-2xl mb-3 animate-fadeIn">
      <AlertCircle size={18} className="text-[#F68C1F] flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#b45e08]">Duplicate file name{names.length > 1 ? 's' : ''} detected</p>
        <p className="text-xs text-[#b45e08]/80 mt-0.5">
          {names.join(', ')} — renamed with "(copy)"
        </p>
      </div>
      <button onClick={onClose} className="text-[#F68C1F] hover:text-[#b45e08]"><X size={14} /></button>
    </div>
  );
}

// ── Main FileExplorer ─────────────────────────────────────────────────────────
export default function FileExplorer({ role = 'broker', title, companyId, currentUserId }) {
  const {
    tree, currentPath, view, sortBy, sortDir, searchQuery, selectedItems,
    clearSelection, hideContextMenu, uploadFiles, dragOver, draggingItems,
    setDragOver, moveItemsTo, clearDrag, newFolderParentId, folderAccess, setFolderAccess,
    hydrateFromApi, setCompanyId, setCreatedBy, loadFolderAccessFromApi, syncFolderAccessToApi,
  } = useFileExplorerStore();

  const fileInputRef = useRef(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState('');
  const [dragCounter, setDragCounter] = useState(0);
  const [duplicateWarnings, setDuplicateWarnings] = useState([]);
  const [shareModal, setShareModal] = useState(null);
  const [moveModal, setMoveModal] = useState(null);
  const [requestCountsByFolderName, setRequestCountsByFolderName] = useState({});
  const [sharePeople, setSharePeople] = useState([]);

  useEffect(() => {
    if (!companyId) return;
    setCompanyId(companyId);
    setLoadingTree(true);
    setTreeError('');
    hydrateFromApi(companyId)
      .catch((err) => setTreeError(err.message || 'Unable to load folders.'))
      .finally(() => setLoadingTree(false));
  }, [companyId, hydrateFromApi, setCompanyId]);

  useEffect(() => {
    if (!companyId) {
      setRequestCountsByFolderName({});
      return;
    }
    listCompanyRequests(companyId)
      .then((list) => {
        const counts = {};
        list.forEach((req) => {
          const key = (req.sub_label || req.category || '').toString().trim().toLowerCase();
          if (!key) return;
          counts[key] = (counts[key] || 0) + 1;
        });
        setRequestCountsByFolderName(counts);
      })
      .catch(() => setRequestCountsByFolderName({}));
  }, [companyId]);

  useEffect(() => {
    if (!companyId) {
      setSharePeople([]);
      return;
    }

    listUsersRequest()
      .then((users) => {
        const people = users
          .filter((user) => {
            const userCompanyId = user.company_id || user.companyId;
            const userCompanyIds = user.company_ids || user.companyIds || [userCompanyId].filter(Boolean);
            const effectiveRole = (user.effective_role || user.role || '').toLowerCase();
            return userCompanyIds.some((id) => String(id) === String(companyId)) && effectiveRole === 'user';
          })
          .map((user) => ({
            id: user.id,
            name: user.name || user.email || 'Unnamed user',
            meta: user.email || user.phone || 'Client user',
            type: 'user',
          }));
        setSharePeople(people);
      })
      .catch(() => setSharePeople([]));
  }, [companyId]);

  useEffect(() => {
    if (!currentUserId) return;
    setCreatedBy(currentUserId);
  }, [currentUserId, setCreatedBy]);

  useEffect(() => {
    if (role === 'broker' || !companyId) return;

    const folderIds = collectFolderIds(tree);
    if (!folderIds.length) return;

    let cancelled = false;

    Promise.all(folderIds.map(async (folderId) => {
      const entries = await loadFolderAccessFromApi(folderId);
      return [folderId, entries];
    }))
      .then((results) => {
        if (cancelled) return;
        results.forEach(([folderId, entries]) => {
          setFolderAccess(folderId, entries);
        });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [companyId, role, tree, loadFolderAccessFromApi, setFolderAccess]);

  const currentFolderId = currentPath[currentPath.length - 1];
  const currentFolder = findById(tree, currentFolderId) || tree;
  const canManageAccess = role === 'broker';

  const currentUser = role === 'broker'
    ? null
    : { id: currentUserId, groups: [] };

  const getFolderPermissions = useCallback((folderId) => {
    if (role === 'broker') return { read: true, write: true, download: true };
    if (role === 'client') return { read: true, write: true, download: true };
    let entries = folderAccess[folderId] || [];
    if (entries.length === 0) {
      const path = getPathTo(tree, folderId);
      if (path && path.length > 1) {
        for (let i = path.length - 2; i >= 0; i -= 1) {
          const ancestorEntries = folderAccess[path[i]] || [];
          if (ancestorEntries.length > 0) {
            entries = ancestorEntries;
            break;
          }
        }
      }
    }
    const perms = { read: false, write: false, download: false };
    entries.forEach(entry => {
      const subjectId = entry.subjectId || entry.id;
      const matchesUser = entry.type === 'user' && subjectId === currentUser?.id;
      const matchesGroup = entry.type === 'group' && currentUser?.groups?.includes(subjectId);
      if (matchesUser || matchesGroup) {
        perms.read = perms.read || entry.permissions.read;
        perms.write = perms.write || entry.permissions.write;
        perms.download = perms.download || entry.permissions.download;
      }
    });
    return perms;
  }, [folderAccess, role, currentUser, tree]);

  const getSharedMeta = useCallback((folderId) => {
    const entries = folderAccess[folderId] || [];
    const count = entries.length;
    return count > 0
      ? { count, tooltip: `Shared with ${count} user${count === 1 ? '' : 's'}` }
      : { count: 0, tooltip: '' };
  }, [folderAccess]);

  const currentFolderPermissions = getFolderPermissions(currentFolderId);
  const canWriteCurrent = currentFolderPermissions.write || role === 'broker';
  const canReadCurrent = currentFolderPermissions.read || role === 'broker' || currentFolderId === 'root';

  // Get items in current view
  const rawItems = searchQuery
    ? searchTree(tree, searchQuery)
    : sortItems(currentFolder.children || [], sortBy, sortDir);
  const canReadFile = (item) => {
    const path = getPathTo(tree, item.id);
    if (path && path.length > 1) {
      const parentId = path[path.length - 2];
      return getFolderPermissions(parentId).read;
    }
    return canReadCurrent;
  };
  const currentItems = role === 'broker'
    ? rawItems
    : rawItems.filter(item => (
      item.type === 'folder' ? getFolderPermissions(item.id).read : canReadFile(item)
    ));

  // Handle system file drag enter/leave
  const handleDragEnter = useCallback((e) => {
    if (e.dataTransfer.types.includes('Files')) setDragCounter(c => c + 1);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragCounter(c => Math.max(0, c - 1));
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
    } else {
      e.dataTransfer.dropEffect = 'move';
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragCounter(0);
    setDragOver(null);
    if (e.dataTransfer.files.length > 0) {
      if (!canWriteCurrent) return;
      const warns = uploadFiles(currentFolderId, e.dataTransfer.files);
      if (warns.length > 0) setDuplicateWarnings(warns);
    } else if (draggingItems.length > 0) {
      // drop on background = no-op (items stay where they are)
      clearDrag();
    }
  }, [currentFolderId, uploadFiles, draggingItems, setDragOver, clearDrag, canWriteCurrent]);

  // File input upload
  const handleFileInputChange = (e) => {
    if (!canWriteCurrent) return;
    if (e.target.files?.length) {
      const warns = uploadFiles(currentFolderId, e.target.files);
      if (warns.length > 0) setDuplicateWarnings(warns);
      e.target.value = '';
    }
  };

  const openUpload = () => {
    if (!canWriteCurrent) return;
    fileInputRef.current?.click();
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handle = (e) => {
      if (e.key === 'Escape') {
        clearSelection();
        hideContextMenu();
        useFileExplorerStore.getState().cancelNewFolder();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length > 0 &&
          !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        if (role === 'broker') useFileExplorerStore.getState().deleteItems(selectedItems);
      }
      if (e.key === 'F2' && selectedItems.length === 1) {
        if (role === 'broker') useFileExplorerStore.getState().startRenaming(selectedItems[0]);
      }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [selectedItems, clearSelection, hideContextMenu, role]);

  const isSystemDragging = dragCounter > 0 && draggingItems.length === 0;
  const shareFolder = shareModal ? findById(tree, shareModal.folderId) : null;
  const moveFolder = moveModal ? findById(tree, moveModal.folderId) : null;

  const openShareAccess = async (folder) => {
    if (!canManageAccess || folder?.type !== 'folder') return;
    await loadFolderAccessFromApi(folder.id);
    setShareModal({ folderId: folder.id });
  };

  const openMoveFolder = (folder) => {
    if (!canManageAccess || folder?.type !== 'folder') return;
    setMoveModal({ folderId: folder.id });
  };

  const saveFolderAccess = async (entries) => {
    if (!shareFolder) return;
    const normalizedEntries = entries.map((entry) => ({
      ...entry,
      type: 'user',
      subjectId: entry.subjectId || entry.id,
      permissions: accessTypeToPermissions(entry.accessType || permissionsToAccessType(entry.permissions)),
    }));
    await syncFolderAccessToApi(shareFolder.id, normalizedEntries);
    setFolderAccess(shareFolder.id, normalizedEntries);
  };

  return (
    <div className="flex bg-[#f4f6fb] rounded-2xl border border-gray-200 shadow-sm overflow-hidden h-full">
      {/* Sidebar */}
      <FolderTree
        tree={tree}
        onUpload={openUpload}
        role={role}
        getFolderPermissions={getFolderPermissions}
        requestCountsByFolderName={requestCountsByFolderName}
      />

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Top Bar */}
        <TopBar
          tree={tree}
          currentPath={currentPath}
          onUpload={openUpload}
          role={role}
          currentFolderPermissions={currentFolderPermissions}
        />

        {/* Content Area */}
        {treeError && (
          <div className="px-4 py-3 mb-4 bg-red-50 rounded-2xl border border-red-100 text-sm text-[#C62026]">
            {treeError}
          </div>
        )}
        <div
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 relative"
          onClick={() => { clearSelection(); hideContextMenu(); }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {/* System drag overlay */}
          {isSystemDragging && (
            <SystemFileDragOverlay currentFolderName={currentFolder.name} />
          )}

          {/* Duplicate warnings */}
          {duplicateWarnings.length > 0 && (
            <DuplicateWarning names={duplicateWarnings} onClose={() => setDuplicateWarnings([])} />
          )}

          {/* Search title */}
          {searchQuery && (
            <div className="flex items-center gap-2 mb-3">
              <Search size={14} className="text-[#A5A5A5]" />
              <p className="text-sm text-[#6D6E71]">
                Search results for <strong className="text-[#050505]">"{searchQuery}"</strong>
                {' '}— {currentItems.length} item{currentItems.length !== 1 ? 's' : ''}
              </p>
            </div>
          )}

          {/* Content */}
          {currentItems.length === 0 && newFolderParentId !== currentFolderId ? (
            <EmptyState currentFolderId={currentFolderId} onUpload={openUpload} canWrite={canWriteCurrent} />
          ) : view === 'grid' ? (
            <FileGrid
              items={currentItems}
              currentFolderId={currentFolderId}
              role={role}
              getFolderPermissions={getFolderPermissions}
              getSharedMeta={getSharedMeta}
              onShareAccess={openShareAccess}
              onMoveFolder={openMoveFolder}
              currentFolderPermissions={currentFolderPermissions}
            />
          ) : (
            <div className="bg-white rounded-2xl overflow-hidden border border-gray-100">
              <FileTable
                items={currentItems}
                currentFolderId={currentFolderId}
                role={role}
                getFolderPermissions={getFolderPermissions}
                getSharedMeta={getSharedMeta}
                onShareAccess={openShareAccess}
                onMoveFolder={openMoveFolder}
                currentFolderPermissions={currentFolderPermissions}
              />
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {role === 'broker' && <ContextMenu tree={tree} />}

      {/* Preview Modal */}
      <PreviewModal />

      {/* Share Access Modal */}
      <ShareAccessModal
        isOpen={!!shareModal}
        folder={shareFolder}
        entries={shareFolder ? (folderAccess[shareFolder.id] || []) : []}
        people={sharePeople}
        onSave={saveFolderAccess}
        onClose={() => setShareModal(null)}
      />

      {/* Move Folder Modal */}
      <MoveFolderModal
        isOpen={!!moveModal}
        folder={moveFolder}
        tree={tree}
        onMove={(folderId, targetId) => {
          moveItemsTo([folderId], targetId);
          setMoveModal(null);
        }}
        onClose={() => setMoveModal(null)}
      />

      {/* Upload Progress Toast */}
      <UploadProgressToast />

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={handleFileInputChange}
      />
    </div>
  );
}





