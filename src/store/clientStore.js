import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useClientStore = create(
  persist(
    (set) => ({
      selectedClient: null,
      setSelectedClient: (client) => set({ selectedClient: client }),
      clearSelectedClient: () => set({ selectedClient: null }),
    }),
    { name: 'leo-selected-client' }
  )
);
