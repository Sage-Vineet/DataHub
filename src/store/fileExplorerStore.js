import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createCompanyFolder,
  createFolderAccess,
  createFolderDocument,
  deleteDocument,
  deleteFolder,
  deleteFolderAccess,
  listFolderAccess,
  listFolderDocuments,
  listFolderTree,
  moveFolder,
  uploadFile,
  updateFolder,
  updateFolderAccess,
} from '../lib/api';

// ── Tree Utilities ──────────────────────────────────────────────────────────
export function findById(node, id) {
  if (node.id === id) return node;
  if (node.children) {
    for (const child of node.children) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function getPathTo(root, id, path = []) {
  if (root.id === id) return [...path, root.id];
  if (root.children) {
    for (const child of root.children) {
      const result = getPathTo(child, id, [...path, root.id]);
      if (result) return result;
    }
  }
  return null;
}

function insertChild(node, parentId, child) {
  if (node.id === parentId) {
    return { ...node, children: [...(node.children || []), child] };
  }
  if (!node.children) return node;
  return { ...node, children: node.children.map(c => insertChild(c, parentId, child)) };
}

function removeByIds(node, ids) {
  if (!node.children) return node;
  return {
    ...node,
    children: node.children
      .filter(c => !ids.includes(c.id))
      .map(c => removeByIds(c, ids)),
  };
}

function renameNode(node, id, newName) {
  if (node.id === id) return { ...node, name: newName };
  if (!node.children) return node;
  return { ...node, children: node.children.map(c => renameNode(c, id, newName)) };
}

function collectNodes(node, ids) {
  const result = [];
  if (!node.children) return result;
  for (const child of node.children) {
    if (ids.includes(child.id)) result.push(JSON.parse(JSON.stringify(child)));
    result.push(...collectNodes(child, ids));
  }
  return result;
}

function isAncestorOf(root, ancestorId, nodeId) {
  const ancestor = findById(root, ancestorId);
  if (!ancestor || !ancestor.children) return false;
  return !!findById(ancestor, nodeId);
}

export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function randomFolderColor() {
  const colors = ['#00B0F0', '#742982', '#F68C1F', '#8BC53D', '#05164D', '#b45e08'];
  return colors[Math.floor(Math.random() * colors.length)];
}


function mapFolderNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: 'folder',
    createdAt: node.created_at ? node.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    color: node.color || '#6D6E71',
    children: (node.children || []).map(mapFolderNode),
  };
}

function mapDocumentNode(doc) {
  const sizeNum = parseFloat(doc.size) || 0;
  return {
    id: doc.id,
    name: doc.name,
    type: 'file',
    size: formatFileSize(sizeNum),
    uploadedBy: doc.uploaded_by || 'Unknown',
    uploadedAt: doc.uploaded_at ? doc.uploaded_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    status: doc.status || 'under-review',
    ext: doc.ext || doc.name?.split('.').pop()?.toLowerCase() || '',
    fileUrl: doc.file_url || '',
  };
}

function flattenFolderIds(node, ids = []) {
  if (node.type === 'folder' && node.id !== 'root') ids.push(node.id);
  (node.children || []).forEach((child) => {
    if (child.type === 'folder') flattenFolderIds(child, ids);
  });
  return ids;
}

function insertDocs(root, folderId, docs) {
  if (root.id === folderId) {
    const children = root.children || [];
    return { ...root, children: [...children, ...docs] };
  }
  if (!root.children) return root;
  return { ...root, children: root.children.map((c) => insertDocs(c, folderId, docs)) };
}

// ── Initial Tree (seeded from mockData structure) ────────────────────────────
const INITIAL_TREE = {
  id: 'root',
  name: 'Documents',
  type: 'folder',
  createdAt: '2026-01-01',
  children: [
    {
      id: 'fdr-finance',
      name: 'Finance',
      type: 'folder',
      createdAt: '2026-01-15',
      color: '#00B0F0',
      children: [
        { id: 'doc1', name: 'Trial_Balance_Q3_2024.xlsx', type: 'file', size: '1.2 MB', uploadedBy: 'Finance Team', uploadedAt: '2026-03-25', status: 'verified', ext: 'xlsx' },
        { id: 'doc2', name: 'FS_Mapping_2024.pdf', type: 'file', size: '0.8 MB', uploadedBy: 'Controller', uploadedAt: '2026-03-25', status: 'verified', ext: 'pdf' },
        { id: 'doc4', name: 'EBITDA_Bridge_FY25.xlsx', type: 'file', size: '2.1 MB', uploadedBy: 'Controller', uploadedAt: '2026-03-25', status: 'verified', ext: 'xlsx' },
        { id: 'doc3', name: 'Revenue_Recognition_Memo.pdf', type: 'file', size: '1.5 MB', uploadedBy: 'Finance Team', uploadedAt: '2026-03-24', status: 'under-review', ext: 'pdf' },
        { id: 'fdr-fin-q3', name: 'Q3 Reports', type: 'folder', createdAt: '2026-02-01', color: '#00B0F0', children: [] },
      ],
    },
    {
      id: 'fdr-legal',
      name: 'Legal',
      type: 'folder',
      createdAt: '2026-01-20',
      color: '#742982',
      children: [
        { id: 'doc5', name: 'Board_Resolutions_2025.pdf', type: 'file', size: '3.4 MB', uploadedBy: 'Legal Team', uploadedAt: '2026-03-22', status: 'verified', ext: 'pdf' },
        { id: 'doc7', name: 'Litigation_Log_Mar2026.pdf', type: 'file', size: '0.9 MB', uploadedBy: 'Legal Counsel', uploadedAt: '2026-03-20', status: 'verified', ext: 'pdf' },
        { id: 'doc8', name: 'Employment_Agreements_CSuite.pdf', type: 'file', size: '4.2 MB', uploadedBy: 'HR / Legal', uploadedAt: '2026-03-26', status: 'under-review', ext: 'pdf' },
        { id: 'doc9', name: 'Compliance_Certificates_FY25.zip', type: 'file', size: '5.1 MB', uploadedBy: 'Compliance Team', uploadedAt: '2026-03-25', status: 'under-review', ext: 'zip' },
        { id: 'fdr-leg-contracts', name: 'Contracts', type: 'folder', createdAt: '2026-02-10', color: '#742982', children: [] },
      ],
    },
    {
      id: 'fdr-hr',
      name: 'HR & People',
      type: 'folder',
      createdAt: '2026-02-01',
      color: '#F68C1F',
      children: [
        { id: 'doc10', name: 'Total_Comp_Summary_FY25.xlsx', type: 'file', size: '0.7 MB', uploadedBy: 'HR Team', uploadedAt: '2026-03-24', status: 'under-review', ext: 'xlsx' },
        { id: 'doc6', name: 'CapTable_FullyDiluted.xlsx', type: 'file', size: '0.6 MB', uploadedBy: 'CFO Office', uploadedAt: '2026-03-26', status: 'under-review', ext: 'xlsx' },
      ],
    },
    {
      id: 'fdr-tax',
      name: 'Tax',
      type: 'folder',
      createdAt: '2026-02-15',
      color: '#8BC53D',
      children: [
        { id: 'doc11', name: 'Tax_Residency_Certificate.pdf', type: 'file', size: '0.4 MB', uploadedBy: 'Tax Team', uploadedAt: '2026-02-18', status: 'verified', ext: 'pdf' },
      ],
    },
    { id: 'fdr-mna', name: 'M&A', type: 'folder', createdAt: '2026-03-01', color: '#05164D', children: [] },
    { id: 'fdr-compliance', name: 'Compliance', type: 'folder', createdAt: '2026-03-05', color: '#b45e08', children: [] },
  ],
};

const INITIAL_FOLDER_ACCESS = {
  'fdr-finance': [
    { id: 'buyer-1', type: 'user', name: 'Ananya Mehta', permissions: { read: true, write: true, download: true } },
    { id: 'grp-finance', type: 'group', name: 'Finance Buyers', permissions: { read: true, write: false, download: true } },
  ],
  'fdr-legal': [
    { id: 'buyer-2', type: 'user', name: 'Rahul Sharma', permissions: { read: true, write: false, download: true } },
  ],
  'fdr-hr': [
    { id: 'grp-hr', type: 'group', name: 'HR Buyers', permissions: { read: true, write: true, download: false } },
  ],
  'fdr-tax': [
    { id: 'buyer-3', type: 'user', name: 'Zara Khan', permissions: { read: true, write: false, download: true } },
  ],
  'fdr-mna': [
    { id: 'grp-mna', type: 'group', name: 'M&A Committee', permissions: { read: true, write: false, download: false } },
  ],
  'fdr-compliance': [
    { id: 'grp-compliance', type: 'group', name: 'Compliance Reviewers', permissions: { read: true, write: true, download: true } },
  ],
};

// ── Store ────────────────────────────────────────────────────────────────────
export const useFileExplorerStore = create(
  persist(
    (set, get) => ({
      tree: INITIAL_TREE,
      companyId: null,
      createdBy: null,
      currentPath: ['root'],
      expandedFolders: ['root', 'fdr-finance', 'fdr-legal'],
      selectedItems: [],
      view: 'grid',
      sortBy: 'name',
      sortDir: 'asc',
      searchQuery: '',
      renamingId: null,
      newFolderParentId: null,
      contextMenu: null,
      previewItem: null,
      dragOver: null,
      draggingItems: [],
      uploadProgress: null,
      folderAccess: INITIAL_FOLDER_ACCESS,
      setCompanyId: (companyId) => set({ companyId }),
      setCreatedBy: (createdBy) => set({ createdBy }),
      setTree: (tree) => set({ tree }),
      setCurrentPath: (currentPath) => set({ currentPath }),
      setExpandedFolders: (expandedFolders) => set({ expandedFolders }),
      hydrateFromApi: async (companyId) => {
        if (!companyId) return;
        const treeResponse = await listFolderTree(companyId);
        const children = treeResponse.map(mapFolderNode);
        let root = { id: 'root', name: 'Documents', type: 'folder', createdAt: new Date().toISOString().slice(0, 10), children };
        const folderIds = flattenFolderIds(root);
        const docsByFolder = {};
        await Promise.all(folderIds.map(async (folderId) => {
          const docs = await listFolderDocuments(folderId);
          docsByFolder[folderId] = docs.map(mapDocumentNode);
        }));
        folderIds.forEach((folderId) => {
          root = insertDocs(root, folderId, docsByFolder[folderId] || []);
        });
        const expanded = ['root', ...children.map((c) => c.id)];
        set({ tree: root, companyId, currentPath: ['root'], expandedFolders: expanded });
      },
      loadFolderAccessFromApi: async (folderId) => {
        const entries = await listFolderAccess(folderId);
        const mapped = entries.map((entry) => ({
          id: entry.id,
          subjectId: entry.user_id || entry.group_id,
          type: entry.user_id ? 'user' : 'group',
          name: entry.user_id || entry.group_id,
          permissions: {
            read: !!entry.can_read,
            write: !!entry.can_write,
            download: !!entry.can_download,
          },
        }));
        set(s => ({ folderAccess: { ...s.folderAccess, [folderId]: mapped } }));
        return mapped;
      },
      syncFolderAccessToApi: async (folderId, entries) => {
        const existing = await listFolderAccess(folderId);
        await Promise.all(existing.map((entry) => deleteFolderAccess(entry.id)));
        await Promise.all(entries.map((entry) => {
          const subjectId = entry.subjectId || entry.id;
          return createFolderAccess(folderId, {
            user_id: entry.type === 'user' ? subjectId : null,
            group_id: entry.type === 'group' ? subjectId : null,
            can_read: !!entry.permissions.read,
            can_write: !!entry.permissions.write,
            can_download: !!entry.permissions.download,
            created_by: get().createdBy || null,
          });
        }));
      },

      // ── Navigation ──
      navigateTo: (folderId) => {
        const path = getPathTo(get().tree, folderId);
        if (path) {
          set({
            currentPath: path,
            selectedItems: [],
            searchQuery: '',
            expandedFolders: [...new Set([...get().expandedFolders, ...path])],
          });
        }
      },

      goBack: () => {
        const { currentPath } = get();
        if (currentPath.length > 1) {
          set({ currentPath: currentPath.slice(0, -1), selectedItems: [], searchQuery: '' });
        }
      },

      // ── Sidebar expand/collapse ──
      toggleExpand: (folderId) => {
        const { expandedFolders } = get();
        set({
          expandedFolders: expandedFolders.includes(folderId)
            ? expandedFolders.filter(id => id !== folderId)
            : [...expandedFolders, folderId],
        });
      },

      // ── Selection ──
      selectItem: (id, multi) => {
        const { selectedItems } = get();
        if (multi) {
          set({
            selectedItems: selectedItems.includes(id)
              ? selectedItems.filter(i => i !== id)
              : [...selectedItems, id],
          });
        } else {
          set({ selectedItems: [id] });
        }
      },
      clearSelection: () => set({ selectedItems: [] }),

      // ── View / Sort ──
      setView: (v) => set({ view: v }),
      setSortBy: (sortBy) =>
        set(s => ({
          sortBy,
          sortDir: s.sortBy === sortBy ? (s.sortDir === 'asc' ? 'desc' : 'asc') : 'asc',
        })),
      setSearchQuery: (searchQuery) => set({ searchQuery }),

      // ── CRUD ──
      createFolder: async (parentId, name) => {
        const targetParentId = parentId || 'root';
        const trimmedName = name.trim() || 'New Folder';
        const tempId = `temp-${uid()}`;
        const tempFolder = {
          id: tempId,
          name: trimmedName,
          type: 'folder',
          createdAt: new Date().toISOString().split('T')[0],
          color: randomFolderColor(),
          children: [],
        };

        set(s => ({
          tree: insertChild(s.tree, targetParentId, tempFolder),
          newFolderParentId: null,
          expandedFolders: [...new Set([...s.expandedFolders, targetParentId])],
        }));

        const { companyId, createdBy } = get();
        if (companyId) {
          try {
            const created = await createCompanyFolder(companyId, {
              name: trimmedName,
              parent_id: targetParentId === 'root' ? null : targetParentId,
              color: tempFolder.color,
              created_by: createdBy || null,
            });
            const folder = {
              id: created.id,
              name: created.name,
              type: 'folder',
              createdAt: created.created_at ? created.created_at.slice(0, 10) : new Date().toISOString().split('T')[0],
              color: created.color || tempFolder.color,
              children: [],
            };
            set(s => {
              const removed = removeByIds(s.tree, [tempId]);
              return {
                tree: insertChild(removed, targetParentId, folder),
                expandedFolders: [...new Set([...s.expandedFolders, targetParentId])],
              };
            });
          } catch (err) {
            set(s => ({ tree: removeByIds(s.tree, [tempId]) }));
            throw err;
          }
          return;
        }

        set(s => ({ tree: removeByIds(s.tree, [tempId]) }));
        const id = 'fdr-' + uid();
        const folder = {
          id,
          name: trimmedName,
          type: 'folder',
          createdAt: new Date().toISOString().split('T')[0],
          color: '#6D6E71',
          children: [],
        };
        set(s => ({
          tree: insertChild(s.tree, targetParentId, folder),
          expandedFolders: [...new Set([...s.expandedFolders, targetParentId])],
        }));
      },

      renameItem: async (id, newName) => {
        if (!newName.trim()) {
          set({ renamingId: null });
          return;
        }
        const node = findById(get().tree, id);
        if (node?.type === 'folder') {
          await updateFolder(id, { name: newName.trim() });
        }
        set(s => ({ tree: renameNode(s.tree, id, newName.trim()), renamingId: null }));
      },

      deleteItems: async (ids) => {
        const tree = get().tree;
        await Promise.all(ids.map(async (id) => {
          const node = findById(tree, id);
          if (node?.type === 'folder') {
            await deleteFolder(id);
          } else if (node?.type === 'file') {
            await deleteDocument(id);
          }
        }));
        set(s => ({
          tree: removeByIds(s.tree, ids),
          selectedItems: s.selectedItems.filter(i => !ids.includes(i)),
          contextMenu: null,
        }));
      },

      moveItemsTo: async (itemIds, targetId) => {
        const { tree } = get();
        for (const id of itemIds) {
          if (id === targetId) return;
          const node = findById(tree, id);
          if (node?.type === 'folder' && isAncestorOf(tree, id, targetId)) return;
        }
        const target = findById(tree, targetId);
        if (!target || target.type !== 'folder') return;
        for (const id of itemIds) {
          const node = findById(tree, id);
          if (node?.type === 'folder') {
            await moveFolder(id, { parent_id: targetId === 'root' ? null : targetId });
          }
        }
        const items = collectNodes(tree, itemIds);
        let newTree = removeByIds(tree, itemIds);
        for (const item of items) newTree = insertChild(newTree, targetId, item);
        set({ tree: newTree, selectedItems: [], dragOver: null, draggingItems: [], contextMenu: null });
      },

      uploadFiles: async (parentId, files) => {
        const folder = findById(get().tree, parentId);
        const existingNames = new Set((folder?.children || []).map(c => c.name));
        const warnings = [];
        const newFiles = Array.from(files).map(f => {
          const ext = f.name.split('.').pop()?.toLowerCase() || '';
          let name = f.name;
          if (existingNames.has(name)) {
            warnings.push(name);
            const baseName = f.name.replace(/\.[^.]+$/, '');
            name = ext ? `${baseName} (copy).${ext}` : `${baseName} (copy)`;
          }
          return { file: f, name, ext };
        });

        set({ uploadProgress: { total: newFiles.length, done: 0, files: newFiles.map(f => f.name) } });

        let done = 0;
        const failedUploads = [];
        for (const fileItem of newFiles) {
          try {
            const uploaded = await uploadFile(fileItem.file, {
              fileName: fileItem.name,
              prefix: 'documents',
            });
            const createdDoc = await createFolderDocument(parentId, {
              company_id: get().companyId,
              name: fileItem.name,
              file_url: uploaded.fileUrl,
              upload_id: uploaded.id,
              size: fileItem.file.size?.toString() || '0',
              ext: fileItem.ext || '',
              status: 'under-review',
              uploaded_by: get().createdBy || null,
            });
            const destinationFolderId = createdDoc.folder_id || parentId;
            const fileNode = {
              id: createdDoc.id,
              name: createdDoc.name,
              type: 'file',
              size: formatFileSize(parseFloat(createdDoc.size) || fileItem.file.size),
              uploadedBy: createdDoc.uploaded_by || 'Current User',
              uploadedAt: createdDoc.uploaded_at ? createdDoc.uploaded_at.slice(0, 10) : new Date().toISOString().split('T')[0],
              status: createdDoc.status || 'under-review',
              ext: createdDoc.ext || fileItem.ext,
              fileUrl: createdDoc.file_url || uploaded.fileUrl,
            };
            set((s) => {
              let nextTree = s.tree;
              if (destinationFolderId !== 'root' && !findById(nextTree, destinationFolderId)) {
                nextTree = insertChild(nextTree, 'root', {
                  id: destinationFolderId,
                  name: createdDoc.folder_name || 'General Uploads',
                  type: 'folder',
                  createdAt: createdDoc.uploaded_at ? createdDoc.uploaded_at.slice(0, 10) : new Date().toISOString().split('T')[0],
                  color: '#6D6E71',
                  children: [],
                });
              }
              return { tree: insertChild(nextTree, destinationFolderId, fileNode) };
            });
          } catch (err) {
            failedUploads.push({ name: fileItem.name, error: err?.message || 'Unknown error' });
            console.error('File upload failed:', fileItem.name, err);
          } finally {
            done++;
            set(s => ({ uploadProgress: s.uploadProgress ? { ...s.uploadProgress, done } : null }));
          }
        }

        if (failedUploads.length > 0) {
          console.warn('Some file uploads failed:', failedUploads);
        }

        setTimeout(() => set({ uploadProgress: null }), 2000);
        return warnings;
      },

      // ── Drag state ──
      setDragOver: (id) => set({ dragOver: id }),
      setDraggingItems: (ids) => set({ draggingItems: ids }),
      clearDrag: () => set({ dragOver: null, draggingItems: [] }),

      // ── Context Menu ──
      showContextMenu: (x, y, itemId) =>
        set(s => ({
          contextMenu: { x, y, itemId },
          selectedItems: s.selectedItems.includes(itemId) ? s.selectedItems : [itemId],
        })),
      hideContextMenu: () => set({ contextMenu: null }),

      // ── Preview ──
      showPreview: (item) => set({ previewItem: item }),
      hidePreview: () => set({ previewItem: null }),

      // ── Rename inline ──
      startRenaming: (id) => set({ renamingId: id, contextMenu: null }),
      stopRenaming: () => set({ renamingId: null }),

      // ── New Folder ──
      startNewFolder: (parentId) => set({ newFolderParentId: parentId, contextMenu: null }),
      cancelNewFolder: () => set({ newFolderParentId: null }),

      // ── Folder Access Control ──
      setFolderAccess: (folderId, entries) =>
        set(s => ({ folderAccess: { ...s.folderAccess, [folderId]: entries } })),
    }),
    {
      name: 'leo-file-explorer',
      partialize: s => ({
        tree: s.tree,
        expandedFolders: s.expandedFolders,
        view: s.view,
        sortBy: s.sortBy,
        sortDir: s.sortDir,
        folderAccess: s.folderAccess,
      }),
    }
  )
);









