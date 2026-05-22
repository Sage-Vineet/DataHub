import { create } from "zustand";
import {
    listManualGlUploadJobs,
    getManualGlUploadJob
} from "../lib/api";

export const useUploadJobStore = create((set, get) => ({
    jobs: [],
    currentJob: null, // Tracked active upload job for polling
    isLoading: false,
    error: null,
    lastFetchedCompanyId: null,

    fetchJobs: async (companyId, force = false) => {
        if (!companyId) return;

        if (!force && get().lastFetchedCompanyId === companyId && get().jobs.length > 0) {
            return;
        }

        set({ isLoading: true, error: null });
        try {
            const jobs = await listManualGlUploadJobs({ clientId: companyId });
            set({
                jobs,
                lastFetchedCompanyId: companyId,
                isLoading: false
            });
        } catch (error) {
            set({
                error: error.message || "Failed to fetch upload jobs",
                isLoading: false
            });
        }
    },

    pollJob: async (companyId, jobId) => {
        if (!companyId || !jobId) return null;

        try {
            const job = await getManualGlUploadJob(jobId, { clientId: companyId });
            if (job) {
                set({ currentJob: job });

                // Also update the job in the jobs list array if it exists
                set((state) => ({
                    jobs: state.jobs.map(j => j.id === job.id ? job : j)
                }));
            }
            return job;
        } catch (error) {
            console.error("[UploadJobStore] Failed to poll job:", error);
            return null;
        }
    },

    setCurrentJob: (job) => {
        set({ currentJob: job });
    },

    clearCurrentJob: () => {
        set({ currentJob: null });
    },

    clearStore: () => {
        set({
            jobs: [],
            currentJob: null,
            isLoading: false,
            error: null,
            lastFetchedCompanyId: null
        });
    }
}));
