import { isSessionExpired, triggerSessionExpired } from './session';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN_KEY = 'leo-auth-token';
const LEGACY_TOKEN_KEY = 'leo-token';

function buildUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function resolveProtectedFileUrl(fileUrl) {
  const raw = String(fileUrl || '').trim();
  if (!raw) return '';
  if (raw.startsWith('blob:')) return raw;

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(raw);
  if (!hasProtocol) {
    return buildUrl(raw);
  }

  if (typeof window === 'undefined') {
    return raw;
  }

  try {
    const parsed = new URL(raw, window.location.origin);
    const apiOrigin = new URL(API_BASE_URL, window.location.origin).origin;
    const isUploadPath = /^\/uploads\/[^/]+\/content\/?$/.test(parsed.pathname || '');

    // Historical data can contain app-domain upload URLs; force those to API host.
    if (isUploadPath && parsed.origin !== apiOrigin) {
      return `${API_BASE_URL}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }

    return parsed.toString();
  } catch {
    return raw;
  }
}

function unwrapPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (Object.prototype.hasOwnProperty.call(payload, 'data')) return payload.data;
  if (Object.prototype.hasOwnProperty.call(payload, 'company')) return payload.company;
  if (Object.prototype.hasOwnProperty.call(payload, 'user')) return payload.user;
  return payload;
}

function ensureArray(payload) {
  const data = unwrapPayload(payload);
  if (Array.isArray(data)) return data;
  if (data?.items && Array.isArray(data.items)) return data.items;
  if (data?.results && Array.isArray(data.results)) return data.results;
  if (data?.rows && Array.isArray(data.rows)) return data.rows;
  if (data?.users && Array.isArray(data.users)) return data.users;
  if (data?.companies && Array.isArray(data.companies)) return data.companies;
  return [];
}

function resolveClientIdFromLocation() {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash || '';
  const pathname = window.location.pathname || '';

  // We only want to extract an ID if it's explicitly under the broker's client workspace
  const brokerMatch =
    hash.match(/\/broker\/client\/([^/?#]+)/) ||
    pathname.match(/\/broker\/client\/([^/?#]+)/) ||
    hash.match(/\/broker\/workspace\/([^/?#]+)/) ||
    pathname.match(/\/broker\/workspace\/([^/?#]+)/);

  if (brokerMatch) {
    const id = decodeURIComponent(brokerMatch[1]);
    // Safety: ensure it looks like a database ID (UUID) and not a static route
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) return null;
    return id;
  }

  const candidates = [
    (window.location.hash || '').replace(/^#/, ''),
    window.location.pathname || '',
  ];

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const candidate of candidates) {
    if (!candidate.startsWith('/client/')) continue;
    const match = candidate.match(/^\/client\/([^/?#]+)/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      // Must be a UUID — route names like "messages", "documents", "requests"
      // are not valid company IDs and must never be sent as X-Client-Id.
      if (uuidPattern.test(id)) return id;
    }
  }

  return null;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY);
}

export function setStoredToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(LEGACY_TOKEN_KEY);
}


async function request(path, options = {}) {
  const token = options.token ?? getStoredToken();

  // Reject every authenticated request once the 8-hour session window has closed.
  // triggerSessionExpired() notifies AuthContext synchronously so the UI redirects
  // to /login. The thrown error propagates up to the calling component.
  if (token && isSessionExpired()) {
    triggerSessionExpired();
    const err = new Error('Session expired. Please log in again.');
    err.status = 401;
    err.sessionExpired = true;
    throw err;
  }

  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
    'Cache-Control': 'no-store',
    ...(clientId ? { 'X-Client-Id': clientId } : {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl(path), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
    credentials: options.credentials || 'omit',
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(data?.error || data?.message || 'Request failed');
    error.status = response.status;
    if (data && typeof data === 'object') {
      error.payload = data;
    }
    throw error;
  }

  return data;
}

export function loginRequest(credentials) {
  return fetch(buildUrl('/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(credentials),
    cache: 'no-store',
    credentials: 'omit',
  }).then(async (response) => {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || 'Request failed');
    }
    const authHeader = response.headers.get('authorization') || response.headers.get('Authorization');
    const tokenFromHeader = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : authHeader;
    const tokenFromAlt =
      response.headers.get('x-access-token') ||
      response.headers.get('x-auth-token') ||
      response.headers.get('x-token');
    return {
      ...data,
      tokenFromHeader: tokenFromHeader || tokenFromAlt || null,
    };
  });
}

export function sendVerificationOtpRequest(payload) {
  return fetch(buildUrl('/auth/send-verification-otp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
  }).then(async (response) => {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || 'Failed to send verification code.');
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

export function verifyVerificationOtpRequest(payload) {
  return fetch(buildUrl('/auth/verify-verification-otp'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
  }).then(async (response) => {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || 'Verification failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

export function loadSavedQBBankActivityRequest(clientId) {
  const params = new URLSearchParams();
  if (clientId) params.append("clientId", clientId);
  return request(`/qb-bank-activity/saved?${params}`);
}

export function getCimBankReconciliationRequest({
  clientId,
  sourceKey,
  datasetVersion,
  keyReportVersionId,
} = {}) {
  const params = new URLSearchParams();
  if (clientId) params.append('clientId', clientId);
  if (datasetVersion) params.append('datasetVersion', String(datasetVersion));
  if (keyReportVersionId) params.append('keyReportVersionId', String(keyReportVersionId));
  if (sourceKey) params.append('source', sourceKey);
  if (sourceKey === 'quickbooks') return request(`/qb-bank-activity/saved?${params}`);
  if (sourceKey === 'manual_upload') return request(`/manual-upload/bank-data?${params}`);
  if (sourceKey === 'quickbooks_manual') return request(`/manual-report-uploads/qms-bank-data?${params}`);
  return request(`/extract-bank-pdf-records?${params}`);
}

export function getCimTaxReconciliationRequest({ clientId, sourceKey, datasetVersion, keyReportVersionId, year } = {}) {
  const params = new URLSearchParams();
  if (clientId) params.append('clientId', clientId);
  if (datasetVersion) params.append('datasetVersion', String(datasetVersion));
  if (keyReportVersionId) params.append('keyReportVersionId', String(keyReportVersionId));
  if (year) params.append('start_date', `${year}-01-01`);
  return request(`${sourceKey === 'quickbooks' ? '/tax-data' : '/manual-report-uploads/tax-data'}?${params}`);
}

export function brokerSignupRequest(payload) {
  return fetch(buildUrl('/auth/broker/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
    cache: 'no-store',
    credentials: 'omit',
  }).then(async (response) => {
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || 'Request failed');
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

export function logoutRequest(options = {}) {
  return request('/auth/logout', { method: 'POST', ...options });
}

export function meRequest() {
  return request('/auth/me');
}

export function listCompaniesRequest() {
  return request('/companies').then(ensureArray);
}

export function getCompanyRequest(companyId) {
  return request(`/companies/${companyId}`).then(unwrapPayload);
}

export function createCompanyRequest(payload) {
  return request('/companies', { method: 'POST', body: payload }).then(unwrapPayload);
}

export function updateCompanyRequest(companyId, payload) {
  return request(`/companies/${companyId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function deleteCompanyRequest(companyId) {
  return request(`/companies/${companyId}`, { method: 'DELETE' }).then(unwrapPayload);
}

export function listUsersRequest() {
  return request('/users').then(ensureArray);
}

export function createUserRequest(payload) {
  return request('/users', { method: 'POST', body: payload }).then(unwrapPayload);
}

export function updateUserRequest(userId, payload) {
  return request(`/users/${userId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function deleteUserRequest(userId) {
  return request(`/users/${userId}`, { method: 'DELETE' });
}

export function findUserByEmailRequest(email) {
  return request(`/users/find-by-email?email=${encodeURIComponent(email)}`).then(unwrapPayload);
}

export function addUserToCompaniesRequest(userId, companyIds) {
  return request(`/users/${userId}/add-companies`, { method: 'POST', body: { company_ids: companyIds } }).then(unwrapPayload);
}

export function removeUserFromCompaniesRequest(userId, companyIds) {
  return request(`/users/${userId}/remove-companies`, { method: 'DELETE', body: { company_ids: companyIds } });
}

// Feature 1: Broker-team invite relationship (does NOT modify invited broker's company associations)
export function inviteBrokerToTeamRequest(invitedBrokerId) {
  return request('/users/broker-team/invite', { method: 'POST', body: { invited_broker_id: invitedBrokerId } });
}

export function removeBrokerFromTeamRequest(invitedBrokerId) {
  return request(`/users/broker-team/invite/${invitedBrokerId}`, { method: 'DELETE' });
}

export function listCompanyRequests(companyId) {
  return request(`/companies/${companyId}/requests`).then(ensureArray);
}

export function listMessageThreadsRequest() {
  return request("/messages/threads").then(ensureArray);
}

export function getCompanyMessagesRequest(companyId) {
  return request(`/companies/${companyId}/messages`);
}

export function createCompanyMessageRequest(companyId, payload) {
  return request(`/companies/${companyId}/messages`, { method: "POST", body: payload }).then(unwrapPayload);
}

export function listMyDirectContactsRequest() {
  return request("/my-direct-contacts");
}

export function listCompanyDirectMessageContactsRequest(companyId) {
  return request(`/companies/${companyId}/direct-messages/contacts`);
}

export function getCompanyDirectMessagesRequest(companyId, recipientId) {
  return request(`/companies/${companyId}/direct-messages/${recipientId}`);
}

export function createCompanyDirectMessageRequest(companyId, recipientId, payload) {
  return request(`/companies/${companyId}/direct-messages/${recipientId}`, {
    method: "POST",
    body: payload,
  }).then(unwrapPayload);
}

export function createCompanyRequestItem(companyId, payload) {
  return request(`/companies/${companyId}/requests`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function createCompanyBulkRequestItems(companyId, payload) {
  return request(`/companies/${companyId}/requests/bulk`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function listCompanyGroups(companyId) {
  return request(`/companies/${companyId}/groups`).then(ensureArray);
}

export function createCompanyGroup(companyId, payload) {
  return request(`/companies/${companyId}/groups`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function updateGroup(groupId, payload) {
  return request(`/groups/${groupId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function deleteGroup(groupId) {
  return request(`/groups/${groupId}`, { method: 'DELETE' });
}

export function addGroupMember(groupId, payload) {
  return request(`/groups/${groupId}/members`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function removeGroupMember(groupId, userId) {
  return request(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
}

export function listGroupMembers(groupId) {
  return request(`/groups/${groupId}/members`).then(ensureArray);
}

export function getRequestById(requestId) {
  return request(`/requests/${requestId}`).then(unwrapPayload);
}

export function updateRequest(requestId, payload) {
  return request(`/requests/${requestId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function approveRequest(requestId, assignedTo = null) {
  const body = assignedTo ? { assigned_to: assignedTo } : undefined;
  return request(`/requests/${requestId}/approve`, { method: 'POST', body }).then(unwrapPayload);
}

export function deleteRequest(requestId) {
  return request(`/requests/${requestId}`, { method: 'DELETE' });
}

export function updateRequestNarrative(requestId, payload) {
  return request(`/requests/${requestId}/narrative`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function getRequestNarrative(requestId) {
  // Returns { content, author_name, author_role, updated_at } or a plain string (backward compat).
  return request(`/requests/${requestId}/narrative/file`).then((res) => {
    if (!res) return { content: '', author_name: null, author_role: null, updated_at: null };
    if (typeof res === 'string') return { content: res, author_name: null, author_role: null, updated_at: null };
    return {
      content: res.content || '',
      author_name: res.author_name || null,
      author_role: res.author_role || null,
      updated_at: res.updated_at || null,
    };
  }).catch(() => ({ content: '', author_name: null, author_role: null, updated_at: null }));
}

export function listRequestDocuments(requestId) {
  return request(`/requests/${requestId}/documents`).then(ensureArray);
}

export function attachRequestDocument(requestId, payload) {
  return request(`/requests/${requestId}/documents`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function createRequestReminder(requestId, payload) {
  return request(`/requests/${requestId}/reminders`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function listCompanyReminders(companyId) {
  return request(`/companies/${companyId}/reminders`).then(ensureArray);
}

export function listCompanyActivity(companyId) {
  return request(`/companies/${companyId}/activity`).then(ensureArray);
}

export function listBrokerActivity(limit = 25) {
  return request(`/broker/activity?limit=${limit}`).then(ensureArray);
}

export function getWorkspacePageStateRequest(pageKey, options = {}) {
  return request(`/workspace-page-state/${encodeURIComponent(pageKey)}`, options);
}

export function saveWorkspacePageStateRequest(pageKey, state, options = {}) {
  return request(`/workspace-page-state/${encodeURIComponent(pageKey)}`, {
    ...options,
    method: 'PUT',
    body: { state },
  });
}

export function getCimQuestionnaireRequest(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/cim-questionnaire${query}`, options);
}

export function saveCimQuestionnaireRequest(state, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/cim-questionnaire${query}`, {
    ...options,
    method: 'PUT',
    body: { state },
  });
}

export async function uploadFile(file, options = {}) {
  if (!file) {
    throw new Error('Missing file for upload');
  }

  const token = options.token ?? getStoredToken();
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'X-File-Name': options.fileName || file.name || 'upload.bin',
    'X-Upload-Prefix': options.prefix || 'uploads',
    'Cache-Control': 'no-store',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(buildUrl('/uploads'), {
    method: 'POST',
    headers,
    body: file,
    cache: 'no-store',
    credentials: 'omit',
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || 'Upload failed');
  }

  const normalized = unwrapPayload(data);
  return {
    ...normalized,
    id: normalized?.id || null,
    fileUrl: normalized?.fileUrl || normalized?.file_url || null,
  };
}

export async function fetchProtectedFileBlob(fileUrl, options = {}) {
  if (!fileUrl) {
    throw new Error('Missing file URL');
  }

  const resolvedUrl = resolveProtectedFileUrl(fileUrl);
  const token = options.token ?? getStoredToken();
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const headers = {
    'Cache-Control': 'no-store',
    ...(options.headers || {}),
    ...(clientId ? { 'X-Client-Id': clientId } : {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(resolvedUrl, {
    method: 'GET',
    headers,
    cache: 'no-store',
    credentials: 'omit',
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Failed to load file: ${response.status}`);
  }

  return response.blob();
}

function buildEbitdaAdjustmentScopeParams(options = {}) {
  const params = new URLSearchParams();
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  if (clientId) params.set("clientId", clientId);

  const fields = [
    ["versionId", options.versionId],
    ["sourceKey", options.sourceKey],
    ["datasetVersionId", options.datasetVersionId],
    ["uploadBatchId", options.uploadBatchId],
  ];

  fields.forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    params.set(key, String(value));
  });

  return params.toString();
}

export function listEbitdaAdjustmentTypes(options = {}) {
  const query = buildEbitdaAdjustmentScopeParams(options);
  return request(`/ebitda-adjustment-types${query ? `?${query}` : ""}`, options).then(
    (payload) => payload?.types || [],
  );
}

export function listEbitdaAdjustments(options = {}) {
  const query = buildEbitdaAdjustmentScopeParams(options);
  return request(`/ebitda-adjustments${query ? `?${query}` : ""}`, options).then(
    (payload) => payload?.adjustments || [],
  );
}

export function saveEbitdaAdjustmentsBatch(payload, options = {}) {
  const query = buildEbitdaAdjustmentScopeParams(options);
  return request(`/ebitda-adjustments/batch${query ? `?${query}` : ""}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function deleteEbitdaAdjustment(adjustmentId, options = {}) {
  const query = buildEbitdaAdjustmentScopeParams(options);
  return request(`/ebitda-adjustments/${encodeURIComponent(adjustmentId)}${query ? `?${query}` : ""}`, {
    method: "DELETE",
    ...options,
  });
}

export function addEbitdaAdjustmentComment(adjustmentId, payload, options = {}) {
  const query = buildEbitdaAdjustmentScopeParams(options);
  return request(`/ebitda-adjustments/${encodeURIComponent(adjustmentId)}/comments${query ? `?${query}` : ""}`, {
    method: "POST",
    body: payload,
    ...options,
  }).then((res) => res?.comment || res);
}

export function generateEbitdaComments(payload, options = {}) {
  return request("/ebitda/generate-comments", {
    method: "POST",
    body: payload,
    ...options,
  }).then((res) => res?.comments || {});
}

export function listManualGlUploads(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/uploads${query}`, options).then((payload) => payload?.uploads || []);
}

export function createManualGlUpload(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/uploads${query}`, {
    method: "POST",
    body: payload,
    ...options,
  }).then((data) => data?.upload || data);
}

export function uploadManualReport(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/upload${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function continueManualReportProcessing(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/continue${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function uploadGl(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/upload-gl${query}`, {
    method: "POST",
    body: payload,
    ...options,
  }).then((data) => data?.upload || data);
}

export function generateManualGlReports(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/reports/generate${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function getManualGlColumns(uploadId, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/columns/${encodeURIComponent(uploadId)}${query}`, options);
}

export function saveManualGlMapping(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/save-mapping${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function saveGlMapping(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/save-mapping${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function processManualGl(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/process-gl${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function processGl(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/process-gl${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

export function getLatestManualGlReport(statementType, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/reports/${encodeURIComponent(statementType)}/latest${query}`, options);
}

export function getManualGlProfitLoss(options = {}) {
  const { params = {}, ...requestOptions } = options || {};
  const clientId = requestOptions.clientId ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();

  if (clientId) {
    search.set("clientId", clientId);
  }

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(`/reports/pl${query ? `?${query}` : ""}`, requestOptions);
}

export function getManualGlBalanceSheet(options = {}) {
  const { params = {}, ...requestOptions } = options || {};
  const clientId = requestOptions.clientId ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();

  if (clientId) {
    search.set("clientId", clientId);
  }

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(`/reports/balance-sheet${query ? `?${query}` : ""}`, requestOptions);
}

export function getManualGlCashflow(options = {}) {
  const { params = {}, ...requestOptions } = options || {};
  const clientId = requestOptions.clientId ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) { if (value.length === 0) return; search.set(key, value.join(",")); return; }
    search.set(key, String(value));
  });
  const query = search.toString();
  return request(`/reports/cashflow${query ? `?${query}` : ""}`, requestOptions);
}

export function getManualStagedCashflowMonthlyDetail(options = {}) {
  const { clientId: clientIdOption, params = {}, ...requestOptions } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) { if (value.length === 0) return; search.set(key, value.join(",")); return; }
    search.set(key, String(value));
  });
  const query = search.toString();
  return request(`/reports/cashflow/monthly-detail${query ? `?${query}` : ""}`, requestOptions);
}

export function stageMultiYearManualGl(payload, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/staging/multi-year${query}`, {
    method: "POST",
    body: payload,
    ...options,
  });
}

// === Snapshot Dataset Versioning APIs ===

export function listManualGlDatasetVersions(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/dataset-versions${query}`, options).then((res) => {
    // The API now returns { success: true, versions: [...] }
    const rawList = Array.isArray(res?.versions)
      ? res.versions
      : Array.isArray(res)
        ? res
        : [];

    const seen = new Set();
    const normalized = rawList
      .map((row) => {
        const parsedVersion = Number(
          row?.value ??
          row?.dataset_version ??
          row?.version_number ??
          row?.versionNumber ??
          row?.version_no ??
          0,
        );
        if (!Number.isInteger(parsedVersion) || parsedVersion <= 0) return null;
        if (seen.has(parsedVersion)) return null;
        seen.add(parsedVersion);

        return {
          id: String(row?.id || parsedVersion),
          value: parsedVersion,
          label: String(row?.label || `Version ${parsedVersion}`),
          dataset_version: parsedVersion,
          version_number: parsedVersion,
          versionNumber: parsedVersion,
          is_active: Boolean(row?.is_active ?? row?.isActive),
          isActive: Boolean(row?.is_active ?? row?.isActive),
          created_at: row?.created_at || row?.createdAt || null,
          createdAt: row?.created_at || row?.createdAt || null,
          status: row?.status || "FINALIZED",
          datasetHash: row?.dataset_hash || row?.content_hash || row?.datasetHash || null,
          batchId: row?.batch_id || row?.batchId || null,
          datasetVersionId: row?.dataset_version_id || row?.datasetVersionId || null,
          fiscalYears: Array.isArray(row?.fiscal_years)
            ? row.fiscal_years.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year > 0)
            : Array.isArray(row?.fiscalYears)
              ? row.fiscalYears.map((year) => Number(year)).filter((year) => Number.isInteger(year) && year > 0)
              : [],
          reportsReady: row?.reportsReady ?? row?.reports_ready ?? null,
        };
      })
      .filter(Boolean)
      .sort((left, right) => Number(right.value || 0) - Number(left.value || 0));

    return normalized;
  });
}

export function activateManualGlDatasetVersion(versionId, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/dataset-versions/${encodeURIComponent(versionId)}/activate${query}`, {
    method: "POST",
    ...options,
  });
}

export function rollbackManualGlDatasetVersion(versionId, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/dataset-versions/${encodeURIComponent(versionId)}/rollback${query}`, {
    method: "POST",
    ...options,
  });
}

// === Upload Jobs APIs ===

export function listManualGlUploadJobs(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/upload-jobs${query}`, options).then(res => res?.jobs || []);
}

export function getManualGlUploadJob(jobId, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/upload-jobs/${encodeURIComponent(jobId)}${query}`, options).then(res => res?.job || null);
}

export function getManualStageTransactions(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/manual-gl/staging/transactions${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualStageFilterOptions(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/manual-gl/staging/filter-options${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualGlBatches(options = {}) {
  const {
    clientId: clientIdOption,
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-gl/staging/batches${query}`, requestOptions);
}

export function getManualStagedProfitLossSummary(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(`/reports/profit-loss${query ? `?${query}` : ""}`, requestOptions);
}

export function getManualStagedProfitLossDetail(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/reports/profit-loss/detail${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualVendorAnalysis(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/reports/vendor-analysis${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualStagedProfitLossVendorDetail(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/reports/profit-loss/detail-vendor${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualStagedProfitLossMonthlyDetail(options = {}) {
  const { clientId: clientIdOption, params = {}, ...requestOptions } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) { if (value.length === 0) return; search.set(key, value.join(",")); return; }
    search.set(key, String(value));
  });
  const query = search.toString();
  return request(`/reports/profit-loss/monthly-detail${query ? `?${query}` : ""}`, requestOptions);
}

export function getManualStagedBalanceSheetMonthlyDetail(options = {}) {
  const { clientId: clientIdOption, params = {}, ...requestOptions } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) { if (value.length === 0) return; search.set(key, value.join(",")); return; }
    search.set(key, String(value));
  });
  const query = search.toString();
  return request(`/reports/balance-sheet/monthly-detail${query ? `?${query}` : ""}`, requestOptions);
}

export function validateManualStagedBalanceSheet(options = {}) {
  const {
    clientId: clientIdOption,
    params = {},
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const search = new URLSearchParams();
  if (clientId) search.set("clientId", clientId);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      search.set(key, value.join(","));
      return;
    }
    search.set(key, String(value));
  });

  const query = search.toString();
  return request(
    `/manual-gl/validation/balance-sheet${query ? `?${query}` : ""}`,
    requestOptions,
  );
}

export function getManualUploadSourceTree(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/source-tree${query}`, options).then(
    (res) => res?.tree ?? null,
  );
}

export function getManualFolderFiles(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (options.folderId) params.set("folderId", options.folderId);
  return request(`/manual-report-uploads/folder-files?${params}`, options).then(
    (res) => res?.files ?? [],
  );
}

export function syncManualUploadSource(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/sync-source${query}`, {
    method: "POST",
    ...options,
  });
}

export function getQMSUploadSourceTree(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/qms-source-tree${query}`, options).then(
    (res) => res?.tree ?? null,
  );
}

export function syncQMSUploadSource(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/sync-qms-source${query}`, {
    method: "POST",
    ...options,
  });
}

export function getQMSSyncProgress(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/sync-progress${query}`, options);
}

export function getManualUploadProgress(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-upload/sync-progress${query}`, options);
}

export function parseQMSDocuments({ clientId: clientIdOption, documents = [], clearFirst = false } = {}) {
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/qms-parse-documents${query}`, {
    method: "POST",
    body: { documents, clearFirst },
  });
}

export function syncQMSFolder({ clientId: clientIdOption, folderId, folderName } = {}) {
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-report-uploads/sync${query}`, {
    method: "POST",
    body: { folderId, folderName: folderName || "" },
  });
}

export function getLatestManualUploadedReport(statementType, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (options.rowId) params.set("rowId", options.rowId);
  if (options.keyReportVersionId) params.set("keyReportVersionId", options.keyReportVersionId);
  const query = params.toString() ? `?${params}` : "";
  return request(
    `/manual-report-uploads/reports/${encodeURIComponent(statementType)}/latest${query}`,
    options,
  );
}

export function getAllManualUploadedReports(statementType, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(
    `/manual-report-uploads/reports/${encodeURIComponent(statementType)}/all${query}`,
    options,
  );
}

export function getAllQMSUploadedReports(statementType, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(
    `/manual-report-uploads/qms-reports/${encodeURIComponent(statementType)}/all${query}`,
    options,
  );
}

export function getLatestQMSUploadedReport(statementType, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const params = new URLSearchParams();
  if (clientId) params.set("clientId", clientId);
  if (options.rowId) params.set("rowId", options.rowId);
  if (options.keyReportVersionId) params.set("keyReportVersionId", options.keyReportVersionId);
  const query = params.toString() ? `?${params}` : "";
  return request(
    `/manual-report-uploads/qms-reports/${encodeURIComponent(statementType)}/latest${query}`,
    options,
  );
}

/**
 * Returns the structured QMS (QuickBooks Manual) dashboard payload pre-computed on the server:
 *   { years, reports, allFiles, trends }
 */
export function getQMSDashboard(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const base = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "?";
  return request(`/manual-report-uploads/qms-dashboard${base}&source=quickbooks_manual`, options);
}

/**
 * Returns the structured Manual Upload (Excel/PDF) dashboard payload pre-computed on the server:
 *   { years, reports, allFiles, trends }
 */
export function getManualUploadDashboard(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const base = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "?";
  return request(`/manual-report-uploads/manual-upload-dashboard${base}&source=manual_upload`, options);
}

/**
 * GET /manual-upload/cashflow/periods
 * Returns all years for which a Cash Flow can be automatically generated
 * (i.e. BS(Y-1) + BS(Y) + P&L(Y) are all uploaded).
 */
export function getManualCashFlowPeriods(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/manual-upload/cashflow/periods${query}`, options);
}

/**
 * GET /manual-upload/cashflow?period=YYYY[&force=1]
 * Fetch (or generate) a Cash Flow statement for a specific year.
 * Pass force: true to bypass the cache and regenerate from uploaded files.
 */
export function getManualGeneratedCashFlow(period, options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const params = new URLSearchParams();
  params.set("period", String(period));
  if (clientId) params.set("clientId", clientId);
  if (options.force) params.set("force", "1");
  return request(`/manual-upload/cashflow?${params}`, options);
}

export function getReportSources(options = {}) {
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/report-sources${query}`, options);
}

export function setSelectedReportSource(sourceKey, options = {}) {
  const {
    clientId: clientIdOption,
    confirmSwitch = false,
    forceDisconnectQuickbooks = false,
    ...requestOptions
  } = options || {};
  const clientId = clientIdOption ?? resolveClientIdFromLocation();
  const query = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
  return request(`/report-sources/selected${query}`, {
    method: "PUT",
    body: {
      sourceKey,
      confirmSwitch: Boolean(confirmSwitch),
      forceDisconnectQuickbooks: Boolean(forceDisconnectQuickbooks),
    },
    ...requestOptions,
  });
}

export function listCompanyFolders(companyId) {
  return request(`/companies/${companyId}/folders`).then(ensureArray);
}

export function listFolderTree(companyId, options = {}) {
  const qs = options.includeArchived ? '?includeArchived=true' : '';
  return request(`/companies/${companyId}/folders/tree${qs}`).then(ensureArray);
}

export function ensureCompanyDefaultFolders(companyId) {
  return request(`/companies/${companyId}/folders/ensure-defaults`, { method: 'POST' });
}

export function createCompanyFolder(companyId, payload) {
  return request(`/companies/${companyId}/folders`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function updateFolder(folderId, payload) {
  return request(`/folders/${folderId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function moveFolder(folderId, payload) {
  return request(`/folders/${folderId}/move`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function deleteFolder(folderId) {
  return request(`/folders/${folderId}`, { method: 'DELETE' });
}

export function archiveFolder(folderId) {
  return request(`/folders/${folderId}/archive`, { method: 'POST' }).then(unwrapPayload);
}

export function unarchiveFolder(folderId) {
  return request(`/folders/${folderId}/unarchive`, { method: 'POST' }).then(unwrapPayload);
}

export function listFolderDocuments(folderId, options = {}) {
  const qs = options.includeArchived ? '?includeArchived=true' : '';
  return request(`/folders/${folderId}/documents${qs}`).then(ensureArray);
}

export function deleteDocument(documentId) {
  return request(`/documents/${documentId}`, { method: 'DELETE' });
}

export function archiveDocument(documentId) {
  return request(`/documents/${documentId}/archive`, { method: 'POST' }).then(unwrapPayload);
}

export function unarchiveDocument(documentId) {
  return request(`/documents/${documentId}/unarchive`, { method: 'POST' }).then(unwrapPayload);
}

export function recordDocumentActivity(documentId, activityType) {
  return request(`/documents/${documentId}/activity`, {
    method: 'POST',
    body: { activity_type: activityType },
  }).then(unwrapPayload);
}

export function listDocumentActivity(documentId) {
  return request(`/documents/${documentId}/activity`).then(ensureArray);
}

// ---- Key Reports -----------------------------------------------------------
// The X-Client-Id header is attached automatically from the workspace URL.

export function getKeyReportVersions() {
  return request('/key-reports/versions');
}

export function createKeyReportVersion(companyId, payload = {}) {
  return request('/key-reports/versions', {
    method: 'POST',
    body: { companyId, ...payload },
  });
}

export function getKeyReportVersion(versionId) {
  return request(`/key-reports/versions/${versionId}`);
}

export function updateKeyReportVersion(versionId, payload) {
  return request(`/key-reports/versions/${versionId}`, { method: 'PUT', body: payload });
}

export function duplicateKeyReportVersion(versionId, payload = {}) {
  return request(`/key-reports/versions/${versionId}/duplicate`, { method: 'POST', body: payload });
}

export function activateKeyReportVersion(versionId) {
  return request(`/key-reports/versions/${versionId}/activate`, { method: 'POST', body: {} });
}

export function deleteKeyReportVersion(versionId) {
  return request(`/key-reports/versions/${versionId}`, { method: 'DELETE' });
}

export function addKeyReportMapping(versionId, payload) {
  return request(`/key-reports/versions/${versionId}/mappings`, { method: 'POST', body: payload });
}

export function removeKeyReportMapping(mappingId) {
  return request(`/key-reports/mappings/${mappingId}`, { method: 'DELETE' });
}

export function syncKeyReportVersion(versionId) {
  return request(`/key-reports/versions/${versionId}/sync`, { method: 'POST', body: {} });
}

export async function getActiveKeyReportMappings() {
  const res = await getKeyReportVersions();
  const versions = res?.versions || [];
  const active = versions.find(v => v.isActive) || versions[0];
  if (!active?.id) return null;
  const detail = await getKeyReportVersion(active.id);
  return detail?.mappingsByCategory || null;
}

export function getKeyReportSyncLogs(versionId) {
  return request(`/key-reports/versions/${versionId}/sync-logs`);
}

/**
 * Fetch a financial report directly from Key Reports entry tables.
 *
 * reportType: 'profit-loss' | 'balance-sheet' | 'general-ledger' |
 *             'bank-statement' | 'tax-return'
 *
 * This is the ONLY correct report endpoint when keyReportVersionId is present.
 * NEVER call ManualGL or staging endpoints for Key Reports data.
 */
export function getKeyReportVersionReport(versionId, reportType, params = {}) {
  const search = new URLSearchParams();
  if (params.year != null && params.year !== "") search.set("year", String(params.year));
  // Date-range filter (spec #11–#13): controls which fiscal years/months render.
  if (params.startDate) search.set("startDate", String(params.startDate));
  if (params.endDate) search.set("endDate", String(params.endDate));
  // Granularity: "month" → monthly columns, otherwise annual fiscal-year columns.
  if (params.period) search.set("period", String(params.period));
  if (params.page != null) search.set("page", String(params.page));
  if (params.pageSize != null) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return request(`/key-reports/versions/${versionId}/reports/${reportType}${qs ? `?${qs}` : ""}`);
}

export function getKeyReportExtractedData(versionId, { dataType, year, page = 1, pageSize = 50, search } = {}) {
  const params = new URLSearchParams({ dataType });
  if (year != null) params.set('year', String(year));
  if (page > 1) params.set('page', String(page));
  if (pageSize !== 50) params.set('pageSize', String(pageSize));
  if (search) params.set('search', search);
  return request(`/key-reports/versions/${versionId}/extracted-data?${params}`);
}

export function getKeyReportFileReferences(documentIds = []) {
  const ids = (Array.isArray(documentIds) ? documentIds : [documentIds]).filter(Boolean);
  const qs = ids.length ? `?documentIds=${encodeURIComponent(ids.join(','))}` : '';
  return request(`/key-reports/file-references${qs}`);
}

export function getKeyReportPopupPreference() {
  return request('/key-reports/popup-preference');
}

export function setKeyReportPopupPreference(dismissed) {
  return request('/key-reports/popup-preference', { method: 'PUT', body: { dismissed } });
}

// ---- Chart of Accounts -----------------------------------------------------

export function getChartOfAccounts(versionId) {
  return request(`/key-reports/versions/${versionId}/chart-of-accounts`);
}

export function regenerateChartOfAccounts(versionId) {
  return request(`/key-reports/versions/${versionId}/chart-of-accounts/regenerate`, {
    method: 'POST',
    body: {},
  });
}

export function updateChartOfAccount(accountId, payload) {
  return request(`/key-reports/chart-of-accounts/${accountId}`, { method: 'PATCH', body: payload });
}

// Restore a single account to its original AI classification.
export function resetChartOfAccount(accountId) {
  return request(`/key-reports/chart-of-accounts/${accountId}/reset`, { method: 'POST', body: {} });
}

// Bulk-save an edited hierarchy for a version.
export function saveChartOfAccounts(versionId, nodes) {
  return request(`/key-reports/versions/${versionId}/chart-of-accounts/save`, {
    method: 'POST',
    body: { nodes },
  });
}

// Restore an entire version's hierarchy to the original AI classification.
export function resetChartOfAccounts(versionId) {
  return request(`/key-reports/versions/${versionId}/chart-of-accounts/reset`, { method: 'POST', body: {} });
}

// Classification + adjustment audit history.
export function getChartOfAccountsHistory(versionId) {
  return request(`/key-reports/versions/${versionId}/chart-of-accounts/history`);
}

// Standardized hierarchy taxonomy (reference data for UI filters).
export function getHierarchyLevels() {
  return request(`/key-reports/hierarchy-levels`);
}

// COA-mapped financial statements (monthly + yearly P&L and Balance Sheet).
export function getFinancialStatements(versionId, { year, currency } = {}) {
  const params = new URLSearchParams();
  if (year) params.set("year", year);
  if (currency) params.set("currency", currency);
  const qs = params.toString();
  return request(`/key-reports/versions/${versionId}/reports/financial-statements${qs ? `?${qs}` : ""}`);
}

export function listFolderAccess(folderId) {
  return request(`/folders/${folderId}/access`).then(ensureArray);
}

export function createFolderAccess(folderId, payload) {
  return request(`/folders/${folderId}/access`, { method: 'POST', body: payload }).then(unwrapPayload);
}

export function updateFolderAccess(accessId, payload) {
  return request(`/folder-access/${accessId}`, { method: 'PATCH', body: payload }).then(unwrapPayload);
}

export function deleteFolderAccess(accessId) {
  return request(`/folder-access/${accessId}`, { method: 'DELETE' });
}

export function createFolderDocument(folderId, payload) {
  return request(`/folders/${folderId}/documents`, { method: 'POST', body: payload }).then(unwrapPayload);
}

// ─── Message Groups (multi-role architecture) ────────────────────────────────

export function listMessageGroupsForCompany(companyId) {
  return request(`/companies/${companyId}/message-groups`).then(ensureArray);
}

export function listMyMessageGroups() {
  return request('/my-groups').then(ensureArray);
}

export function triggerAutoCreateMessageGroups(companyId) {
  return request(`/companies/${companyId}/message-groups/auto-create`, { method: 'POST' }).then(unwrapPayload);
}

export function addMessageGroupMember(groupId, userId) {
  return request(`/message-groups/${groupId}/members`, { method: 'POST', body: { user_id: userId } }).then(unwrapPayload);
}

export function removeMessageGroupMember(groupId, userId) {
  return request(`/message-groups/${groupId}/members/${userId}`, { method: 'DELETE' });
}

export function getGroupMembers(groupId) {
  return request(`/message-groups/${groupId}/members`).then(ensureArray);
}

// ─── Group messages (migration 042) ──────────────────────────────────────────

export function listGroupMessages(groupId, params = {}) {
  const qs = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return request(`/message-groups/${groupId}/messages${qs ? `?${qs}` : ''}`).then(ensureArray);
}

export function sendGroupMessage(groupId, body) {
  return request(`/message-groups/${groupId}/messages`, { method: 'POST', body: { body } }).then(unwrapPayload);
}

export function markGroupMessagesRead(groupId) {
  return request(`/message-groups/${groupId}/messages/mark-read`, { method: 'POST' }).then(unwrapPayload);
}

export function getGroupUnreadCount(groupId) {
  return request(`/message-groups/${groupId}/messages/unread-count`).then(unwrapPayload);
}

export function getTaxReconciliationOverrides({ clientId } = {}) {
  const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
  return request(`/manual-report-uploads/tax-reconciliation-overrides${qs}`);
}

export function saveTaxReconciliationOverrides({ clientId, overrides } = {}) {
  return request('/manual-report-uploads/tax-reconciliation-overrides', {
    method: 'PUT',
    body: { clientId, overrides },
  });
}
