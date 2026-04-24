import { companies as mockCompanies } from '../../data/mockData';

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

  const mockCompany = mockCompanies.find((entry) => String(entry.id) === String(id));
  const name = company.name ?? company.company_name ?? company.companyName ?? mockCompany?.name ?? 'Assigned Company';

  return {
    ...mockCompany,
    ...company,
    id,
    name,
    logo: company.logo || mockCompany?.logo || initials(name),
    industry: company.industry || mockCompany?.industry || 'Business Services',
    status: company.status || mockCompany?.status || 'active',
    contact_name: company.contact_name || company.contactName || mockCompany?.contact_name || 'Primary Contact',
    contact_email: company.contact_email || company.contactEmail || company.email || mockCompany?.contact_email || 'Not available',
    contact_phone: company.contact_phone || company.contactPhone || company.phone || mockCompany?.contact_phone || 'Not available',
    request_count: company.request_count || company.requestCount || mockCompany?.request_count || 0,
    pending_request_count: company.pending_request_count || company.pendingCount || mockCompany?.pending_request_count || 0,
    completed_request_count: company.completed_request_count || company.completedCount || mockCompany?.completed_request_count || 0,
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
