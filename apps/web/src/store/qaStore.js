import { create } from 'zustand';
import {
  createQaItemRequest,
  getQaItemRequest,
  listQaCategoriesRequest,
  listQaItemsRequest,
  postQaResponseRequest,
  publishQaPresentationRequest,
  replaceQaAssigneesRequest,
  replaceQaNomineesRequest,
  updateQaItemRequest,
  writeQaPresentationRequest,
} from '../lib/api';

/**
 * Deal Q&A state.
 *
 * Shaped after `fileExplorerStore` — a plain zustand store with thunks — rather
 * than react-query, which is not a dependency of this app and is not something to
 * introduce alongside three new surfaces.
 *
 * Deliberately NOT wrapped in `persist`. Q&A carries per-deal commentary, and the
 * file explorer store has already shown what a shared browser does with cached
 * tenant data.
 */
export const useQaStore = create((set, get) => ({
  companyId: null,
  categories: [],
  items: [],
  detail: null,
  filters: { categoryId: null, status: null, mine: null },
  loading: false,
  detailLoading: false,
  error: null,

  setFilters: (patch) => {
    set((s) => ({ filters: { ...s.filters, ...patch } }));
    const { companyId } = get();
    if (companyId) get().load(companyId);
  },

  async load(companyId) {
    set({ loading: true, error: null, companyId });
    try {
      const { filters } = get();
      const [categories, items] = await Promise.all([
        listQaCategoriesRequest(companyId),
        listQaItemsRequest(companyId, {
          categoryId: filters.categoryId,
          status: filters.status,
          mine: filters.mine,
        }),
      ]);
      set({ categories, items, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  async openItem(itemId) {
    set({ detailLoading: true, detail: null });
    try {
      set({ detail: await getQaItemRequest(itemId), detailLoading: false });
    } catch (err) {
      set({ error: err.message, detailLoading: false });
    }
  },

  closeItem: () => set({ detail: null }),

  async refreshDetail() {
    const { detail } = get();
    if (!detail) return;
    set({ detail: await getQaItemRequest(detail.item.id) });
  },

  async ask(input) {
    const { companyId } = get();
    await createQaItemRequest(companyId, input);
    await get().load(companyId);
  },

  async answer(itemId, body, opts = {}) {
    await postQaResponseRequest(itemId, body, opts);
    await get().refreshDetail();
    await get().load(get().companyId);
  },

  /** The broker's reworded version. Written and published in one step from the UI. */
  async reword(itemId, sourceResponseId, body, { publish = true } = {}) {
    const created = await writeQaPresentationRequest(itemId, sourceResponseId, body);
    if (publish) await publishQaPresentationRequest(itemId, created.id);
    await get().refreshDetail();
  },

  async reassign(itemId, userIds, kind, note) {
    await replaceQaAssigneesRequest(itemId, userIds, kind, note);
    await get().refreshDetail();
    await get().load(get().companyId);
  },

  async setStatus(itemId, status) {
    await updateQaItemRequest(itemId, { status });
    await get().refreshDetail();
    await get().load(get().companyId);
  },

  async nominate(categoryId, userIds) {
    const { companyId } = get();
    set({ categories: await replaceQaNomineesRequest(companyId, categoryId, userIds) });
  },
}));

export default useQaStore;
