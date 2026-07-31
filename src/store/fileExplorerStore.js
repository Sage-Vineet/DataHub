import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  archiveDocument,
  archiveFolder,
  bulkDeleteDataRoomItems,
  createCompanyFolder,
  createFolderAccess,
  createFolderDocument,
  deleteFolderAccess,
  listFolderAccess,
  listFolderDocuments,
  listFolderTree,
  moveFolder,
  unarchiveDocument,
  unarchiveFolder,
  uploadFile,
  updateDocument,
  updateFolder,
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

function setArchivedByIds(node, ids, archivedAt) {
  const next = ids.includes(node.id) ? { ...node, archivedAt } : node;
  if (!next.children) return next;
  return { ...next, children: next.children.map(c => setArchivedByIds(c, ids, archivedAt)) };
}

function setColorById(node, id, color) {
  const next = node.id === id ? { ...node, color } : node;
  if (!next.children) return next;
  return { ...next, children: next.children.map(c => setColorById(c, id, color)) };
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

function collectNodesWithParents(node, ids) {
  const result = [];
  if (!node.children) return result;
  node.children.forEach((child, index) => {
    if (ids.includes(child.id)) {
      result.push({ parentId: node.id, index, item: JSON.parse(JSON.stringify(child)) });
    }
    result.push(...collectNodesWithParents(child, ids));
  });
  return result;
}

function isAncestorOf(root, ancestorId, nodeId) {
  const ancestor = findById(root, ancestorId);
  if (!ancestor || !ancestor.children) return false;
  return !!findById(ancestor, nodeId);
}

function getTopLevelIds(root, ids) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  return uniqueIds.filter((id) => !uniqueIds.some((otherId) => (
    otherId !== id && isAncestorOf(root, otherId, id)
  )));
}

function insertChildAt(node, parentId, child, index) {
  if (node.id === parentId) {
    const children = [...(node.children || [])].filter((existing) => existing.id !== child.id);
    const nextIndex = Math.max(0, Math.min(Number.isInteger(index) ? index : children.length, children.length));
    children.splice(nextIndex, 0, child);
    return { ...node, children };
  }
  if (!node.children) return node;
  return { ...node, children: node.children.map(c => insertChildAt(c, parentId, child, index)) };
}

function restoreRemovedNodes(root, entries) {
  return [...(entries || [])]
    .sort((a, b) => a.index - b.index)
    .reduce((nextTree, entry) => insertChildAt(nextTree, entry.parentId, entry.item, entry.index), root);
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

export const DATA_ROOM_COLOR_PALETTE = [
  '#C62026',
  '#F68C1F',
  '#FACC15',
  '#8BC53D',
  '#00648F',
  '#742982',
  '#050505',
  '#6D6E71',
];

export const DEFAULT_DATA_ROOM_COLOR = '#6D6E71';

export function normalizeDataRoomColor(color, fallback = DEFAULT_DATA_ROOM_COLOR) {
  const normalized = String(color || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(normalized)) return normalized.toUpperCase();
  return fallback;
}


function mapFolderNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: 'folder',
    createdAt: node.created_at ? node.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    archivedAt: node.archived_at || null,
    color: normalizeDataRoomColor(node.color),
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
    uploadedBy: doc.uploaded_by_name || 'Unknown',
    uploadedAt: doc.uploaded_at ? doc.uploaded_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    archivedAt: doc.archived_at || null,
    status: doc.status || 'under-review',
    ext: doc.ext || doc.name?.split('.').pop()?.toLowerCase() || '',
    fileUrl: doc.file_url || '',
    color: normalizeDataRoomColor(doc.color),
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

// ── Initial Tree ────────────────────────────
const INITIAL_TREE = {
  id: 'root',
  name: 'Documents',
  type: 'folder',
  createdAt: new Date().toISOString().slice(0, 10),
  children: [],
};

const INITIAL_FOLDER_ACCESS = {};

// ── Store ────────────────────────────────────────────────────────────────────
export const useFileExplorerStore = create(
  persist(
    (set, get) => ({
      tree: INITIAL_TREE,
      companyId: null,
      createdBy: null,
      currentPath: ['root'],
      expandedFolders: ['root'],
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
        const treeResponse = await listFolderTree(companyId, { includeArchived: true });
        const children = treeResponse.map(mapFolderNode);
        let root = { id: 'root', name: 'Documents', type: 'folder', createdAt: new Date().toISOString().slice(0, 10), children };
        const folderIds = flattenFolderIds(root);
        const docsByFolder = {};
        await Promise.all(folderIds.map(async (folderId) => {
          try {
            const docs = await listFolderDocuments(folderId, { includeArchived: true });
            docsByFolder[folderId] = docs.map(mapDocumentNode);
          } catch {
            docsByFolder[folderId] = [];
          }
        }));
        folderIds.forEach((folderId) => {
          root = insertDocs(root, folderId, docsByFolder[folderId] || []);
        });
        set((state) => {
          const currentId = state.currentPath[state.currentPath.length - 1];
          const preservedPath = currentId === 'archive'
            ? ['archive']
            : currentId === 'root'
              ? ['root']
              : (getPathTo(root, currentId) || ['root']);
          return {
            tree: root,
            companyId,
            currentPath: preservedPath,
            expandedFolders: [...new Set([...(state.expandedFolders || ['root']), ...preservedPath])],
          };
        });
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
        if (folderId === 'archive') {
          set({ currentPath: ['archive'], selectedItems: [], searchQuery: '', contextMenu: null });
          return;
        }
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
        if (currentPath[0] === 'archive') {
          set({ currentPath: ['root'], selectedItems: [], searchQuery: '' });
          return;
        }
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
      selectItems: (ids) => set({ selectedItems: [...new Set(ids)].filter(Boolean), contextMenu: null }),
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
      createFolder: async (parentId, name, color = DEFAULT_DATA_ROOM_COLOR) => {
        const targetParentId = parentId || 'root';
        const trimmedName = name.trim() || 'New Folder';
        const folderColor = normalizeDataRoomColor(color);
        const tempId = `temp-${uid()}`;
        const tempFolder = {
          id: tempId,
          name: trimmedName,
          type: 'folder',
          createdAt: new Date().toISOString().split('T')[0],
          color: folderColor,
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
              color: normalizeDataRoomColor(created.color, tempFolder.color),
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
          color: folderColor,
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
        } else if (node?.type === 'file') {
          await updateDocument(id, { name: newName.trim() });
        }
        set(s => ({ tree: renameNode(s.tree, id, newName.trim()), renamingId: null }));
      },

      deleteItems: async (ids) => {
        const tree = get().tree;
        const topLevelIds = getTopLevelIds(tree, ids);
        const nodes = collectNodesWithParents(tree, topLevelIds);
        const result = await bulkDeleteDataRoomItems(nodes.map(({ item }) => ({
          id: item.id,
          type: item.type,
        })));
        const failed = result?.failed || [];
        const deletedIds = (result?.deleted || [])
          .filter((item) => !item.skipped)
          .map((item) => item.id);
        set(s => ({
          tree: removeByIds(s.tree, deletedIds),
          selectedItems: s.selectedItems.filter(i => !deletedIds.includes(i)),
          contextMenu: null,
        }));
        if (failed.length && typeof window !== 'undefined') {
          window.alert([...new Set(failed.map((item) => (
            item.error || 'Unable to delete item'
          )))].join('\n'));
        }
      },

      archiveItems: async (ids) => {
        const tree = get().tree;
        const archivedAt = new Date().toISOString();
        set(s => ({
          tree: setArchivedByIds(s.tree, ids, archivedAt),
          selectedItems: [],
          contextMenu: null,
        }));
        try {
          await Promise.all(ids.map(async (id) => {
            const node = findById(tree, id);
            if (node?.type === 'folder') await archiveFolder(id);
            else if (node?.type === 'file') await archiveDocument(id);
          }));
        } catch (err) {
          set({ tree });
          throw err;
        }
      },

      unarchiveItems: async (ids) => {
        const tree = get().tree;
        set(s => ({
          tree: setArchivedByIds(s.tree, ids, null),
          selectedItems: [],
          contextMenu: null,
        }));
        try {
          await Promise.all(ids.map(async (id) => {
            const node = findById(tree, id);
            if (node?.type === 'folder') await unarchiveFolder(id);
            else if (node?.type === 'file') await unarchiveDocument(id);
          }));
        } catch (err) {
          set({ tree });
          throw err;
        }
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

      stageRemoveItems: (ids) => {
        const tree = get().tree;
        const topLevelIds = getTopLevelIds(tree, ids);
        const entries = collectNodesWithParents(tree, topLevelIds);
        if (!entries.length) return [];
        set(s => ({
          tree: removeByIds(s.tree, topLevelIds),
          selectedItems: s.selectedItems.filter((id) => !topLevelIds.includes(id)),
          contextMenu: null,
        }));
        return entries;
      },

      restoreRemovedItems: (entries) => {
        if (!entries?.length) return;
        set(s => ({
          tree: restoreRemovedNodes(s.tree, entries),
          selectedItems: [],
          contextMenu: null,
        }));
      },

      commitDeleteEntries: async (entries) => {
        const items = (entries || []).map(({ item }) => ({
          id: item.id,
          type: item.type,
        }));
        if (!items.length) return { deleted: [], failed: [] };
        const result = await bulkDeleteDataRoomItems(items);
        const failed = result?.failed || [];
        if (failed.length) {
          const err = new Error(failed.map((item) => item.error || 'Unable to delete item').join('\n'));
          err.failed = failed;
          err.deletedIds = (result?.deleted || []).filter((item) => !item.skipped).map((item) => item.id);
          throw err;
        }
        return result;
      },

      updateItemColor: async (id, color) => {
        const nextColor = normalizeDataRoomColor(color);
        const node = findById(get().tree, id);
        if (!node) return;
        const previousColor = normalizeDataRoomColor(node.color);
        set(s => ({ tree: setColorById(s.tree, id, nextColor), contextMenu: null }));
        try {
          if (node.type === 'folder') await updateFolder(id, { color: nextColor });
          else if (node.type === 'file') await updateDocument(id, { color: nextColor });
        } catch (err) {
          set(s => ({ tree: setColorById(s.tree, id, previousColor) }));
          throw err;
        }
      },

      uploadFiles: async (parentId, files) => {
        const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB — matches backend limit
        const fileColor = DEFAULT_DATA_ROOM_COLOR;
        const folder = findById(get().tree, parentId);
        const existingNames = new Set((folder?.children || []).map(c => c.name));
        const warnings = [];
        const oversized = Array.from(files).filter(f => f.size > MAX_FILE_BYTES);
        if (oversized.length > 0) {
          const names = oversized.map(f => f.name).join(', ');
          throw new Error(`File(s) exceed the 200 MB limit: ${names}`);
        }
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
              color: fileColor,
              uploaded_by: get().createdBy || null,
            });
            const destinationFolderId = createdDoc.folder_id || parentId;
            const fileNode = {
              id: createdDoc.id,
              name: createdDoc.name,
              type: 'file',
              size: formatFileSize(parseFloat(createdDoc.size) || fileItem.file.size),
              uploadedBy: createdDoc.uploaded_by_name || 'Current User',
              uploadedAt: createdDoc.uploaded_at ? createdDoc.uploaded_at.slice(0, 10) : new Date().toISOString().split('T')[0],
              status: createdDoc.status || 'under-review',
              ext: createdDoc.ext || fileItem.ext,
              fileUrl: createdDoc.file_url || uploaded.fileUrl,
              color: normalizeDataRoomColor(createdDoc.color, fileColor),
            };
            set((s) => {
              let nextTree = s.tree;
              if (destinationFolderId !== 'root' && !findById(nextTree, destinationFolderId)) {
                nextTree = insertChild(nextTree, 'root', {
                  id: destinationFolderId,
                  name: createdDoc.folder_name || 'General Uploads',
                  type: 'folder',
                  createdAt: createdDoc.uploaded_at ? createdDoc.uploaded_at.slice(0, 10) : new Date().toISOString().split('T')[0],
                  color: DEFAULT_DATA_ROOM_COLOR,
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






