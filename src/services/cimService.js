import { request, getStoredToken } from "../lib/api";

const API_BASE = (import.meta.env.VITE_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

// CIM record
export const getCimByCompanyRequest = (companyId) =>
  request(`/cim/company/${companyId}`);

export const updateCimRequest = (id, sectionData, sectionKey) =>
  request(`/cim/${id}`, {
    method: "PATCH",
    body: { section_data: sectionData, section_key: sectionKey },
  });

export const updateCimStatusRequest = (id, status) =>
  request(`/cim/${id}/status`, { method: "PATCH", body: { status } });

export const getCimRevisionHistoryRequest = (id) =>
  request(`/cim/${id}/history`);

// Questionnaires (broker)
export const listQuestionnairesRequest = (cimId) =>
  request(`/cim/${cimId}/questionnaires`);

export const createQuestionnaireRequest = (cimId, data) =>
  request(`/cim/${cimId}/questionnaires`, { method: "POST", body: data });

export const updateQuestionnaireRequest = (questionnaireId, data) =>
  request(`/cim/questionnaires/${questionnaireId}`, { method: "PATCH", body: data });

export const sendQuestionnaireRequest = (questionnaireId) =>
  request(`/cim/questionnaires/${questionnaireId}/send`, { method: "POST" });

export const deleteQuestionnaireRequest = (questionnaireId) =>
  request(`/cim/questionnaires/${questionnaireId}`, { method: "DELETE" });

export const getQuestionnaireRequest = (questionnaireId) =>
  request(`/cim/questionnaires/${questionnaireId}`);

// Questions
export const addQuestionsRequest = (questionnaireId, questions) =>
  request(`/cim/questionnaires/${questionnaireId}/questions`, {
    method: "POST",
    body: { questions },
  });

export const deleteQuestionRequest = (questionId) =>
  request(`/cim/questions/${questionId}`, { method: "DELETE" });

// Responses (client portal)
export const saveResponseRequest = (questionId, data) =>
  request(`/cim/questions/${questionId}/responses`, { method: "POST", body: data });

export const submitQuestionnaireResponseRequest = (questionnaireId) =>
  request(`/cim/questionnaires/${questionnaireId}/submit`, { method: "POST" });

export const getClientQuestionnairesRequest = (companyId) =>
  request(`/cim/company/${companyId}/client-questionnaires`);

// Review comments
export const getCimCommentsRequest = (cimId) =>
  request(`/cim/${cimId}/comments`);

export const addCimCommentRequest = (cimId, { section_key, field_key, comment_text }) =>
  request(`/cim/${cimId}/comments`, { method: "POST", body: { section_key, field_key: field_key || null, comment_text } });

export const updateCimCommentRequest = (commentId, data) =>
  request(`/cim/comments/${commentId}`, { method: "PATCH", body: data });

// Generation — raw fetch so we can receive a binary blob
export async function generateCimRequest(cimId) {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE}/cim/${cimId}/generate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" },
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "Generation failed");
  }
  const blob = await res.blob();
  const contentDisposition = res.headers.get("Content-Disposition") || "";
  const match = contentDisposition.match(/filename="([^"]+)"/);
  const fileName = match ? match[1] : `CIM_${Date.now()}.pptx`;
  return { blob, fileName };
}
