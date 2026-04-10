export function normalizeAccountingMethod(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cash") return "Cash";
  if (normalized === "accrual") return "Accrual";
  return "Accrual";
}

export function sanitizeDateRange(startDate, endDate) {
  if (!startDate && !endDate) {
    return { startDate: "", endDate: "" };
  }

  if (!startDate) {
    return { startDate: endDate || "", endDate: endDate || "" };
  }

  if (!endDate) {
    return { startDate, endDate: startDate };
  }

  if (startDate <= endDate) {
    return { startDate, endDate };
  }

  return { startDate: endDate, endDate: startDate };
}
