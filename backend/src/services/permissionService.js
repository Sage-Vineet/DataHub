function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

function normalizeCompanyIds(user) {
  return Array.from(
    new Set(
      [
        ...(user?.company_ids || []),
        ...((user?.assigned_companies || []).map((company) => company.id)),
        user?.company_id,
      ].filter(Boolean).map(String),
    ),
  );
}

function canAccessCompany(user, companyId) {
  if (!user || !companyId) return false;
  if (isAdmin(user)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

function canAccessRequest(user, request) {
  if (!user || !request) return false;
  if (!canAccessCompany(user, request.company_id)) return false;
  if (isBroker(user)) return true;
  
  if (user?.effective_role === "client") {
    return request.approval_status === "approved" && request.visible !== false && request.visible !== 0;
  }
  
  return request.approval_status === "approved" || String(request.created_by) === String(user.id);
}

function filterRequestsForUser(user, requests) {
  if (isBroker(user)) {
    const companyIds = normalizeCompanyIds(user);
    if (isAdmin(user)) return requests;
    return requests.filter((request) => companyIds.includes(String(request.company_id)));
  }

  if (user?.effective_role === "client") {
    return requests.filter(
      (request) => request.approval_status === "approved" && request.visible !== false && request.visible !== 0,
    );
  }

  return requests.filter(
    (request) => request.approval_status === "approved" || String(request.created_by) === String(user?.id),
  );
}

module.exports = {
  isBroker,
  isAdmin,
  normalizeCompanyIds,
  canAccessCompany,
  canAccessRequest,
  filterRequestsForUser
};
