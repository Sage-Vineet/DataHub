export function cn(...values) {
  return values.flat(Infinity).filter(Boolean).join(" ");
}

export function formatCurrency(amount) {
  const numeric =
    typeof amount === "string"
      ? Number(amount.replace(/,/g, "").replace(/[^\d().-]/g, "")) || 0
      : Number(amount || 0);

  const normalized =
    typeof amount === "string" && amount.includes("(") && amount.includes(")")
      ? -Math.abs(numeric)
      : numeric;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(normalized);
}

export function formatDate(dateStr) {
  return new Date(dateStr || Date.now()).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
