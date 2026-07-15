const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { isBroker } = require("../services/permissionService");
const userPreferenceService = require("../services/userPreferenceService");

const router = express.Router();
const PREF_KEY = "cim-template-style-profiles";
const MAX_PROFILES = 40;
const MAX_IMAGE_DATA_URL_LENGTH = 6_500_000;

router.use(requireAuth);

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value, limit = 120) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeHex(value, fallback = "#333333") {
  const match = String(value || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toUpperCase()}` : fallback;
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeImage(value) {
  if (!value || typeof value !== "object") return null;
  const dataUrl = String(value.dataUrl || "");
  if (!/^data:image\/(png|jpe?g|svg\+xml|gif|webp);/i.test(dataUrl)) return null;
  if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) return null;
  return {
    dataUrl,
    name: normalizeText(value.name, 120) || "Brand image",
    mimeType: normalizeText(value.mimeType, 80),
  };
}

function sanitizePalette(value) {
  const palette = Array.isArray(value) ? value : [];
  const normalized = palette.map((color) => normalizeHex(color, "")).filter(Boolean).slice(0, 8);
  return normalized.length ? normalized : ["#8BC53D", "#476E2C", "#A5A5A5", "#6D6E71", "#243F18"];
}

// Per-textbox local formatting set via the style editor's "click a text box on
// the preview, then tweak just its color/size" flow — keyed by slide number
// then element id. Mirrors src/lib/cimTemplateStyleProfiles.js normalization.
function sanitizeElementOverrides(input) {
  const result = {};
  if (!input || typeof input !== "object") return result;
  Object.entries(input).forEach(([slideKey, elementMap]) => {
    const slideNumber = Number(slideKey);
    if (!Number.isFinite(slideNumber) || slideNumber <= 0 || !elementMap || typeof elementMap !== "object") return;
    const normalizedElements = {};
    Object.entries(elementMap).forEach(([elementId, override]) => {
      if (!elementId || !override || typeof override !== "object") return;
      const normalizedOverride = {};
      const color = normalizeHex(override.color, "");
      if (color) normalizedOverride.color = color;
      const fontSize = Number(override.fontSize);
      if (Number.isFinite(fontSize) && fontSize > 0) normalizedOverride.fontSize = clamp(fontSize, 4, 200, fontSize);
      if (Object.keys(normalizedOverride).length) normalizedElements[String(elementId)] = normalizedOverride;
    });
    if (Object.keys(normalizedElements).length) result[String(slideNumber)] = normalizedElements;
  });
  return result;
}

function sanitizeProfile(profile = {}) {
  const isDefault = profile.isDefault || profile.id === "default-cim-template";
  const colors = profile.colors || {};
  const typography = profile.typography || {};
  const roles = typography.roles || {};
  const sanitizeRole = (role = {}) => ({
    fontFamily: normalizeText(role.fontFamily, 60) || "Calibri",
    sizeScale: clamp(role.sizeScale, 0.72, 1.45, 1),
    sizeDelta: clamp(role.sizeDelta, -8, 16, 0),
    weight: clamp(role.weight, 300, 900, 400),
    bold: Boolean(role.bold),
    italic: Boolean(role.italic),
    underline: Boolean(role.underline),
    letterSpacing: clamp(role.letterSpacing, -0.5, 3, 0),
    lineSpacing: clamp(role.lineSpacing, 0.85, 1.8, 1.08),
    paragraphSpacing: clamp(role.paragraphSpacing, 0, 28, 0),
    alignment: ["inherit", "left", "center", "right"].includes(role.alignment) ? role.alignment : "inherit",
    capitalization: ["none", "uppercase", "title"].includes(role.capitalization) ? role.capitalization : "none",
    wrap: role.wrap !== false,
  });

  return {
    id: isDefault ? "default-cim-template" : normalizeText(profile.id, 100) || `cim-style-${Date.now()}`,
    name: isDefault ? "Default CIM Template" : normalizeText(profile.name, 80) || "Brand Style",
    version: 1,
    locked: Boolean(isDefault || profile.locked),
    isDefault: Boolean(isDefault),
    colors: Object.fromEntries(Object.entries({
      primary: "#476E2C",
      secondary: "#8BC53D",
      accent: "#A5A5A5",
      background: "#FFFFFF",
      title: "#050505",
      subtitle: "#476E2C",
      body: "#333333",
      muted: "#6D6E71",
      tableHeader: "#476E2C",
      tableHeaderText: "#FFFFFF",
      tableRow: "#FFFFFF",
      tableAltRow: "#EFEFF1",
      tableBorder: "#E5E7EB",
      divider: "#8BC53D",
      icon: "#476E2C",
      footer: "#6D6E71",
      hyperlink: "#0563C1",
      highlight: "#EEF6E0",
    }).map(([key, fallback]) => [key, normalizeHex(colors[key], fallback)])),
    typography: {
      roles: Object.fromEntries(["title", "heading", "subheading", "body", "caption", "footer", "table"].map((key) => [
        key,
        sanitizeRole(roles[key]),
      ])),
      bulletStyle: ["standard", "dash", "none"].includes(typography.bulletStyle) ? typography.bulletStyle : "standard",
      numberingStyle: ["decimal", "roman", "alpha"].includes(typography.numberingStyle) ? typography.numberingStyle : "decimal",
      indentation: clamp(typography.indentation, 0, 48, 0),
    },
    background: {
      mode: ["template", "solid", "gradient", "image"].includes(profile.background?.mode) ? profile.background.mode : "template",
      color: normalizeHex(profile.background?.color, "#FFFFFF"),
      gradientFrom: normalizeHex(profile.background?.gradientFrom, "#FFFFFF"),
      gradientTo: normalizeHex(profile.background?.gradientTo, "#F7F8FA"),
      gradientAngle: clamp(profile.background?.gradientAngle, 0, 359, 0),
      image: normalizeImage(profile.background?.image),
      imageOpacity: clamp(profile.background?.imageOpacity, 0.08, 1, 1),
      applyTo: ["all", "cover", "section"].includes(profile.background?.applyTo) ? profile.background.applyTo : "all",
    },
    tables: {
      headerColor: normalizeHex(profile.tables?.headerColor, "#476E2C"),
      headerTextColor: normalizeHex(profile.tables?.headerTextColor, "#FFFFFF"),
      rowColor: normalizeHex(profile.tables?.rowColor, "#FFFFFF"),
      altRowColor: normalizeHex(profile.tables?.altRowColor, "#EFEFF1"),
      borderColor: normalizeHex(profile.tables?.borderColor, "#E5E7EB"),
      borderWidth: clamp(profile.tables?.borderWidth, 0, 4, 0.7),
      cellPadding: clamp(profile.tables?.cellPadding, 0, 24, 8),
      alternateRows: profile.tables?.alternateRows !== false,
    },
    charts: {
      palette: sanitizePalette(profile.charts?.palette),
      backgroundColor: normalizeHex(profile.charts?.backgroundColor, "#FFFFFF"),
      gridColor: normalizeHex(profile.charts?.gridColor, "#E5E7EB"),
      labelColor: normalizeHex(profile.charts?.labelColor, "#6D6E71"),
      titleColor: normalizeHex(profile.charts?.titleColor, "#476E2C"),
      legendPosition: ["right", "bottom", "none"].includes(profile.charts?.legendPosition) ? profile.charts.legendPosition : "right",
      axisFontFamily: normalizeText(profile.charts?.axisFontFamily, 60) || "Calibri",
    },
    images: {
      cornerRadius: clamp(profile.images?.cornerRadius, 0, 36, 0),
      borderColor: normalizeHex(profile.images?.borderColor, "#FFFFFF"),
      borderWidth: clamp(profile.images?.borderWidth, 0, 8, 0),
      shadow: Boolean(profile.images?.shadow),
      opacity: clamp(profile.images?.opacity, 0.2, 1, 1),
    },
    footer: {
      pageNumbers: profile.footer?.pageNumbers !== false,
      confidentialityLabel: normalizeText(profile.footer?.confidentialityLabel, 120),
      labelPosition: ["bottom-left", "bottom-center", "bottom-right"].includes(profile.footer?.labelPosition) ? profile.footer.labelPosition : "bottom-left",
      color: normalizeHex(profile.footer?.color, "#6D6E71"),
    },
    watermark: {
      visible: Boolean(profile.watermark?.visible),
      image: normalizeImage(profile.watermark?.image),
      opacity: clamp(profile.watermark?.opacity, 0.04, 0.6, 0.12),
      position: ["center", "top-right", "bottom-right"].includes(profile.watermark?.position) ? profile.watermark.position : "center",
      width: clamp(profile.watermark?.width, 120, 760, 360),
    },
    layout: {
      marginScale: clamp(profile.layout?.marginScale, 0.86, 1.2, 1),
      sectionSpacingScale: clamp(profile.layout?.sectionSpacingScale, 0.86, 1.24, 1),
      alignObjects: Boolean(profile.layout?.alignObjects),
    },
    transition: ["none", "fade", "push-left", "wipe-right"].includes(profile.transition) ? profile.transition : "none",
    elementOverrides: sanitizeElementOverrides(profile.elementOverrides),
    audit: Array.isArray(profile.audit) ? profile.audit.slice(-30) : [],
    updatedAt: profile.updatedAt || null,
  };
}

function sanitizeState(input = {}, user) {
  const profilesById = new Map();
  const profiles = Array.isArray(input.profiles) ? input.profiles : [];
  profiles.slice(0, MAX_PROFILES).forEach((profile) => {
    const sanitized = sanitizeProfile(profile);
    profilesById.set(sanitized.id, sanitized);
  });
  if (!profilesById.has("default-cim-template")) {
    profilesById.set("default-cim-template", sanitizeProfile({ id: "default-cim-template", isDefault: true }));
  }
  const activeProfileId = profilesById.has(input.activeProfileId) ? input.activeProfileId : "default-cim-template";
  return {
    version: 1,
    activeProfileId,
    profiles: Array.from(profilesById.values()),
    updatedAt: nowIso(),
    updatedBy: {
      id: user?.id || null,
      name: user?.name || user?.email || "User",
      email: user?.email || "",
    },
  };
}

router.get("/cim-style-profiles", async (req, res) => {
  if (!isBroker(req.user)) return res.status(403).json({ error: "Only brokers can manage CIM style profiles." });
  try {
    const value = await userPreferenceService.getPreference(req.user.id, PREF_KEY);
    return res.json({ state: sanitizeState(value || {}, req.user) });
  } catch (error) {
    console.error("[CIM Style Profiles] load failed", error);
    return res.status(500).json({ error: "Failed to load CIM style profiles." });
  }
});

router.put("/cim-style-profiles", async (req, res) => {
  if (!isBroker(req.user)) return res.status(403).json({ error: "Only brokers can manage CIM style profiles." });
  try {
    const state = sanitizeState(req.body?.state || {}, req.user);
    const saved = await userPreferenceService.setPreference(req.user.id, PREF_KEY, state);
    return res.json({ state: sanitizeState(saved || state, req.user) });
  } catch (error) {
    console.error("[CIM Style Profiles] save failed", error);
    return res.status(500).json({ error: "Failed to save CIM style profiles." });
  }
});

module.exports = router;
