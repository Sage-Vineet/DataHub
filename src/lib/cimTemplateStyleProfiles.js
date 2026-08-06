export const CIM_STYLE_PROFILE_VERSION = 1;
export const DEFAULT_CIM_STYLE_PROFILE_ID = "default-cim-template";

export const SUPPORTED_CIM_STYLE_FONTS = Object.freeze([
  "Calibri",
  "Calibri Light",
  "Aptos",
  "Arial",
  "Helvetica",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Garamond",
  "Times New Roman",
]);

export const CIM_STYLE_COLOR_FIELDS = Object.freeze([
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
  { key: "background", label: "Background" },
  { key: "title", label: "Title" },
  { key: "subtitle", label: "Subtitle" },
  { key: "body", label: "Body" },
  { key: "muted", label: "Muted" },
  { key: "tableHeader", label: "Table header" },
  { key: "tableHeaderText", label: "Table header text" },
  { key: "tableRow", label: "Table row" },
  { key: "tableAltRow", label: "Alternate row" },
  { key: "tableBorder", label: "Table border" },
  { key: "divider", label: "Divider" },
  { key: "icon", label: "Icon" },
  { key: "footer", label: "Footer" },
  { key: "hyperlink", label: "Hyperlink" },
  { key: "highlight", label: "Highlight" },
]);

export const CIM_STYLE_FONT_ROLES = Object.freeze([
  { key: "title", label: "Titles" },
  { key: "heading", label: "Headings" },
  { key: "subheading", label: "Subheadings" },
  { key: "body", label: "Body" },
  { key: "caption", label: "Captions" },
  { key: "footer", label: "Footers" },
  { key: "table", label: "Tables" },
]);

export const CIM_STYLE_TRANSITION_OPTIONS = Object.freeze([
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "push-left", label: "Push left" },
  { value: "wipe-right", label: "Wipe right" },
]);

export const DEFAULT_CIM_STYLE_COLORS = Object.freeze({
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
});

export const DEFAULT_CIM_STYLE_PROFILE = Object.freeze({
  id: DEFAULT_CIM_STYLE_PROFILE_ID,
  name: "Default CIM Template",
  version: CIM_STYLE_PROFILE_VERSION,
  locked: true,
  isDefault: true,
  colors: DEFAULT_CIM_STYLE_COLORS,
  typography: {
    roles: {
      title: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 700, bold: true, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.08, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      heading: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 700, bold: true, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.08, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      subheading: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 600, bold: false, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.08, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      body: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 400, bold: false, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.08, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      caption: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 400, bold: false, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.05, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      footer: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 400, bold: false, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.05, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
      table: { fontFamily: "Calibri", sizeScale: 1, sizeDelta: 0, weight: 400, bold: false, italic: false, underline: false, letterSpacing: 0, lineSpacing: 1.04, paragraphSpacing: 0, alignment: "inherit", capitalization: "none", wrap: true },
    },
    bulletStyle: "standard",
    numberingStyle: "decimal",
    indentation: 0,
  },
  background: {
    mode: "template",
    color: "#FFFFFF",
    gradientFrom: "#FFFFFF",
    gradientTo: "#F7F8FA",
    gradientAngle: 0,
    image: null,
    imageOpacity: 1,
    applyTo: "all",
  },
  tables: {
    headerColor: "#476E2C",
    headerTextColor: "#FFFFFF",
    rowColor: "#FFFFFF",
    altRowColor: "#EFEFF1",
    borderColor: "#E5E7EB",
    borderWidth: 0.7,
    cellPadding: 8,
    alternateRows: true,
  },
  charts: {
    palette: ["#8BC53D", "#476E2C", "#A5A5A5", "#6D6E71", "#243F18"],
    backgroundColor: "#FFFFFF",
    gridColor: "#E5E7EB",
    labelColor: "#6D6E71",
    titleColor: "#476E2C",
    legendPosition: "right",
    axisFontFamily: "Calibri",
  },
  images: {
    cornerRadius: 0,
    borderColor: "#FFFFFF",
    borderWidth: 0,
    shadow: false,
    opacity: 1,
  },
  footer: {
    pageNumbers: true,
    confidentialityLabel: "",
    labelPosition: "bottom-left",
    color: "#6D6E71",
  },
  watermark: {
    visible: false,
    image: null,
    opacity: 0.12,
    position: "center",
    width: 360,
  },
  layout: {
    marginScale: 1,
    sectionSpacingScale: 1,
    alignObjects: false,
  },
  transition: "none",
  // Per-textbox local formatting, keyed by slide number then element id — mirrors
  // PowerPoint's "select this text and change just it" direct formatting, layered
  // on top of the role-based typography rather than replacing it.
  elementOverrides: {},
  audit: [],
  updatedAt: null,
});

const COLOR_ROLE_BY_HEX = Object.freeze({
  "476E2C": "primary",
  "8BC53D": "secondary",
  A5A5A5: "accent",
  "6D6E71": "muted",
  "243F18": "primary",
  EEF6E0: "highlight",
  EFEFF1: "tableAltRow",
  F7F8FA: "background",
  FFFFFF: "background",
  E5E7EB: "tableBorder",
  "050505": "title",
  "333333": "body",
});

const SECTION_DIVIDER_SLIDES = new Set([3, 4, 7, 11, 14, 16, 19, 22, 31, 34, 36, 38]);
const COVER_AND_CLOSING_SLIDES = new Set([1, 38]);
const TEMPLATE_BRAND_GREEN_KEYS = new Set(["476E2C", "8BC53D", "243F18"]);
// The cover/closing slides fill the untouched half of their canvas with this
// hardcoded slide-level background (not a styleable element), so it never
// picked up a custom theme's primary color unless the user separately turned
// on the generic "Apply background" override.
const TEMPLATE_COVER_BACKGROUND_KEY = "2A3F1A";

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeCimHexColor(value, fallback = "#333333") {
  const raw = String(value || "").trim();
  const hex = raw.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1].toUpperCase()}`;
  return fallback;
}

export function normalizeCimStyleFont(value, fallback = "Calibri") {
  const clean = normalizeText(value);
  return SUPPORTED_CIM_STYLE_FONTS.includes(clean) ? clean : fallback;
}

function normalizeImageDataUrl(value) {
  if (!value) return null;
  const dataUrl = typeof value === "string" ? value : value.dataUrl;
  const name = typeof value === "object" ? value.name : "";
  const mimeType = typeof value === "object" ? value.mimeType : "";
  if (!/^data:image\/(png|jpe?g|svg\+xml|gif|webp);/i.test(String(dataUrl || ""))) return null;
  if (String(dataUrl).length > 6_500_000) return null;
  return {
    dataUrl,
    name: normalizeText(name).slice(0, 120) || "Brand image",
    mimeType: mimeType || String(dataUrl).slice(5, String(dataUrl).indexOf(";")),
  };
}

function normalizeColorMap(colors = {}) {
  return Object.fromEntries(
    CIM_STYLE_COLOR_FIELDS.map(({ key }) => [
      key,
      normalizeCimHexColor(colors[key], DEFAULT_CIM_STYLE_COLORS[key]),
    ]),
  );
}

function normalizeTypographyRole(role = {}, fallback = {}) {
  return {
    fontFamily: normalizeCimStyleFont(role.fontFamily, fallback.fontFamily || "Calibri"),
    sizeScale: clamp(role.sizeScale, 0.72, 1.45, fallback.sizeScale || 1),
    sizeDelta: clamp(role.sizeDelta, -8, 16, fallback.sizeDelta || 0),
    weight: clamp(role.weight, 300, 900, fallback.weight || 400),
    bold: Boolean(role.bold),
    italic: Boolean(role.italic),
    underline: Boolean(role.underline),
    letterSpacing: clamp(role.letterSpacing, -0.5, 3, fallback.letterSpacing || 0),
    lineSpacing: clamp(role.lineSpacing, 0.85, 1.8, fallback.lineSpacing || 1.08),
    paragraphSpacing: clamp(role.paragraphSpacing, 0, 28, fallback.paragraphSpacing || 0),
    alignment: ["inherit", "left", "center", "right"].includes(role.alignment) ? role.alignment : fallback.alignment || "inherit",
    capitalization: ["none", "uppercase", "title"].includes(role.capitalization) ? role.capitalization : fallback.capitalization || "none",
    wrap: role.wrap !== false,
  };
}

function normalizeTypography(typography = {}) {
  const defaults = DEFAULT_CIM_STYLE_PROFILE.typography.roles;
  return {
    roles: Object.fromEntries(
      CIM_STYLE_FONT_ROLES.map(({ key }) => [
        key,
        normalizeTypographyRole(typography.roles?.[key], defaults[key]),
      ]),
    ),
    bulletStyle: ["standard", "dash", "none"].includes(typography.bulletStyle)
      ? typography.bulletStyle
      : DEFAULT_CIM_STYLE_PROFILE.typography.bulletStyle,
    numberingStyle: ["decimal", "roman", "alpha"].includes(typography.numberingStyle)
      ? typography.numberingStyle
      : DEFAULT_CIM_STYLE_PROFILE.typography.numberingStyle,
    indentation: clamp(typography.indentation, 0, 48, DEFAULT_CIM_STYLE_PROFILE.typography.indentation),
  };
}

function normalizePalette(palette, fallback = DEFAULT_CIM_STYLE_PROFILE.charts.palette) {
  const values = Array.isArray(palette) ? palette : [];
  const normalized = values
    .map((color) => normalizeCimHexColor(color, ""))
    .filter(Boolean)
    .slice(0, 8);
  return normalized.length ? normalized : fallback;
}

function normalizeElementOverride(override = {}) {
  const normalized = {};
  const color = normalizeCimHexColor(override?.color, "");
  if (color) normalized.color = color;
  const fontSize = Number(override?.fontSize);
  if (Number.isFinite(fontSize) && fontSize > 0) normalized.fontSize = clamp(fontSize, 4, 200, fontSize);
  return normalized;
}

function normalizeElementOverrides(input) {
  const result = {};
  if (!input || typeof input !== "object") return result;
  Object.entries(input).forEach(([slideKey, elementMap]) => {
    const slideNumber = Number(slideKey);
    if (!Number.isFinite(slideNumber) || slideNumber <= 0 || !elementMap || typeof elementMap !== "object") return;
    const normalizedElements = {};
    Object.entries(elementMap).forEach(([elementId, override]) => {
      if (!elementId) return;
      const normalizedOverride = normalizeElementOverride(override);
      if (Object.keys(normalizedOverride).length) normalizedElements[String(elementId)] = normalizedOverride;
    });
    if (Object.keys(normalizedElements).length) result[String(slideNumber)] = normalizedElements;
  });
  return result;
}

export function normalizeCimStyleProfile(input = {}) {
  if (!input || typeof input !== "object") return DEFAULT_CIM_STYLE_PROFILE;
  const isDefault = input.isDefault || input.id === DEFAULT_CIM_STYLE_PROFILE_ID;
  const colors = normalizeColorMap(input.colors);
  const typography = normalizeTypography(input.typography);

  return {
    id: isDefault
      ? DEFAULT_CIM_STYLE_PROFILE_ID
      : normalizeText(input.id).slice(0, 80) || `cim-style-${Date.now()}`,
    name: isDefault
      ? DEFAULT_CIM_STYLE_PROFILE.name
      : normalizeText(input.name).slice(0, 80) || "Brand Style",
    version: CIM_STYLE_PROFILE_VERSION,
    locked: Boolean(isDefault || input.locked),
    isDefault: Boolean(isDefault),
    colors,
    typography,
    background: {
      mode: ["template", "solid", "gradient", "image"].includes(input.background?.mode)
        ? input.background.mode
        : DEFAULT_CIM_STYLE_PROFILE.background.mode,
      color: normalizeCimHexColor(input.background?.color, colors.background),
      gradientFrom: normalizeCimHexColor(input.background?.gradientFrom, colors.background),
      gradientTo: normalizeCimHexColor(input.background?.gradientTo, "#F7F8FA"),
      gradientAngle: clamp(input.background?.gradientAngle, 0, 359, 0),
      image: normalizeImageDataUrl(input.background?.image),
      imageOpacity: clamp(input.background?.imageOpacity, 0.08, 1, 1),
      applyTo: ["all", "cover", "section"].includes(input.background?.applyTo) ? input.background.applyTo : "all",
    },
    tables: {
      headerColor: normalizeCimHexColor(input.tables?.headerColor, colors.tableHeader),
      headerTextColor: normalizeCimHexColor(input.tables?.headerTextColor, colors.tableHeaderText),
      rowColor: normalizeCimHexColor(input.tables?.rowColor, colors.tableRow),
      altRowColor: normalizeCimHexColor(input.tables?.altRowColor, colors.tableAltRow),
      borderColor: normalizeCimHexColor(input.tables?.borderColor, colors.tableBorder),
      borderWidth: clamp(input.tables?.borderWidth, 0, 4, DEFAULT_CIM_STYLE_PROFILE.tables.borderWidth),
      cellPadding: clamp(input.tables?.cellPadding, 0, 24, DEFAULT_CIM_STYLE_PROFILE.tables.cellPadding),
      alternateRows: input.tables?.alternateRows !== false,
    },
    charts: {
      palette: normalizePalette(input.charts?.palette),
      backgroundColor: normalizeCimHexColor(input.charts?.backgroundColor, "#FFFFFF"),
      gridColor: normalizeCimHexColor(input.charts?.gridColor, colors.tableBorder),
      labelColor: normalizeCimHexColor(input.charts?.labelColor, colors.muted),
      titleColor: normalizeCimHexColor(input.charts?.titleColor, colors.primary),
      legendPosition: ["right", "bottom", "none"].includes(input.charts?.legendPosition)
        ? input.charts.legendPosition
        : "right",
      axisFontFamily: normalizeCimStyleFont(input.charts?.axisFontFamily, typography.roles.table.fontFamily),
    },
    images: {
      cornerRadius: clamp(input.images?.cornerRadius, 0, 36, 0),
      borderColor: normalizeCimHexColor(input.images?.borderColor, "#FFFFFF"),
      borderWidth: clamp(input.images?.borderWidth, 0, 8, 0),
      shadow: Boolean(input.images?.shadow),
      opacity: clamp(input.images?.opacity, 0.2, 1, 1),
    },
    footer: {
      pageNumbers: input.footer?.pageNumbers !== false,
      confidentialityLabel: normalizeText(input.footer?.confidentialityLabel).slice(0, 120),
      labelPosition: ["bottom-left", "bottom-center", "bottom-right"].includes(input.footer?.labelPosition)
        ? input.footer.labelPosition
        : "bottom-left",
      color: normalizeCimHexColor(input.footer?.color, colors.footer),
    },
    watermark: {
      visible: Boolean(input.watermark?.visible),
      image: normalizeImageDataUrl(input.watermark?.image),
      opacity: clamp(input.watermark?.opacity, 0.04, 0.6, 0.12),
      position: ["center", "top-right", "bottom-right"].includes(input.watermark?.position)
        ? input.watermark.position
        : "center",
      width: clamp(input.watermark?.width, 120, 760, 360),
    },
    layout: {
      marginScale: clamp(input.layout?.marginScale, 0.86, 1.2, 1),
      sectionSpacingScale: clamp(input.layout?.sectionSpacingScale, 0.86, 1.24, 1),
      alignObjects: Boolean(input.layout?.alignObjects),
    },
    transition: CIM_STYLE_TRANSITION_OPTIONS.some((option) => option.value === input.transition)
      ? input.transition
      : "none",
    elementOverrides: normalizeElementOverrides(input.elementOverrides),
    audit: Array.isArray(input.audit) ? input.audit.slice(-30) : [],
    updatedAt: input.updatedAt || null,
  };
}

export function createCimStyleProfile(overrides = {}) {
  return normalizeCimStyleProfile({
    ...DEFAULT_CIM_STYLE_PROFILE,
    ...overrides,
    id: overrides.id || `cim-style-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: overrides.name || "Brand Style",
    locked: false,
    isDefault: false,
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  });
}

export function normalizeCimStyleProfilesState(input = {}) {
  const now = new Date().toISOString();
  const incomingProfiles = Array.isArray(input.profiles) ? input.profiles : [];
  const profilesById = new Map();
  profilesById.set(DEFAULT_CIM_STYLE_PROFILE_ID, DEFAULT_CIM_STYLE_PROFILE);
  incomingProfiles.forEach((profile) => {
    const normalized = normalizeCimStyleProfile(profile);
    profilesById.set(normalized.id, normalized);
  });
  const profiles = Array.from(profilesById.values());
  const activeProfileId = profilesById.has(input.activeProfileId)
    ? input.activeProfileId
    : DEFAULT_CIM_STYLE_PROFILE_ID;

  return {
    version: CIM_STYLE_PROFILE_VERSION,
    activeProfileId,
    profiles,
    updatedAt: input.updatedAt || now,
  };
}

export function isDefaultCimStyleProfile(profile) {
  return !profile || profile.isDefault || profile.id === DEFAULT_CIM_STYLE_PROFILE_ID;
}

export function getActiveCimStyleProfile(state) {
  const normalized = normalizeCimStyleProfilesState(state);
  return normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) || DEFAULT_CIM_STYLE_PROFILE;
}

export function validateCimStyleProfile(input) {
  const warnings = [];
  const normalized = normalizeCimStyleProfile(input);
  CIM_STYLE_COLOR_FIELDS.forEach(({ key }) => {
    if (input?.colors?.[key] && normalizeCimHexColor(input.colors[key], "") === "") {
      warnings.push(`${key} color was reset to the template default.`);
    }
  });
  CIM_STYLE_FONT_ROLES.forEach(({ key }) => {
    const family = input?.typography?.roles?.[key]?.fontFamily;
    if (family && !SUPPORTED_CIM_STYLE_FONTS.includes(family)) {
      warnings.push(`${key} font was replaced with an approved font.`);
    }
  });
  if (input?.background?.mode === "image" && !normalized.background.image) {
    warnings.push("Background image was removed because it is missing or unsupported.");
  }
  if (input?.watermark?.visible && input?.watermark?.image && !normalized.watermark.image) {
    warnings.push("Watermark image was removed because it is missing or unsupported.");
  }
  return { profile: normalized, warnings };
}

function hexKey(color) {
  return normalizeCimHexColor(color, "").replace("#", "");
}

function hasExplicitColor(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "tx1" || /^none$/i.test(raw) || /^transparent$/i.test(raw)) return false;
  if (/^#?[0-9a-f]{6}$/i.test(raw)) return true;
  const rgba = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgba) return false;
  const parts = rgba[1].split(",").map((part) => part.trim());
  if (parts.length >= 4 && Number(parts[3]) <= 0) return false;
  return parts.slice(0, 3).every((part) => Number.isFinite(Number(part)));
}

function colorForRole(color, profile, fallbackRole = "body") {
  const role = COLOR_ROLE_BY_HEX[hexKey(color)] || fallbackRole;
  return profile.colors[role] || profile.colors[fallbackRole] || color;
}

function colorForExistingElementColor(color, profile, fallbackRole) {
  return hasExplicitColor(color) ? colorForRole(color, profile, fallbackRole) : color;
}

function colorForExactRole(color, profile, role) {
  return hasExplicitColor(color) ? profile.colors[role] || colorForRole(color, profile, role) : color;
}

function colorsMatch(first, second) {
  const firstKey = hexKey(first);
  const secondKey = hexKey(second);
  return Boolean(firstKey && secondKey && firstKey === secondKey);
}

function classifyTextRole(slideNumber, element) {
  const [left = 0, top = 0, width = 0, height = 0] = element?.bbox || [];
  const runs = (element?.paragraphs || []).flatMap((paragraph) => paragraph.runs || []);
  const firstRun = runs.find((run) => normalizeText(run.text)) || {};
  const fontSize = Number(firstRun.fontSize || element?.resolvedFontSize || 0);
  const text = normalizeText(element?.text);

  if (/^\d{1,3}$/.test(text) && left >= 1180 && top <= 52 && width <= 90 && height <= 42) return "footer";
  if (top >= 630 || /confidential|page\s+\d+|draft/i.test(text)) return "footer";
  if (SECTION_DIVIDER_SLIDES.has(Number(slideNumber)) && fontSize >= 20) return "title";
  if (top <= 110 && (fontSize >= 21 || height >= 34)) return "title";
  if (top <= 170 && fontSize >= 14) return "subheading";
  if (fontSize >= 18 || firstRun.bold) return "heading";
  if (fontSize <= 10 || height <= 18) return "caption";
  return "body";
}

function transformText(value, capitalization) {
  const text = String(value || "");
  if (capitalization === "uppercase") return text.toUpperCase();
  if (capitalization === "title") {
    return text.replace(/\w\S*/g, (word) => (
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ));
  }
  return text;
}

function applyTypographyToRuns(paragraphs = [], roleKey, profile, colorFallbackRole, override = null) {
  const role = profile.typography.roles[roleKey] || profile.typography.roles.body;
  return paragraphs.map((paragraph) => ({
    ...paragraph,
    resolvedTextStyle: {
      ...(paragraph.resolvedTextStyle || {}),
      ...(role.alignment !== "inherit" ? { alignment: role.alignment } : {}),
      lineSpacing: role.lineSpacing,
      paragraphSpacing: role.paragraphSpacing,
    },
    runs: (paragraph.runs || []).map((run) => {
      const originalSize = Number(run.fontSize || 12);
      const nextSize = Math.max(5, originalSize * role.sizeScale + role.sizeDelta);
      return {
        ...run,
        text: transformText(run.text, role.capitalization),
        fontSize: override?.fontSize || nextSize,
        typeface: role.fontFamily,
        color: override?.color || colorForRole(run.color, profile, colorFallbackRole),
        bold: role.bold || role.weight >= 600 || Boolean(run.bold),
        italic: role.italic || Boolean(run.italic),
        underline: role.underline || Boolean(run.underline),
        fontWeight: role.weight,
        letterSpacing: role.letterSpacing,
      };
    }),
  }));
}

// Reads back the local per-textbox override set via the style editor's
// "click a text box on the preview, then tweak just its color/size" flow.
export function getCimStyleElementOverride(profile, slideNumber, elementId) {
  if (!elementId) return null;
  return profile?.elementOverrides?.[String(slideNumber)]?.[String(elementId)] || null;
}

function isImplicitTextBoxFill(element, slide = {}) {
  if (!element?.text || !hasExplicitColor(element.fillColor)) return false;
  const hasVisibleLine = hasExplicitColor(element.lineColor) && Number(element.lineWidth || 0) > 0;
  if (hasVisibleLine) return false;
  const slideBackground = slide.backgroundColor || "#FFFFFF";
  return colorsMatch(element.fillColor, slideBackground);
}

function getTextFillFallbackRole(element) {
  return COLOR_ROLE_BY_HEX[hexKey(element?.fillColor)] || "background";
}

function isCoverOrClosingBrandShape(slideNumber, element) {
  if (!COVER_AND_CLOSING_SLIDES.has(Number(slideNumber)) || element?.text) return false;
  const fillKey = hexKey(element?.fillColor);
  const lineKey = hexKey(element?.lineColor);
  return TEMPLATE_BRAND_GREEN_KEYS.has(fillKey) || TEMPLATE_BRAND_GREEN_KEYS.has(lineKey);
}

function applyTextElementStyle(slideNumber, element, profile, slide = {}) {
  const roleKey = classifyTextRole(slideNumber, element);
  const colorRole =
    roleKey === "title" ? "title" :
    roleKey === "subheading" ? "subtitle" :
    roleKey === "footer" ? "footer" :
    roleKey === "caption" ? "muted" :
    "body";
  const role = profile.typography.roles[roleKey] || profile.typography.roles.body;
  const override = getCimStyleElementOverride(profile, slideNumber, element.id);
  const next = {
    ...element,
    text: transformText(element.text, role.capitalization),
    paragraphs: applyTypographyToRuns(element.paragraphs || [], roleKey, profile, colorRole, override),
    resolvedTextStyle: {
      ...(element.resolvedTextStyle || {}),
      ...(role.alignment !== "inherit" ? { alignment: role.alignment } : {}),
      lineSpacing: role.lineSpacing,
      paragraphSpacing: role.paragraphSpacing,
      wrap: role.wrap,
    },
  };
  const implicitFill = isImplicitTextBoxFill(element, slide);
  const fillColor = implicitFill
    ? undefined
    : colorForExistingElementColor(element.fillColor, profile, getTextFillFallbackRole(element));
  const lineColor = colorForExistingElementColor(
    element.lineColor,
    profile,
    roleKey === "footer" ? "footer" : "divider",
  );

  if (implicitFill || hasExplicitColor(element.fillColor) || hasExplicitColor(element.lineColor)) {
    return {
      ...next,
      fillColor,
      lineColor,
    };
  }
  return next;
}

function applyTableCellStyle(cell, profile) {
  const row = Number(cell.row || 1);
  const isHeader = row === 1 || hexKey(cell.fillColor) === "476E2C";
  const isAlt = !isHeader && profile.tables.alternateRows && row % 2 === 0;
  const roleKey = "table";
  const fillColor = isHeader
    ? profile.tables.headerColor
    : isAlt
      ? profile.tables.altRowColor
      : profile.tables.rowColor;
  const textColor = isHeader
    ? profile.tables.headerTextColor
    : colorForRole((cell.paragraphs || [])[0]?.runs?.[0]?.color, profile, "body");

  const paragraphs = applyTypographyToRuns(cell.paragraphs || [], roleKey, profile, isHeader ? "tableHeaderText" : "body")
    .map((paragraph) => ({
      ...paragraph,
      runs: (paragraph.runs || []).map((run) => ({ ...run, color: textColor })),
    }));

  return {
    ...cell,
    fillColor,
    lineColor: profile.tables.borderColor,
    lineWidth: profile.tables.borderWidth,
    resolvedTextStyle: {
      ...(cell.resolvedTextStyle || {}),
      insets: {
        top: Math.max(0, profile.tables.cellPadding * 0.4),
        right: profile.tables.cellPadding,
        bottom: Math.max(0, profile.tables.cellPadding * 0.4),
        left: profile.tables.cellPadding,
      },
    },
    paragraphs,
  };
}

function isChartPlaceholder(element) {
  return /\b(chart|graph|matrix|diagram|timeline)\b/i.test(normalizeText(element?.text));
}

function isImagePlaceholder(element) {
  return /\b(image|photo|logo|picture|visual)\b/i.test(normalizeText(element?.text));
}

function applyElementStyle(slideNumber, element, profile, slide = {}) {
  if (!element || typeof element !== "object") return element;
  if (element.kind === "table" && Array.isArray(element.cells)) {
    return {
      ...element,
      fillColor: "transparent",
      lineColor: profile.tables.borderColor,
      cells: element.cells.map((cell) => applyTableCellStyle(cell, profile)),
    };
  }
  if (element.kind === "styleImage" || element.kind === "styleText") return element;

  const isLine = Number(element.bbox?.[2] || 0) === 0 || Number(element.bbox?.[3] || 0) === 0;
  const isBrandShape = isCoverOrClosingBrandShape(slideNumber, element);
  let next = element.text
    ? applyTextElementStyle(slideNumber, element, profile, slide)
    : { ...element };

  if (isLine) {
    const strokeColor = element.lineColor || element.fillColor;
    next = {
      ...next,
      fillColor: isBrandShape
        ? colorForExactRole(strokeColor, profile, "primary")
        : colorForExistingElementColor(element.fillColor || element.lineColor, profile, "divider"),
      lineColor: isBrandShape
        ? colorForExactRole(strokeColor, profile, "primary")
        : colorForExistingElementColor(element.lineColor || element.fillColor, profile, "divider"),
    };
  } else if (!element.text) {
    next = {
      ...next,
      fillColor: isBrandShape
        ? colorForExactRole(element.fillColor, profile, "primary")
        : colorForExistingElementColor(element.fillColor, profile, "background"),
      lineColor: isBrandShape
        ? colorForExactRole(element.lineColor, profile, "primary")
        : colorForExistingElementColor(element.lineColor, profile, "tableBorder"),
    };
  }

  if (isChartPlaceholder(element)) {
    next = {
      ...next,
      fillColor: profile.charts.backgroundColor,
      lineColor: profile.colors.divider,
      lineWidth: Math.max(Number(element.lineWidth || 0), 0.5),
    };
  }

  if (isImagePlaceholder(element)) {
    next = {
      ...next,
      imageCornerRadius: profile.images.cornerRadius,
      imageBorderColor: profile.images.borderColor,
      imageBorderWidth: profile.images.borderWidth,
      imageShadow: profile.images.shadow,
      opacity: profile.images.opacity,
    };
  }

  if (!profile.footer.pageNumbers && classifyTextRole(slideNumber, element) === "footer" && /^\d{1,3}$/.test(normalizeText(element.text))) {
    next = { ...next, styleHidden: true };
  }

  return next;
}

function shouldApplyBackground(slideNumber, profile) {
  if (profile.background.applyTo === "all") return true;
  if (profile.background.applyTo === "cover") return Number(slideNumber) === 1;
  if (profile.background.applyTo === "section") return SECTION_DIVIDER_SLIDES.has(Number(slideNumber));
  return false;
}

function buildWatermarkElement(profile) {
  if (!profile.watermark.visible || !profile.watermark.image?.dataUrl) return null;
  const width = profile.watermark.width;
  const height = width * 0.42;
  const position = {
    center: [(1280 - width) / 2, (720 - height) / 2],
    "top-right": [1280 - width - 48, 58],
    "bottom-right": [1280 - width - 48, 720 - height - 44],
  }[profile.watermark.position] || [(1280 - width) / 2, (720 - height) / 2];
  return {
    id: "__cim_style_watermark",
    aid: "__cim_style_watermark",
    name: "Brand watermark",
    kind: "styleImage",
    order: 9000,
    bbox: [position[0], position[1], width, height],
    dataUrl: profile.watermark.image.dataUrl,
    opacity: profile.watermark.opacity,
  };
}

function buildConfidentialityElement(profile) {
  const label = normalizeText(profile.footer.confidentialityLabel);
  if (!label) return null;
  const width = 420;
  const left = profile.footer.labelPosition === "bottom-center"
    ? (1280 - width) / 2
    : profile.footer.labelPosition === "bottom-right"
      ? 1280 - width - 42
      : 42;
  const align = profile.footer.labelPosition === "bottom-center"
    ? "center"
    : profile.footer.labelPosition === "bottom-right"
      ? "right"
      : "left";
  return {
    id: "__cim_style_confidentiality",
    aid: "__cim_style_confidentiality",
    name: "Confidentiality label",
    kind: "styleText",
    order: 9001,
    bbox: [left, 684, width, 20],
    text: label,
    fillColor: "transparent",
    lineColor: "transparent",
    resolvedTextStyle: { alignment: align, verticalAlignment: "middle", insets: { top: 0, right: 0, bottom: 0, left: 0 } },
    paragraphs: [{
      index: 1,
      text: label,
      resolvedTextStyle: { alignment: align },
      runs: [{
        index: 1,
        text: label,
        fontSize: 8.5,
        typeface: profile.typography.roles.footer.fontFamily,
        color: profile.footer.color,
        bold: false,
      }],
    }],
  };
}

export function applyCimTemplateStyleProfile(slideNumber, layout, profile) {
  if (!layout || isDefaultCimStyleProfile(profile)) return layout;
  const normalized = normalizeCimStyleProfile(profile);
  const slide = {
    ...(layout.slide || {}),
    transition: normalized.transition,
  };

  if (
    COVER_AND_CLOSING_SLIDES.has(Number(slideNumber)) &&
    hexKey(layout.slide?.backgroundColor) === TEMPLATE_COVER_BACKGROUND_KEY
  ) {
    slide.backgroundColor = normalized.colors.primary;
  }

  if (shouldApplyBackground(slideNumber, normalized)) {
    if (normalized.background.mode === "solid") {
      slide.backgroundColor = normalized.background.color;
      slide.backgroundMode = "solid";
    } else if (normalized.background.mode === "gradient") {
      slide.backgroundColor = normalized.background.gradientFrom;
      slide.backgroundMode = "gradient";
      slide.gradientFrom = normalized.background.gradientFrom;
      slide.gradientTo = normalized.background.gradientTo;
      slide.gradientAngle = normalized.background.gradientAngle;
    } else if (normalized.background.mode === "image" && normalized.background.image?.dataUrl) {
      slide.backgroundColor = normalized.background.color;
      slide.backgroundMode = "image";
      slide.backgroundImage = normalized.background.image;
      slide.backgroundImageOpacity = normalized.background.imageOpacity;
    }
  }

  const syntheticElements = [buildWatermarkElement(normalized), buildConfidentialityElement(normalized)].filter(Boolean);
  return {
    ...layout,
    slide,
    elements: [
      ...(layout.elements || []).map((element) => applyElementStyle(slideNumber, element, normalized, layout.slide || {})),
      ...syntheticElements,
    ].filter((element) => !element?.styleHidden),
  };
}

export function applyCimTemplateStyleProfilesToLayouts(layouts = {}, profile) {
  if (isDefaultCimStyleProfile(profile)) return layouts;
  return Object.fromEntries(
    Object.entries(layouts).map(([slideNumber, layout]) => [
      slideNumber,
      applyCimTemplateStyleProfile(Number(slideNumber), layout, profile),
    ]),
  );
}

export function exportCimStyleProfileJson(profile) {
  const normalized = normalizeCimStyleProfile(profile);
  return JSON.stringify({
    kind: "datahub-cim-style-profile",
    version: CIM_STYLE_PROFILE_VERSION,
    exportedAt: new Date().toISOString(),
    contents: [
      "colors",
      "typography",
      "background",
      "tables",
      "charts",
      "branding",
      "elementOverrides",
    ],
    profile: normalized,
  }, null, 2);
}

export function importCimStyleProfileJson(text) {
  const parsed = JSON.parse(text);
  const payload = parsed?.profile || parsed;
  return validateCimStyleProfile({
    ...payload,
    id: payload?.isDefault ? undefined : payload?.id,
    locked: false,
    isDefault: false,
  });
}
