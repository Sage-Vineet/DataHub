// ─── Companies / Clients ────────────────────────────────────────────────────
export const companies = [
  { id: 'co1', name: 'Infosys Ltd.', contact: 'Ananya Mehta', email: 'client@infosys.com', phone: '+91 98765 43210', industry: 'IT Services', status: 'active', since: '2024-01-15', logo: 'IN' },
  { id: 'co2', name: 'TCS Global', contact: 'Vikram Patel', email: 'vikram@tcs.com', phone: '+91 97654 32109', industry: 'IT Services', status: 'active', since: '2024-03-20', logo: 'TC' },
  { id: 'co3', name: 'Reliance Corp', contact: 'Sunita Joshi', email: 'sunita@reliance.com', phone: '+91 96543 21098', industry: 'Conglomerate', status: 'pending', since: '2025-01-05', logo: 'RC' },
  { id: 'co4', name: 'Wipro Technologies', contact: 'Arun Kumar', email: 'arun@wipro.com', phone: '+91 95432 10987', industry: 'IT Services', status: 'inactive', since: '2023-11-10', logo: 'WP' },
];

// ─── Document Requests ───────────────────────────────────────────────────────
export const requests = [
  // ── Finance ──────────────────────────────────────────────────────────────
  { id: 'FIN-001', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Trial Balance + FS Mapping', subLabel: 'Monthly trial balances', category: 'Finance', responseType: 'Upload', priority: 'critical', status: 'completed', visible: true, assignedTo: 'Finance Team', createdAt: '2026-03-06', dueDate: '2026-04-03', updatedAt: '2026-03-27', description: 'Upload the trial balance for the specified period and any related financial statement mapping documents.', narrativeResponse: '', documents: ['doc1', 'doc2'], notes: '' },
  { id: 'FIN-002', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Revenue Recognition Memo + Unbilled AR', subLabel: 'Revenue recognition', category: 'Finance', responseType: 'Both', priority: 'critical', status: 'awaiting-review', visible: true, assignedTo: 'Finance Team', createdAt: '2026-03-06', dueDate: '2026-04-03', updatedAt: '2026-03-25', description: 'Provide a detailed memo describing revenue recognition policies and list of unbilled AR balances.', narrativeResponse: 'Our revenue recognition follows ASC 606 guidelines. Unbilled AR as of Q3 is attached.', documents: ['doc3'], notes: '' },
  { id: 'FIN-003', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Budget + Forecast (Annual, Monthly)', subLabel: 'FY budget & forecast', category: 'Finance', responseType: 'Both', priority: 'critical', status: 'in-progress', visible: true, assignedTo: 'Finance Team', createdAt: '2026-03-06', dueDate: '2026-04-03', updatedAt: '2026-03-20', description: 'Upload full-year budget and monthly forecast models. Include assumptions worksheet.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'FIN-004', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Related Party Transactions Summary', subLabel: 'Related party transactions', category: 'Finance', responseType: 'Both', priority: 'critical', status: 'not-started', visible: true, assignedTo: 'Finance Team', createdAt: '2026-03-06', dueDate: '2026-04-03', updatedAt: '2026-03-06', description: 'Summarize all related party transactions for the period. Include nature, amount, and terms.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'FIN-005', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Adjusted EBITDA Bridge + GL Mapping', subLabel: 'Management adjustments to EBITDA', category: 'Finance', responseType: 'Both', priority: 'critical', status: 'submitted', visible: true, assignedTo: 'Controller', createdAt: '2026-03-06', dueDate: '2026-04-03', updatedAt: '2026-03-25', description: 'Provide bridge from reported EBITDA to adjusted EBITDA with GL mapping for each add-back.', narrativeResponse: 'EBITDA bridge attached. One-time items include restructuring charge and legal settlement.', documents: ['doc4'], notes: '' },

  // ── M&A ──────────────────────────────────────────────────────────────────
  { id: 'MNA-001', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Board Resolutions & Shareholder Agreements', subLabel: 'Corporate governance docs', category: 'M&A', responseType: 'Upload', priority: 'critical', status: 'completed', visible: true, assignedTo: 'Legal Team', createdAt: '2026-03-07', dueDate: '2026-04-05', updatedAt: '2026-03-22', description: 'Upload all board resolutions and shareholder agreements related to significant transactions.', narrativeResponse: '', documents: ['doc5'], notes: '' },
  { id: 'MNA-002', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Cap Table + Option Pool Schedule', subLabel: 'Equity structure', category: 'M&A', responseType: 'Upload', priority: 'critical', status: 'submitted', visible: true, assignedTo: 'CFO Office', createdAt: '2026-03-07', dueDate: '2026-04-05', updatedAt: '2026-03-26', description: 'Provide fully diluted cap table including ESOP pool, warrants, and convertible notes.', narrativeResponse: '', documents: ['doc6'], notes: '' },
  { id: 'MNA-003', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'LOI / Term Sheet (if applicable)', subLabel: 'Deal terms', category: 'M&A', responseType: 'Both', priority: 'high', status: 'not-started', visible: false, assignedTo: 'CFO Office', createdAt: '2026-03-07', dueDate: '2026-04-05', updatedAt: '2026-03-07', description: 'Upload any signed LOI or term sheet related to the current transaction.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'MNA-004', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Management Presentation / CIM', subLabel: 'Investor materials', category: 'M&A', responseType: 'Upload', priority: 'high', status: 'in-progress', visible: true, assignedTo: 'Strategy Team', createdAt: '2026-03-07', dueDate: '2026-04-05', updatedAt: '2026-03-24', description: 'Upload latest management presentation or confidential information memorandum.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'MNA-005', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Prior M&A Activity + Integration Plans', subLabel: 'Historical acquisitions', category: 'M&A', responseType: 'Both', priority: 'medium', status: 'awaiting-review', visible: true, assignedTo: 'Strategy Team', createdAt: '2026-03-07', dueDate: '2026-04-05', updatedAt: '2026-03-25', description: 'Detail any prior acquisitions, mergers, or divestitures. Include integration status.', narrativeResponse: 'We completed two acquisitions in FY24. Integration is ~80% complete.', documents: [], notes: '' },

  // ── Legal ─────────────────────────────────────────────────────────────────
  { id: 'LEG-001', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Litigation + Arbitration Log (Current Matters)', subLabel: 'Active legal proceedings', category: 'Legal', responseType: 'Both', priority: 'critical', status: 'completed', visible: true, assignedTo: 'Legal Counsel', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-20', description: 'Provide complete list of active litigation, arbitration, and regulatory proceedings with exposure estimates.', narrativeResponse: 'Three active matters disclosed. Details in attached log.', documents: ['doc7'], notes: '' },
  { id: 'LEG-002', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Material Contracts (Customer / Supplier)', subLabel: 'Key contracts', category: 'Legal', responseType: 'Upload', priority: 'critical', status: 'in-progress', visible: true, assignedTo: 'Legal Counsel', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-23', description: 'Upload top 10 customer contracts and top 5 supplier contracts. Redact confidential pricing if needed.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'LEG-003', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'IP Ownership + License Agreements', subLabel: 'Intellectual property', category: 'Legal', responseType: 'Both', priority: 'high', status: 'not-started', visible: true, assignedTo: 'IP Team', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-08', description: 'Confirm ownership of all IP. Upload all third-party license agreements and open-source usage policy.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'LEG-004', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Employment Agreements (Key Persons)', subLabel: 'Leadership contracts', category: 'Legal', responseType: 'Upload', priority: 'high', status: 'submitted', visible: true, assignedTo: 'HR / Legal', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-26', description: 'Upload employment / service agreements for C-suite and key management personnel.', narrativeResponse: '', documents: ['doc8'], notes: '' },
  { id: 'LEG-005', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Regulatory Filings + Compliance Certificates', subLabel: 'Statutory compliance', category: 'Legal', responseType: 'Upload', priority: 'medium', status: 'awaiting-review', visible: true, assignedTo: 'Compliance Team', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-25', description: 'Upload latest annual filing, GST returns, and any sector-specific compliance certificates.', narrativeResponse: '', documents: ['doc9'], notes: '' },

  // ── HR & People ───────────────────────────────────────────────────────────
  { id: 'HR-001', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'KYC Verification Bundle', subLabel: 'Identity & address proof', category: 'HR', responseType: 'Upload', priority: 'critical', status: 'not-started', visible: true, assignedTo: 'HR Team', createdAt: '2026-03-01', dueDate: '2026-03-20', updatedAt: '2026-03-01', description: 'PAN card, Aadhaar, and address proof for all key personnel listed in KYC scope.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'HR-002', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Org Chart + Headcount by Function', subLabel: 'Organisation structure', category: 'HR', responseType: 'Both', priority: 'high', status: 'in-progress', visible: true, assignedTo: 'HR Team', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-22', description: 'Provide current org chart with reporting lines. Include headcount split by function and location.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'HR-003', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Total Compensation + Benefits Summary', subLabel: 'Payroll & benefits', category: 'HR', responseType: 'Both', priority: 'high', status: 'submitted', visible: true, assignedTo: 'HR Team', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-24', description: 'Summarise total comp by band, bonus structure, equity plan, and employee benefits.', narrativeResponse: 'Total comp overview attached. Bonus pool is 12% of salary for FY25.', documents: ['doc10'], notes: '' },

  // ── Tax ───────────────────────────────────────────────────────────────────
  { id: 'TAX-001', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'GST Registration Certificate', subLabel: 'GST compliance', category: 'Tax', responseType: 'Upload', priority: 'high', status: 'not-started', visible: true, assignedTo: 'Tax Team', createdAt: '2026-03-10', dueDate: '2026-04-01', updatedAt: '2026-03-10', description: 'Valid GST registration certificate and latest GSTR-9 annual return.', narrativeResponse: '', documents: [], notes: '' },
  { id: 'TAX-002', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Tax Residency Certificate', subLabel: 'DTAA benefit', category: 'Tax', responseType: 'Upload', priority: 'low', status: 'completed', visible: true, assignedTo: 'Tax Team', createdAt: '2026-01-25', dueDate: '2026-02-20', updatedAt: '2026-02-18', description: 'TRC for invoking DTAA benefit. Must be current-year certificate.', narrativeResponse: '', documents: ['doc11'], notes: '' },
  { id: 'TAX-003', companyId: 'co1', companyName: 'Infosys Ltd.', name: 'Transfer Pricing Documentation', subLabel: 'Inter-company pricing', category: 'Tax', responseType: 'Both', priority: 'medium', status: 'in-progress', visible: true, assignedTo: 'Tax Team', createdAt: '2026-03-08', dueDate: '2026-04-07', updatedAt: '2026-03-21', description: 'Master file, local file and CbCR filing for current year. Include TP study for key transactions.', narrativeResponse: '', documents: [], notes: '' },
];

// ─── Documents ───────────────────────────────────────────────────────────────
export const documents = [
  { id: 'doc1',  requestId: 'FIN-001', name: 'Trial_Balance_Q3_2024.xlsx', uploadedBy: 'Finance Team', uploadedAt: '2026-03-25', size: '1.2 MB', status: 'verified', visible: true },
  { id: 'doc2',  requestId: 'FIN-001', name: 'FS_Mapping_2024.pdf', uploadedBy: 'Controller', uploadedAt: '2026-03-25', size: '0.8 MB', status: 'verified', visible: true },
  { id: 'doc3',  requestId: 'FIN-002', name: 'Revenue_Recognition_Memo.pdf', uploadedBy: 'Finance Team', uploadedAt: '2026-03-24', size: '1.5 MB', status: 'under-review', visible: true },
  { id: 'doc4',  requestId: 'FIN-005', name: 'EBITDA_Bridge_FY25.xlsx', uploadedBy: 'Controller', uploadedAt: '2026-03-25', size: '2.1 MB', status: 'verified', visible: true },
  { id: 'doc5',  requestId: 'MNA-001', name: 'Board_Resolutions_2025.pdf', uploadedBy: 'Legal Team', uploadedAt: '2026-03-22', size: '3.4 MB', status: 'verified', visible: true },
  { id: 'doc6',  requestId: 'MNA-002', name: 'CapTable_FullyDiluted.xlsx', uploadedBy: 'CFO Office', uploadedAt: '2026-03-26', size: '0.6 MB', status: 'under-review', visible: true },
  { id: 'doc7',  requestId: 'LEG-001', name: 'Litigation_Log_Mar2026.pdf', uploadedBy: 'Legal Counsel', uploadedAt: '2026-03-20', size: '0.9 MB', status: 'verified', visible: true },
  { id: 'doc8',  requestId: 'LEG-004', name: 'Employment_Agreements_CSuite.pdf', uploadedBy: 'HR / Legal', uploadedAt: '2026-03-26', size: '4.2 MB', status: 'under-review', visible: true },
  { id: 'doc9',  requestId: 'LEG-005', name: 'Compliance_Certificates_FY25.zip', uploadedBy: 'Compliance Team', uploadedAt: '2026-03-25', size: '5.1 MB', status: 'under-review', visible: true },
  { id: 'doc10', requestId: 'HR-003',  name: 'Total_Comp_Summary_FY25.xlsx', uploadedBy: 'HR Team', uploadedAt: '2026-03-24', size: '0.7 MB', status: 'under-review', visible: true },
  { id: 'doc11', requestId: 'TAX-002', name: 'Tax_Residency_Certificate.pdf', uploadedBy: 'Tax Team', uploadedAt: '2026-02-18', size: '0.4 MB', status: 'verified', visible: true },
];

// ─── Reminders ───────────────────────────────────────────────────────────────
export const reminders = [
  { id: 'rem1', requestId: 'HR-001', companyId: 'co1', companyName: 'Infosys Ltd.', title: 'KYC Bundle Due Soon', message: 'KYC Verification Bundle for Infosys is due on 20 Mar 2026. Please follow up.', dueDate: '2026-03-20', priority: 'high', status: 'active', createdAt: '2026-03-10' },
  { id: 'rem2', requestId: 'FIN-003', companyId: 'co1', companyName: 'Infosys Ltd.', title: 'Budget Forecast In Progress', message: 'Annual budget forecast still in progress. Expected by 3 Apr.', dueDate: '2026-04-03', priority: 'medium', status: 'active', createdAt: '2026-03-20' },
  { id: 'rem3', requestId: 'TAX-001', companyId: 'co1', companyName: 'Infosys Ltd.', title: 'GST Certificate Pending', message: 'GST Registration Certificate still pending. Remind client by 1 Apr 2026.', dueDate: '2026-04-01', priority: 'medium', status: 'active', createdAt: '2026-03-12' },
  { id: 'rem4', requestId: 'req006', companyId: 'co3', companyName: 'Reliance Corp', title: 'Director KYC Overdue', message: 'Director KYC documents not yet submitted by Reliance Corp.', dueDate: '2026-04-10', priority: 'low', status: 'active', createdAt: '2026-03-16' },
  { id: 'rem5', requestId: 'FIN-001', companyId: 'co1', companyName: 'Infosys Ltd.', title: 'Trial Balance Verified', message: 'Trial Balance documents verified and completed.', dueDate: '2026-03-10', priority: 'low', status: 'dismissed', createdAt: '2026-02-18' },
];

// ─── Request Categories ───────────────────────────────────────────────────────
export const requestCategories = [
  { key: 'Finance',  label: 'Finance',       color: '#00648F', bg: '#A7DCF7', icon: 'TrendingUp' },
  { key: 'M&A',      label: 'M&A',           color: '#742982', bg: '#DAAAE4', icon: 'Briefcase' },
  { key: 'Legal',    label: 'Legal',         color: '#476E2C', bg: '#C9E4A4', icon: 'Scale' },
  { key: 'HR',       label: 'HR & People',   color: '#b45e08', bg: '#FAC086', icon: 'Users' },
  { key: 'Tax',      label: 'Tax',           color: '#8BC53D', bg: '#C9E4A4', icon: 'Receipt' },
];

// ─── Document Type Options ───────────────────────────────────────────────────
export const docTypes = ['KYC', 'Legal', 'Financial', 'Banking', 'Tax', 'Insurance', 'Compliance', 'Other'];
export const priorityOptions = ['critical', 'high', 'medium', 'low'];
export const statusOptions = ['not-started', 'in-progress', 'submitted', 'awaiting-review', 'completed', 'rejected'];

// ─── Folder Structure ─────────────────────────────────────────────────────────
export const folders = [
  { id: 'f1', name: 'KYC Documents', icon: 'UserCheck', count: 0, color: '#742982' },
  { id: 'f2', name: 'Legal Documents', icon: 'FileText', count: 3, color: '#476E2C' },
  { id: 'f3', name: 'Financial Records', icon: 'TrendingUp', count: 1, color: '#F68C1F' },
  { id: 'f4', name: 'Banking Documents', icon: 'CreditCard', count: 2, color: '#00648F' },
  { id: 'f5', name: 'Tax Documents', icon: 'Receipt', count: 1, color: '#8BC53D' },
  { id: 'f6', name: 'Compliance', icon: 'ShieldCheck', count: 0, color: '#b45e08' },
];

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = [
  { id: 'u1',  name: 'Ananya Mehta',    company: 'Infosys Ltd.',       email: 'ananya@infosys.com',   phone: '+91 98765 43210', role: 'buyer',  status: 'active',   joinedAt: '2024-01-15', avatar: 'AM' },
  { id: 'u2',  name: 'Vikram Patel',    company: 'TCS Global',         email: 'vikram@tcs.com',       phone: '+91 97654 32109', role: 'seller', status: 'active',   joinedAt: '2024-03-20', avatar: 'VP' },
  { id: 'u3',  name: 'Sunita Joshi',    company: 'Reliance Corp',      email: 'sunita@reliance.com',  phone: '+91 96543 21098', role: 'buyer',  status: 'pending',  joinedAt: '2025-01-05', avatar: 'SJ' },
  { id: 'u4',  name: 'Arun Kumar',      company: 'Wipro Technologies', email: 'arun@wipro.com',       phone: '+91 95432 10987', role: 'seller', status: 'inactive', joinedAt: '2023-11-10', avatar: 'AK' },
  { id: 'u5',  name: 'Priya Sharma',    company: 'Infosys Ltd.',       email: 'priya@infosys.com',    phone: '+91 94321 09876', role: 'seller', status: 'active',   joinedAt: '2024-06-22', avatar: 'PS' },
  { id: 'u6',  name: 'Rahul Desai',     company: 'TCS Global',         email: 'rahul@tcs.com',        phone: '+91 93210 98765', role: 'buyer',  status: 'active',   joinedAt: '2024-08-15', avatar: 'RD' },
  { id: 'u7',  name: 'Meena Nair',      company: 'Reliance Corp',      email: 'meena@reliance.com',   phone: '+91 92109 87654', role: 'seller', status: 'active',   joinedAt: '2024-09-01', avatar: 'MN' },
  { id: 'u8',  name: 'Deepak Singh',    company: 'Wipro Technologies', email: 'deepak@wipro.com',     phone: '+91 91098 76543', role: 'buyer',  status: 'pending',  joinedAt: '2025-02-10', avatar: 'DS' },
  { id: 'u9',  name: 'Kavita Rao',      company: 'Infosys Ltd.',       email: 'kavita@infosys.com',   phone: '+91 90987 65432', role: 'buyer',  status: 'active',   joinedAt: '2024-11-30', avatar: 'KR' },
  { id: 'u10', name: 'Sanjay Verma',    company: 'TCS Global',         email: 'sanjay@tcs.com',       phone: '+91 89876 54321', role: 'seller', status: 'inactive', joinedAt: '2023-12-05', avatar: 'SV' },
  { id: 'u11', name: 'Fatima Khan',     company: 'Reliance Corp',      email: 'fatima@reliance.com',  phone: '+91 88765 43210', role: 'buyer',  status: 'active',   joinedAt: '2025-03-01', avatar: 'FK' },
  { id: 'u12', name: 'Arjun Pillai',    company: 'Wipro Technologies', email: 'arjun@wipro.com',      phone: '+91 87654 32109', role: 'seller', status: 'active',   joinedAt: '2024-07-18', avatar: 'AP' },
  { id: 'u13', name: 'Nisha Gupta',     company: 'Infosys Ltd.',       email: 'nisha@infosys.com',    phone: '+91 86543 21098', role: 'buyer',  status: 'pending',  joinedAt: '2025-03-10', avatar: 'NG' },
  { id: 'u14', name: 'Rakesh Tiwari',   company: 'TCS Global',         email: 'rakesh@tcs.com',       phone: '+91 85432 10987', role: 'seller', status: 'active',   joinedAt: '2024-05-07', avatar: 'RT' },
  { id: 'u15', name: 'Divya Menon',     company: 'Reliance Corp',      email: 'divya@reliance.com',   phone: '+91 84321 09876', role: 'seller', status: 'inactive', joinedAt: '2023-09-25', avatar: 'DM' },
];

// ─── Activity Feed ────────────────────────────────────────────────────────────
export const activities = [
  { id: 'a1', type: 'upload',   message: 'Infosys uploaded Trial Balance Q3 2024',          time: '2 hours ago',  icon: 'Upload' },
  { id: 'a2', type: 'request',  message: 'New request sent to Infosys: GST Certificate',    time: '5 hours ago',  icon: 'Send' },
  { id: 'a3', type: 'approved', message: 'FIN-001 Trial Balance verified & completed',       time: 'Yesterday',    icon: 'CheckCircle' },
  { id: 'a4', type: 'reminder', message: 'Reminder: KYC bundle due in 7 days',              time: 'Yesterday',    icon: 'Bell' },
  { id: 'a5', type: 'upload',   message: 'Infosys uploaded EBITDA Bridge FY25',             time: '2 days ago',   icon: 'Upload' },
];
