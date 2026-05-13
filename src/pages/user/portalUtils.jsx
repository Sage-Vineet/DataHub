export function initials(name = '') {
  return name
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

export function normalizeAssignedCompany(company) {
  if (!company) return null;

  const id = company.id ?? company.company_id ?? company.companyId;
  if (!id) return null;

  const name = company.name ?? company.company_name ?? company.companyName ?? 'Assigned Company';

  return {
    ...company,
    id,
    name,
    logo: company.logo || initials(name),
    industry: company.industry || 'Business Services',
    status: company.status || 'active',
    contact_name: company.contact_name || company.contactName || 'Primary Contact',
    contact_email: company.contact_email || company.contactEmail || company.email || 'Not available',
    contact_phone: company.contact_phone || company.contactPhone || company.phone || 'Not available',
    request_count: company.request_count || company.requestCount || 0,
    pending_request_count: company.pending_request_count || company.pendingCount || 0,
    completed_request_count: company.completed_request_count || company.completedCount || 0,
  };
}

export function getAssignedCompanies(user) {
  const fromAssignments = (user?.assignedCompanies || user?.assigned_companies || [])
    .map(normalizeAssignedCompany)
    .filter(Boolean);
  if (fromAssignments.length) return fromAssignments;

  const companyIds = user?.companyIds || user?.company_ids || [user?.company_id || user?.companyId].filter(Boolean);
  const fromIds = companyIds.map((id) => normalizeAssignedCompany({ id })).filter(Boolean);
  if (fromIds.length) return fromIds;

  const fallback = normalizeAssignedCompany({
    id: user?.company_id || user?.companyId || '',
    name: user?.company,
  });

  return fallback ? [fallback] : [];
}
