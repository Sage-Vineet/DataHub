import { create } from 'zustand';

const STALE_MS = 5 * 60 * 1000; // 5 minutes

const DEFAULT_SELECTION = {
  selectedDocumentIds: [],
  selectedStartingDocumentId: '',
  selectedEndingDocumentId: '',
};

export const useGlDocumentStore = create((set, get) => ({
  // { [companyId]: { docs: Document[], fetchedAt: number } }
  cache: {},

  // { [companyId]: { selectedDocumentIds, selectedStartingDocumentId, selectedEndingDocumentId } }
  selections: {},

  isFresh(companyId) {
    const entry = get().cache[companyId];
    return !!entry && Date.now() - entry.fetchedAt < STALE_MS;
  },

  getDocuments(companyId) {
    return get().cache[companyId]?.docs ?? null;
  },

  setDocuments(companyId, docs) {
    set((state) => ({
      cache: {
        ...state.cache,
        [companyId]: { docs, fetchedAt: Date.now() },
      },
    }));
  },

  // Force a fresh fetch on next access (e.g. after manual refresh click)
  invalidate(companyId) {
    set((state) => {
      const next = { ...state.cache };
      delete next[companyId];
      return { cache: next };
    });
  },

  getSelection(companyId) {
    return get().selections[companyId] ?? { ...DEFAULT_SELECTION };
  },

  setSelection(companyId, partial) {
    const current = get().selections[companyId] ?? { ...DEFAULT_SELECTION };
    set((state) => ({
      selections: {
        ...state.selections,
        [companyId]: { ...current, ...partial },
      },
    }));
  },

  clearSelection(companyId) {
    set((state) => {
      const next = { ...state.selections };
      delete next[companyId];
      return { selections: next };
    });
  },
}));
