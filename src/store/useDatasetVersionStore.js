import { create } from "zustand";
import {
    listManualGlDatasetVersions,
    activateManualGlDatasetVersion,
    rollbackManualGlDatasetVersion
} from "../lib/api";

export const useDatasetVersionStore = create((set, get) => ({
    versions: [],
    activeVersion: null,
    isLoading: false,
    error: null,
    lastFetchedCompanyId: null,

    fetchVersions: async (companyId, force = false) => {
        if (!companyId) return;

        // Skip fetching if already in cache and we aren't forcing a refresh
        if (!force && get().lastFetchedCompanyId === companyId && get().versions.length > 0) {
            return;
        }

        set({ isLoading: true, error: null });
        try {
            const versions = await listManualGlDatasetVersions({ clientId: companyId });
            const active = versions.find(v => v.is_active) || null;

            set({
                versions,
                activeVersion: active,
                lastFetchedCompanyId: companyId,
                isLoading: false
            });
        } catch (error) {
            set({
                error: error.message || "Failed to fetch dataset versions",
                isLoading: false
            });
        }
    },

    activateVersion: async (companyId, versionId) => {
        if (!companyId || !versionId) return false;

        set({ isLoading: true, error: null });
        try {
            await activateManualGlDatasetVersion(versionId, { clientId: companyId });
            // Re-fetch to guarantee sync with backend state
            await get().fetchVersions(companyId, true);
            return true;
        } catch (error) {
            set({
                error: error.message || "Failed to activate version",
                isLoading: false
            });
            return false;
        }
    },

    rollbackVersion: async (companyId, versionId) => {
        if (!companyId || !versionId) return false;

        set({ isLoading: true, error: null });
        try {
            await rollbackManualGlDatasetVersion(versionId, { clientId: companyId });
            // Re-fetch to guarantee sync with backend state
            await get().fetchVersions(companyId, true);
            return true;
        } catch (error) {
            set({
                error: error.message || "Failed to rollback version",
                isLoading: false
            });
            return false;
        }
    },

    clearStore: () => {
        set({
            versions: [],
            activeVersion: null,
            isLoading: false,
            error: null,
            lastFetchedCompanyId: null
        });
    }
})); 
