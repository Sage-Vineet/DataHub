import {
  listFolderTree,
  uploadFile,
  createFolderDocument,
} from "./api";

function sanitizePart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\\/:"*?<>|]+/g, "")
    .replace(/\s+/g, " ");
}

function formatDateForFile(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown-date";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return raw.replace(/[^\d-]/g, "-");
}

export function buildReportFileName({
  reportKey,
  extension,
  accountingMethod,
  startDate,
  endDate,
  variant,
}) {
  const parts = [sanitizePart(reportKey)];

  if (variant) {
    parts.push(sanitizePart(variant));
  }
  if (accountingMethod) {
    parts.push(sanitizePart(accountingMethod));
  }
  if (startDate && endDate) {
    parts.push(formatDateForFile(startDate));
    parts.push("to");
    parts.push(formatDateForFile(endDate));
  }

  return `${parts.filter(Boolean).join(" ")}.${extension}`;
}

function findFolderByPath(nodes, pathSegments, depth = 0) {
  const targetName = sanitizePart(pathSegments[depth]);
  const match = (nodes || []).find(
    (node) => sanitizePart(node?.name) === targetName,
  );

  if (!match) return null;
  if (depth === pathSegments.length - 1) return match;
  return findFolderByPath(match.children || [], pathSegments, depth + 1);
}

export async function uploadReportToDataRoom({
  companyId,
  userId,
  blob,
  fileName,
  folderPath,
}) {
  if (!companyId) {
    throw new Error("Missing company id for DataRoom upload.");
  }
  if (!userId) {
    throw new Error("Missing user id for DataRoom upload.");
  }
  if (!blob || !fileName) {
    throw new Error("Missing file content for DataRoom upload.");
  }

  const tree = await listFolderTree(companyId);
  const folder = findFolderByPath(tree, folderPath);

  if (!folder?.id) {
    throw new Error(
      `Could not find DataRoom folder: ${folderPath.join(" / ")}`,
    );
  }

  const file = new File([blob], fileName, {
    type: blob.type || "application/octet-stream",
  });

  const uploaded = await uploadFile(file, {
    fileName,
    prefix: "documents",
  });

  const ext = fileName.includes(".")
    ? fileName.split(".").pop().toLowerCase()
    : "";

  return createFolderDocument(folder.id, {
    company_id: companyId,
    name: fileName,
    file_url: uploaded.fileUrl,
    upload_id: uploaded.id,
    size: String(blob.size || 0),
    ext,
    status: "under-review",
    uploaded_by: userId,
  });
}

export const REPORT_FOLDER_PATHS = {
  invoices: ["Datahub Reports Download", "Invoices"],
  balancesheet: [
    "Datahub Reports Download",
    "Reports",
    "Balance sheet",
  ],
  "profit-loss": [
    "Datahub Reports Download",
    "Reports",
    "Profit & loss",
  ],
  cashflow: [
    "Datahub Reports Download",
    "Reports",
    "Cashflow",
  ],
  bankreconciliation: [
    "Datahub Reports Download",
    "Bank Reconciliation",
  ],
  taxreconciliation: [
    "Datahub Reports Download",
    "Tax Reconciliation",
  ],
};
