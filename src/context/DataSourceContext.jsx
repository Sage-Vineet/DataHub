import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { getReportSources, setSelectedReportSource } from '../lib/api';
import { useToast } from './ToastContext';
import { WORKSPACE_DATASOURCE_UPDATED_EVENT } from '../lib/dataSourceEvents';
import { normalizeReportSourceKey, getReportSourceMode, REPORT_SOURCE_KEYS } from '../lib/report-source';

const DataSourceContext = createContext(null);

export const useDataSource = () => {
  const context = useContext(DataSourceContext);
  if (!context) {
    throw new Error('useDataSource must be used within a DataSourceProvider');
  }
  return context;
};

function extractClientIdFromPath(pathname) {
  if (!pathname) return null;
  const match = pathname.match(
    /\/broker\/client\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match ? match[1] : null;
}

function sourceStorageKey(clientId) {
  return clientId ? `activeReportSource:${clientId}` : 'activeReportSource';
}

function localSourceKey(clientId) {
  return clientId ? `datahub-active-source:${clientId}` : 'datahub-active-source';
}

function getLocalSource(clientId) {
  if (!clientId || typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(localSourceKey(clientId)) || null; } catch { return null; }
}

function setLocalSource(clientId, source) {
  if (!clientId || typeof window === 'undefined') return;
  try { window.localStorage.setItem(localSourceKey(clientId), source); } catch { /* ignore quota */ }
}

export const DataSourceProvider = ({ children }) => {
  const location = useLocation();
  const { showToast } = useToast();

  // In HashRouter, useLocation().pathname is the path after the #
  const clientId = extractClientIdFromPath(location.pathname);

  const [isSwitching, setIsSwitching] = useState(false);
  const [isLoadingSource, setIsLoadingSource] = useState(false);
  const [quickbooksConnected, setQuickbooksConnected] = useState(false);
  const [activeSource, setActiveSource] = useState(null);
  const [sourceRecords, setSourceRecords] = useState([]);

  const clientIdRef = useRef(null);

  // Load source from API (and sessionStorage cache) when clientId changes
  useEffect(() => {
    if (!clientId) {
      clientIdRef.current = null;
      return;
    }

    // Skip if same clientId (no navigation change)
    if (clientIdRef.current === clientId) return;
    clientIdRef.current = clientId;

    // Apply localStorage first (survives browser restart), then sessionStorage
    const stored = sessionStorage.getItem(sourceStorageKey(clientId));
    const localStored = getLocalSource(clientId);
    const initialSource = localStored || stored;
    if (initialSource) {
      setActiveSource(initialSource);
    }

    setIsLoadingSource(true);
    getReportSources({ clientId })
      .then((data) => {
        if (clientIdRef.current !== clientId) return; // stale response
        const source = data?.activeSource || data?.selectedSource;
        // User's explicit localStorage choice persists over backend API response.
        // Only use backend value if user has never explicitly selected a source here.
        const localSource = getLocalSource(clientId);
        const normalized = localSource || (source
          ? normalizeReportSourceKey(source)
          : (stored || REPORT_SOURCE_KEYS.QUICKBOOKS));
        setActiveSource(normalized);
        setQuickbooksConnected(Boolean(data?.quickbooksConnected));
        setSourceRecords(Array.isArray(data?.sources) ? data.sources : []);
        sessionStorage.setItem(sourceStorageKey(clientId), normalized);
        // Seed localStorage on first visit so future visits use it as fallback.
        if (!localSource && normalized) setLocalSource(clientId, normalized);
      })
      .catch(() => {
        if (clientIdRef.current !== clientId) return;
        // Preserve prior snapshot metadata on transient failures so
        // disconnected/cached indicators do not flicker away.
        if (!stored) setActiveSource(REPORT_SOURCE_KEYS.QUICKBOOKS);
      })
      .finally(() => {
        if (clientIdRef.current === clientId) setIsLoadingSource(false);
      });
  }, [clientId]);

  // Listen for source change events from any part of the app
  useEffect(() => {
    function handleExternalUpdate(event) {
      const { sourceKey, clientId: eventClientId } = event.detail || {};
      if (!sourceKey) return;
      // Ignore events for a different client
      if (eventClientId && clientIdRef.current && eventClientId !== clientIdRef.current) return;

      const normalized = normalizeReportSourceKey(sourceKey);
      if (!normalized) return;
      setActiveSource(normalized);
      if (clientIdRef.current) {
        sessionStorage.setItem(sourceStorageKey(clientIdRef.current), normalized);
        setLocalSource(clientIdRef.current, normalized);
      }
    }

    window.addEventListener(WORKSPACE_DATASOURCE_UPDATED_EVENT, handleExternalUpdate);
    window.addEventListener('dataSourceChanged', handleExternalUpdate);
    return () => {
      window.removeEventListener(WORKSPACE_DATASOURCE_UPDATED_EVENT, handleExternalUpdate);
      window.removeEventListener('dataSourceChanged', handleExternalUpdate);
    };
  }, []);

  const switchDataSource = useCallback(async (sourceKey, forceDisconnect = false, clientIdOverride = null) => {
    setIsSwitching(true);
    const effectiveClientId = clientIdOverride || clientIdRef.current;
    const previousSource = activeSource;

    // Optimistic update
    setActiveSource(sourceKey);
    if (effectiveClientId) {
      sessionStorage.setItem(sourceStorageKey(effectiveClientId), sourceKey);
      setLocalSource(effectiveClientId, sourceKey);
    }
    window.dispatchEvent(new CustomEvent('dataSourceChanged', {
      detail: { sourceKey, clientId: effectiveClientId },
    }));

    try {
      const result = await setSelectedReportSource(sourceKey, {
        clientId: effectiveClientId,
        confirmSwitch: true,
        forceDisconnectQuickbooks: forceDisconnect,
      });

      if (result?.quickbooksConnected !== undefined) {
        setQuickbooksConnected(Boolean(result.quickbooksConnected));
      }
      if (Array.isArray(result?.sources)) {
        setSourceRecords(result.sources);
      }

      showToast({
        type: 'success',
        title: 'Source Switched',
        message: `Successfully switched to ${sourceKey === REPORT_SOURCE_KEYS.MANUAL_GL ? 'Manual GL' : 'QuickBooks'}.`,
      });

    } catch (err) {
      // Revert optimistic update
      setActiveSource(previousSource);
      if (effectiveClientId) {
        if (previousSource) {
          sessionStorage.setItem(sourceStorageKey(effectiveClientId), previousSource);
        } else {
          sessionStorage.removeItem(sourceStorageKey(effectiveClientId));
        }
      }
      window.dispatchEvent(new CustomEvent('dataSourceChanged', {
        detail: { sourceKey: previousSource, clientId: effectiveClientId },
      }));

      showToast({
        type: 'error',
        title: 'Switch Failed',
        message: err.message || 'Failed to switch data source.',
      });
      throw err;
    } finally {
      setIsSwitching(false);
    }
  }, [activeSource, showToast]);

  const activeSourceMode = getReportSourceMode(activeSource);
  const quickbooksRecord = useMemo(
    () => (sourceRecords || []).find((item) => normalizeReportSourceKey(item?.sourceKey) === REPORT_SOURCE_KEYS.QUICKBOOKS) || null,
    [sourceRecords],
  );
  const connectionState = useMemo(
    () => ({
      provider: 'quickbooks',
      connected: Boolean(quickbooksConnected),
      disconnected: !quickbooksConnected,
    }),
    [quickbooksConnected],
  );
  const syncState = useMemo(
    () => ({
      status: quickbooksRecord?.metadata?.syncStatus || 'idle',
      progress: Number(quickbooksRecord?.metadata?.syncProgress || 0),
      lastSyncAt: quickbooksRecord?.lastSyncedAt || null,
      syncJobId: quickbooksRecord?.metadata?.syncJobId || null,
    }),
    [quickbooksRecord],
  );
  const reportState = useMemo(
    () => ({
      activeSource,
      activeSourceMode,
      isSwitching,
      isLoadingSource,
    }),
    [activeSource, activeSourceMode, isSwitching, isLoadingSource],
  );
  const cacheState = useMemo(
    () => ({
      hasCachedSnapshot: Boolean(quickbooksRecord?.isAvailable),
      snapshotSource: quickbooksRecord?.isAvailable ? 'cached_snapshot' : null,
      lastSyncAt: quickbooksRecord?.lastSyncedAt || null,
    }),
    [quickbooksRecord],
  );

  return (
    <DataSourceContext.Provider value={{
      activeSource,
      activeSourceMode,
      setActiveSource,
      switchDataSource,
      isSwitching,
      isLoadingSource,
      quickbooksConnected,
      clientId,
      sourceRecords,
      connectionState,
      syncState,
      reportState,
      cacheState,
    }}>
      {children}
    </DataSourceContext.Provider>
  );
};
