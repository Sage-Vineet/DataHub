import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `answer()` has to hand back the response it created.
 *
 * Attaching a file to the answer just posted needs that id, and the caller has no
 * other way to learn it — the id is generated server-side and the list reload that
 * follows does not carry it. This was discarded, which made the seller's attach
 * flow unbuildable without a second round trip to guess which response was theirs.
 */
vi.mock('../lib/api', () => ({
  createQaItemRequest: vi.fn(),
  getQaItemRequest: vi.fn(async () => ({ item: { id: 'i-1' }, responses: [], presentations: [], history: [] })),
  listQaCategoriesRequest: vi.fn(async () => []),
  listQaItemsRequest: vi.fn(async () => []),
  postQaResponseRequest: vi.fn(async () => ({ id: 'r-99', citation_ref: 'QA-001.R1', body: 'answered' })),
  publishQaPresentationRequest: vi.fn(),
  replaceQaAssigneesRequest: vi.fn(),
  replaceQaNomineesRequest: vi.fn(),
  updateQaItemRequest: vi.fn(),
  writeQaPresentationRequest: vi.fn(),
}));

const { useQaStore } = await import('./qaStore');
const api = await import('../lib/api');

afterEach(() => {
  vi.clearAllMocks();
  useQaStore.setState({ companyId: null, detail: null, items: [], categories: [] });
});

describe('qaStore.answer', () => {
  it('returns the created response so the caller can attach to it', async () => {
    useQaStore.setState({ companyId: 'c-1' });

    const created = await useQaStore.getState().answer('i-1', 'the answer');

    expect(created).toMatchObject({ id: 'r-99' });
  });

  it('passes the kind and supersedes options through unchanged', async () => {
    useQaStore.setState({ companyId: 'c-1' });

    await useQaStore.getState().answer('i-1', 'a correction', {
      kind: 'answer',
      supersedesId: 'r-1',
    });

    expect(api.postQaResponseRequest).toHaveBeenCalledWith('i-1', 'a correction', {
      kind: 'answer',
      supersedesId: 'r-1',
    });
  });

  it('still refreshes the open item and the list', async () => {
    useQaStore.setState({ companyId: 'c-1', detail: { item: { id: 'i-1' } } });

    await useQaStore.getState().answer('i-1', 'the answer');

    expect(api.getQaItemRequest).toHaveBeenCalledWith('i-1');
    expect(api.listQaItemsRequest).toHaveBeenCalled();
  });
});
