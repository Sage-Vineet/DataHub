export function normalizeAccountingMethod(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cash") return "Cash";
  if (normalized === "accrual") return "Accrual";
  return "Accrual";
}

export function sanitizeDateRange(startDate, endDate) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const todayStr = `${year}-${month}-${day}`;

  let s = startDate || "";
  let e = endDate || "";

  // Clamp endDate to today
  if (e > todayStr) {
    e = todayStr;
  }

  if (!s && !e) {
    return { startDate: "", endDate: "" };
  }

  if (!s) {
    return { startDate: e, endDate: e };
  }

  if (!e) {
    return { startDate: s, endDate: s };
  }

  if (s <= e) {
    return { startDate: s, endDate: e };
  }

  return { startDate: e, endDate: s };
}

