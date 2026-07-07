function isBroker(user) {
  return ["broker", "admin"].includes(String(user?.role || "").toLowerCase());
}

function isAdmin(user) {
  return String(user?.role || "").toLowerCase() === "admin";
}

function normalizeCompanyIds(user) {
  if (Array.isArray(user?.direct_company_ids)) {
    return Array.from(
      new Set(
        [
          ...(user.direct_company_ids || []),
          user?.company_id,
        ].filter(Boolean).map(String),
      ),
    );
  }

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
  // Direct match on users.company_id — works even when company_ids array is stale/empty
  if (user.company_id && String(user.company_id) === String(companyId)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

// Returns true when a client-portal user should only see requests assigned to them.
// company_owner sees everything; team_member and accountant see only their requests.
function isClientTeamRestricted(user) {
  const sub = user?.sub_role || "";
  return sub === "client_team_member" || sub === "client_accountant";
}

function canAccessRequest(user, request) {
  if (!user || !request) return false;
  if (!canAccessCompany(user, request.company_id)) return false;
  if (isBroker(user)) return true;

  if (user?.effective_role === "client") {
    if (request.approval_status !== "approved" || request.visible === false || request.visible === 0) return false;
    if (!isClientTeamRestricted(user)) return true;
    return !request.assigned_to || String(request.assigned_to) === String(user.id);
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
    const restricted = isClientTeamRestricted(user);
    return requests.filter((request) => {
      if (request.approval_status !== "approved" || request.visible === false || request.visible === 0) return false;
      if (!restricted) return true;
      return !request.assigned_to || String(request.assigned_to) === String(user.id);
    });
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
