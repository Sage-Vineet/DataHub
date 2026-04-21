const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const TOKEN_KEY = 'leo-auth-token';

function buildUrl(path) {
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
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
  const brokerMatch = hash.match(/\/broker\/client\/([^/?#]+)/) || pathname.match(/\/broker\/client\/([^/?#]+)/);
  
  if (brokerMatch) {
    const id = decodeURIComponent(brokerMatch[1]);
    // Safety: ensure it looks like a database ID (UUID) and not a static route
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) return null;
    return id;
  }

  return null;
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
}


async function request(path, options = {}) {
  const token = options.token ?? getStoredToken();
  const clientId = options.clientId ?? resolveClientIdFromLocation();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
    'Cache-Control': 'no-store',
    ...(clientId ? { 'X-Client-Id': clientId } : {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Access-Token'] = token;
    headers['X-Auth-Token'] = token;
    headers['X-Token'] = token;
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
    throw new Error(data?.error || 'Request failed');
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

export function logoutRequest() {
  return request('/auth/logout', { method: 'POST' });
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

export function listCompanyRequests(companyId) {
  return request(`/companies/${companyId}/requests`).then(ensureArray);
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

export function deleteRequest(requestId) {
  return request(`/requests/${requestId}`, { method: 'DELETE' });
}

export function updateRequestNarrative(requestId, payload) {
  return request(`/requests/${requestId}/narrative`, { method: 'PATCH', body: payload }).then(unwrapPayload);
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

  const token = options.token ?? getStoredToken();
  const headers = {
    'Cache-Control': 'no-store',
    ...(options.headers || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(fileUrl, {
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

export function listCompanyFolders(companyId) {
  return request(`/companies/${companyId}/folders`).then(ensureArray);
}

export function listFolderTree(companyId) {
  return request(`/companies/${companyId}/folders/tree`).then(ensureArray);
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

export function listFolderDocuments(folderId) {
  return request(`/folders/${folderId}/documents`).then(ensureArray);
}

export function deleteDocument(documentId) {
  return request(`/documents/${documentId}`, { method: 'DELETE' });
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
