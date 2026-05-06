function isBroker(user) {
  return ["broker", "admin"].includes(user?.role);
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
  if (isBroker(user)) return true;
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
  if (isBroker(user)) return requests;

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
  normalizeCompanyIds,
  canAccessCompany,
  canAccessRequest,
  filterRequestsForUser
};
