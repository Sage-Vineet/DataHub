export const WORKSPACE_DATASOURCE_UPDATED_EVENT = "datahub:workspace-datasource-updated";
export const MANUAL_GL_STAGED_EVENT = "datahub:manual-gl-staged";

function canUseWindow() {
  return typeof window !== "undefined";
}

export function emitWorkspaceDataSourceUpdated(detail = {}) {
  if (!canUseWindow()) return;
  window.dispatchEvent(
    new CustomEvent(WORKSPACE_DATASOURCE_UPDATED_EVENT, {
      detail: {
        clientId: detail.clientId || null,
        sourceKey: detail.sourceKey || null,
        timestamp: new Date().toISOString(),
      },
    }),
  );
}

export function subscribeWorkspaceDataSourceUpdated(handler) {
  if (!canUseWindow() || typeof handler !== "function") {
    return () => {};
  }

  window.addEventListener(WORKSPACE_DATASOURCE_UPDATED_EVENT, handler);
  return () => {
    window.removeEventListener(WORKSPACE_DATASOURCE_UPDATED_EVENT, handler);
  };
}

export function emitManualGlStaged(detail = {}) {
  if (!canUseWindow()) return;
  window.dispatchEvent(
    new CustomEvent(MANUAL_GL_STAGED_EVENT, {
      detail: {
        clientId: detail.clientId || null,
        batchId: detail.batchId || null,
        timestamp: new Date().toISOString(),
      },
    }),
  );
}
