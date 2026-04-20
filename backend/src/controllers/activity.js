const db = require("../db");
const asyncHandler = require("../utils");

function rowsOf(result) {
  if (!result) return [];
  return Array.isArray(result) ? result : result.rows || [];
}

function normalizeCompanyIds(user) {
  return Array.from(
    new Set(
      [
        ...(user?.company_ids || []),
        ...((user?.assigned_companies || []).map((company) => company.id)),
        user?.company_id,
      ]
        .filter(Boolean)
        .map(String),
    ),
  );
}

function canAccessCompany(user, companyId) {
  if (!user || !companyId) return false;
  if (["broker", "admin"].includes(user.role)) return true;
  return normalizeCompanyIds(user).includes(String(companyId));
}

const listActivity = asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  if (!canAccessCompany(req.user, companyId)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const [
    requestRows,
    approvalRows,
    userRows,
    groupRows,
    groupMemberRows,
    documentRows,
    folderRows,
    reminderRows,
    legacyRows,
  ] = await Promise.all([
    db.query(
      `SELECT
         r.id,
         r.title,
         r.priority,
         r.response_type,
         r.created_at,
         creator.name AS actor_name
       FROM requests r
       LEFT JOIN users creator ON creator.id = r.created_by
       WHERE r.company_id = ?
       ORDER BY r.created_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         r.id,
         r.title,
         r.approved_at AS created_at,
         approver.name AS actor_name
       FROM requests r
       LEFT JOIN users approver ON approver.id = r.approved_by
       WHERE r.company_id = ?
         AND r.approval_status = 'approved'
         AND r.approved_at IS NOT NULL
       ORDER BY r.approved_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT DISTINCT
         u.id,
         u.name,
         u.email,
         u.role,
         u.created_at
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id
       WHERE u.company_id = ? OR uc.company_id = ?
       ORDER BY u.created_at DESC`,
      [companyId, companyId],
    ),
    db.query(
      `SELECT
         g.id,
         g.name,
         g.created_at
       FROM buyer_groups g
       WHERE g.company_id = ?
       ORDER BY g.created_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         gm.group_id,
         gm.user_id,
         gm.created_at,
         g.name AS group_name,
         u.name AS user_name
       FROM buyer_group_members gm
       JOIN buyer_groups g ON g.id = gm.group_id
       LEFT JOIN users u ON u.id = gm.user_id
       WHERE g.company_id = ?
       ORDER BY gm.created_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         d.id,
         d.name,
         d.size,
         d.ext,
         d.uploaded_at,
         f.name AS folder_name,
         uploader.name AS actor_name
       FROM documents d
       LEFT JOIN folders f ON f.id = d.folder_id
       LEFT JOIN users uploader ON uploader.id = d.uploaded_by
       WHERE d.company_id = ?
       ORDER BY d.uploaded_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         f.id,
         f.name,
         f.parent_id,
         f.created_at,
         creator.name AS actor_name
       FROM folders f
       LEFT JOIN users creator ON creator.id = f.created_by
       WHERE f.company_id = ?
       ORDER BY f.created_at DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         r.id,
         r.title,
         r.due_date,
         r.created_by,
         r.status,
         creator.name AS actor_name
       FROM reminders r
       LEFT JOIN users creator ON creator.id = r.created_by
       WHERE r.company_id = ?
       ORDER BY r.due_date DESC`,
      [companyId],
    ),
    db.query(
      `SELECT
         a.id,
         a.type,
         a.message,
         a.created_at,
         creator.name AS actor_name
       FROM activity_log a
       LEFT JOIN users creator ON creator.id = a.created_by
       WHERE a.company_id = ?
       ORDER BY a.created_at DESC`,
      [companyId],
    ),
  ]);

  const events = [
    ...rowsOf(requestRows).map((row) => ({
      id: `request-${row.id}`,
      type: "request_created",
      title: "Request created",
      message: `Request "${row.title}" was created`,
      detail: `${row.response_type} response · ${row.priority} priority`,
      actor_name: row.actor_name || null,
      created_at: row.created_at,
    })),
    ...rowsOf(approvalRows).map((row) => ({
      id: `request-approved-${row.id}`,
      type: "request_approved",
      title: "Request approved",
      message: `Request "${row.title}" was approved and sent to the client`,
      detail: null,
      actor_name: row.actor_name || null,
      created_at: row.created_at,
    })),
    ...rowsOf(userRows).map((row) => ({
      id: `user-${row.id}`,
      type: "user_added",
      title: "User added",
      message: `User "${row.name}" joined this workspace`,
      detail: `${row.email} · ${row.role}`,
      actor_name: null,
      created_at: row.created_at,
    })),
    ...rowsOf(groupRows).map((row) => ({
      id: `group-${row.id}`,
      type: "group_created",
      title: "Group created",
      message: `User group "${row.name}" was created`,
      detail: null,
      actor_name: null,
      created_at: row.created_at,
    })),
    ...rowsOf(groupMemberRows).map((row) => ({
      id: `group-member-${row.group_id}-${row.user_id}-${row.created_at}`,
      type: "group_member_added",
      title: "Group member added",
      message: `${row.user_name || "A user"} was added to "${row.group_name}"`,
      detail: null,
      actor_name: null,
      created_at: row.created_at,
    })),
    ...rowsOf(documentRows).map((row) => ({
      id: `document-${row.id}`,
      type: "document_uploaded",
      title: "Document uploaded",
      message: `Document "${row.name}" was uploaded`,
      detail: `${row.folder_name || "General"} · ${row.size} · .${row.ext}`,
      actor_name: row.actor_name || null,
      created_at: row.uploaded_at,
    })),
    ...rowsOf(folderRows).map((row) => ({
      id: `folder-${row.id}`,
      type: "folder_created",
      title: "Folder created",
      message: `Folder "${row.name}" was created`,
      detail: row.parent_id ? "Nested folder" : "Top-level folder",
      actor_name: row.actor_name || null,
      created_at: row.created_at,
    })),
    ...rowsOf(reminderRows).map((row) => ({
      id: `reminder-${row.id}`,
      type: "reminder_created",
      title: "Reminder created",
      message: `Reminder "${row.title}" was created`,
      detail: `Due ${String(row.due_date || "").slice(0, 10)} · ${row.status}`,
      actor_name: row.actor_name || null,
      created_at: row.due_date,
    })),
    ...rowsOf(legacyRows).map((row) => ({
      id: `legacy-${row.id}`,
      type: row.type || "activity",
      title: row.type || "Activity",
      message: row.message,
      detail: null,
      actor_name: row.actor_name || null,
      created_at: row.created_at,
    })),
  ]
    .filter((event) => event.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json(events);
});

module.exports = { listActivity };
