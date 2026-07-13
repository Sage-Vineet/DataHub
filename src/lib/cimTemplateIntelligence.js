import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export const TEMPLATE_SELECTION_MODES = Object.freeze({
  DEFAULT: "default",
  CUSTOM: "custom",
});

export const TEMPLATE_INTELLIGENCE_VERSION = 1;
export const TEMPLATE_MAPPING_CONFIDENCE_THRESHOLD = 0.76;

const EMU_PER_PX = 9525;
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const LEARNING_STORAGE_KEY = "datahub:cim-template-intelligence-learning";

const PLACEHOLDER_REGEX = /\[([^\][\r\n]{1,120})\]/g;

const MONEY_METRICS = new Set([
  "totalRevenue",
  "grossProfit",
  "ebitda",
  "adjustedEbitda",
  "netProfit",
  "freeCashFlow",
  "cashFromOperations",
  "workingCapital",
  "totalAssets",
  "totalLiabilities",
  "totalDebt",
  "netDebt",
  "cashAndBankBalance",
  "capitalExpenditures",
]);

const PERCENT_METRICS = new Set([
  "revenueGrowth",
  "revenueCagr",
  "ebitdaMargin",
  "grossMargin",
  "fcfConversion",
  "effectiveTaxRate",
]);

const SEMANTIC_RULES = [
  {
    semanticMeaning: "Revenue CAGR",
    metricKey: "revenueCagr",
    expectedDataType: "percentage",
    keywords: ["revenue", "sales"],
    requiredAny: ["cagr", "compound annual growth"],
    sourceHints: ["Profit & Loss", "Financial reports"],
  },
  {
    semanticMeaning: "Revenue Growth",
    metricKey: "revenueGrowth",
    expectedDataType: "percentage",
    keywords: ["revenue growth", "sales growth", "revenue grew", "sales grew", "growth in revenue"],
    sourceHints: ["Profit & Loss", "Financial reports"],
  },
  {
    semanticMeaning: "EBITDA Margin",
    metricKey: "ebitdaMargin",
    expectedDataType: "percentage",
    keywords: ["ebitda margin", "adjusted ebitda margin"],
    sourceHints: ["EBITDA Calculation", "Profit & Loss"],
  },
  {
    semanticMeaning: "Gross Margin",
    metricKey: "grossMargin",
    expectedDataType: "percentage",
    keywords: ["gross margin", "gross profit margin"],
    sourceHints: ["Profit & Loss"],
  },
  {
    semanticMeaning: "Free Cash Flow Conversion",
    metricKey: "fcfConversion",
    expectedDataType: "percentage",
    keywords: ["fcf conversion", "free cash flow conversion", "cash conversion"],
    sourceHints: ["Cash Flow Statement", "EBITDA Calculation"],
  },
  {
    semanticMeaning: "Adjusted EBITDA",
    metricKey: "adjustedEbitda",
    expectedDataType: "currency",
    keywords: ["adjusted ebitda", "adj. ebitda", "normalized ebitda"],
    sourceHints: ["EBITDA Calculation"],
  },
  {
    semanticMeaning: "EBITDA",
    metricKey: "ebitda",
    expectedDataType: "currency",
    keywords: ["ebitda"],
    sourceHints: ["EBITDA Calculation"],
  },
  {
    semanticMeaning: "Revenue",
    metricKey: "totalRevenue",
    expectedDataType: "currency",
    keywords: ["revenue", "sales"],
    sourceHints: ["Profit & Loss"],
  },
  {
    semanticMeaning: "Gross Profit",
    metricKey: "grossProfit",
    expectedDataType: "currency",
    keywords: ["gross profit"],
    sourceHints: ["Profit & Loss"],
  },
  {
    semanticMeaning: "Net Income",
    metricKey: "netProfit",
    expectedDataType: "currency",
    keywords: ["net income", "net profit"],
    sourceHints: ["Profit & Loss"],
  },
  {
    semanticMeaning: "Free Cash Flow",
    metricKey: "freeCashFlow",
    expectedDataType: "currency",
    keywords: ["free cash flow", "fcf"],
    sourceHints: ["Cash Flow Statement"],
  },
  {
    semanticMeaning: "Cash Flow From Operations",
    metricKey: "cashFromOperations",
    expectedDataType: "currency",
    keywords: ["cash from operations", "cash flow from operations", "operating cash flow", "cfo"],
    sourceHints: ["Cash Flow Statement"],
  },
  {
    semanticMeaning: "Working Capital",
    metricKey: "workingCapital",
    expectedDataType: "currency",
    keywords: ["working capital", "net working capital", "nwc"],
    sourceHints: ["Balance Sheet"],
  },
  {
    semanticMeaning: "Total Debt",
    metricKey: "totalDebt",
    expectedDataType: "currency",
    keywords: ["total debt", "debt"],
    sourceHints: ["Balance Sheet"],
  },
  {
    semanticMeaning: "Net Debt",
    metricKey: "netDebt",
    expectedDataType: "currency",
    keywords: ["net debt"],
    sourceHints: ["Balance Sheet"],
  },
  {
    semanticMeaning: "Cash Balance",
    metricKey: "cashAndBankBalance",
    expectedDataType: "currency",
    keywords: ["cash balance", "cash and bank", "cash & bank", "cash"],
    sourceHints: ["Balance Sheet", "Bank Reconciliation"],
  },
  {
    semanticMeaning: "Capital Expenditures",
    metricKey: "capitalExpenditures",
    expectedDataType: "currency",
    keywords: ["capital expenditures", "capex", "capital expenditure"],
    sourceHints: ["Cash Flow Statement"],
  },
  {
    semanticMeaning: "Market Size",
    metricKey: "marketSize",
    expectedDataType: "currency",
    keywords: ["market size", "tam", "sam", "som"],
    sourceHints: ["Data Room", "Market materials"],
  },
  {
    semanticMeaning: "Employees",
    metricKey: "employees",
    expectedDataType: "number",
    keywords: ["employees", "headcount", "fte"],
    sourceHints: ["Data Room", "Company materials"],
  },
  {
    semanticMeaning: "Customers",
    metricKey: "customers",
    expectedDataType: "number",
    keywords: ["customers", "customer count", "active customers"],
    sourceHints: ["Data Room", "CRM"],
  },
  {
    semanticMeaning: "Ownership",
    metricKey: "ownership",
    expectedDataType: "text",
    keywords: ["ownership", "shareholders", "cap table"],
    sourceHints: ["Data Room", "Corporate documents"],
  },
  {
    semanticMeaning: "Risks",
    metricKey: "risks",
    expectedDataType: "text",
    keywords: ["risks", "risk factors", "diligence topics"],
    sourceHints: ["Data Room", "Management questionnaire"],
  },
  {
    semanticMeaning: "Growth Opportunities",
    metricKey: "growthOpportunities",
    expectedDataType: "text",
    keywords: ["growth opportunities", "growth strategy", "growth initiatives"],
    sourceHints: ["Data Room", "Management questionnaire"],
  },
  {
    semanticMeaning: "Transaction Structure",
    metricKey: "transactionStructure",
    expectedDataType: "text",
    keywords: ["transaction structure", "deal structure", "rollover", "process"],
    sourceHints: ["Transaction materials"],
  },
];

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeComparableText(value = "") {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, "[placeholder]")
    .replace(/[^a-z0-9%$.\-[\] ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashString(value = "") {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function readArchiveText(archive, path) {
  const bytes = archive?.[path];
  if (!bytes) return "";
  return strFromU8(bytes);
}

function parseXml(xml) {
  if (!normalizeText(xml) || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  return doc;
}

function serializeXml(doc) {
  if (!doc || typeof XMLSerializer === "undefined") return "";
  return new XMLSerializer().serializeToString(doc);
}

function getLocalName(node) {
  return node?.localName || String(node?.nodeName || "").split(":").pop();
}

function elementChildren(node) {
  return Array.from(node?.childNodes || []).filter((child) => child.nodeType === 1);
}

function descendantsByLocalName(node, localName) {
  const result = [];
  const stack = [...elementChildren(node)];
  while (stack.length) {
    const current = stack.shift();
    if (getLocalName(current) === localName) result.push(current);
    stack.unshift(...elementChildren(current));
  }
  return result;
}

function firstDescendantByLocalName(node, localName) {
  const stack = [...elementChildren(node)];
  while (stack.length) {
    const current = stack.shift();
    if (getLocalName(current) === localName) return current;
    stack.unshift(...elementChildren(current));
  }
  return null;
}

function closestByLocalName(node, localNames = []) {
  const names = new Set(localNames);
  let current = node?.parentNode || null;
  while (current && current.nodeType === 1) {
    if (names.has(getLocalName(current))) return current;
    current = current.parentNode;
  }
  return null;
}

function getRelationshipId(node) {
  if (!node) return "";
  return (
    node.getAttribute("r:id") ||
    node.getAttributeNS?.(REL_NS, "id") ||
    node.getAttribute("id") ||
    ""
  );
}

function normalizePath(path = "") {
  const absolute = String(path || "").startsWith("/");
  const parts = [];
  String(path || "")
    .split("/")
    .filter(Boolean)
    .forEach((part) => {
      if (part === ".") return;
      if (part === "..") {
        parts.pop();
        return;
      }
      parts.push(part);
    });
  return `${absolute ? "/" : ""}${parts.join("/")}`.replace(/^\/+/, "");
}

function resolveTargetPath(sourcePath, target = "") {
  const raw = String(target || "");
  if (!raw) return "";
  if (/^[a-z]+:/i.test(raw)) return raw;
  if (raw.startsWith("/")) return normalizePath(raw);
  const base = String(sourcePath || "").split("/").slice(0, -1).join("/");
  return normalizePath(`${base}/${raw}`);
}

function parseRelationships(archive, relsPath, sourcePath) {
  const doc = parseXml(readArchiveText(archive, relsPath));
  const relationships = {};
  if (!doc) return relationships;

  descendantsByLocalName(doc, "Relationship").forEach((node) => {
    const id = node.getAttribute("Id") || "";
    const target = node.getAttribute("Target") || "";
    if (!id || !target) return;
    relationships[id] = {
      id,
      type: node.getAttribute("Type") || "",
      target,
      targetPath: resolveTargetPath(sourcePath, target),
    };
  });
  return relationships;
}

function getSlideNumberFromPath(path = "") {
  return Number(String(path).match(/slide(\d+)\.xml$/)?.[1] || 0);
}

function getRelsPathForPart(partPath = "") {
  const parts = String(partPath || "").split("/");
  const file = parts.pop();
  return `${parts.join("/")}/_rels/${file}.rels`;
}

function getPresentationSlidePaths(archive) {
  const fallback = Object.keys(archive || {})
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => getSlideNumberFromPath(a) - getSlideNumberFromPath(b));

  const presentationDoc = parseXml(readArchiveText(archive, "ppt/presentation.xml"));
  if (!presentationDoc) return fallback;

  const rels = parseRelationships(archive, "ppt/_rels/presentation.xml.rels", "ppt/presentation.xml");
  const ordered = descendantsByLocalName(presentationDoc, "sldId")
    .map((node) => {
      const relId = getRelationshipId(node);
      return rels[relId]?.targetPath || "";
    })
    .filter((path) => archive[path]);

  return ordered.length ? ordered : fallback;
}

function toPx(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric / EMU_PER_PX : 0;
}

function getElementBBox(element) {
  const xfrm = firstDescendantByLocalName(element, "xfrm");
  if (!xfrm) return null;
  const off = firstDescendantByLocalName(xfrm, "off");
  const ext = firstDescendantByLocalName(xfrm, "ext");
  if (!off || !ext) return null;
  return [
    toPx(off.getAttribute("x")),
    toPx(off.getAttribute("y")),
    toPx(ext.getAttribute("cx")),
    toPx(ext.getAttribute("cy")),
  ].map((value) => Math.round(value * 100) / 100);
}

function getNodeText(node) {
  return descendantsByLocalName(node, "t").map((textNode) => textNode.textContent || "").join("");
}

function getParagraphTextNodes(paragraphNode) {
  const nodes = descendantsByLocalName(paragraphNode, "t");
  let cursor = 0;
  return nodes.map((node) => {
    const text = node.textContent || "";
    const entry = {
      node,
      text,
      start: cursor,
      end: cursor + text.length,
    };
    cursor += text.length;
    return entry;
  });
}

function getRunStyle(paragraphNode) {
  const rPr = firstDescendantByLocalName(paragraphNode, "rPr");
  const latin = firstDescendantByLocalName(rPr, "latin");
  const srgbClr = firstDescendantByLocalName(rPr, "srgbClr");
  const schemeClr = firstDescendantByLocalName(rPr, "schemeClr");
  const size = Number(rPr?.getAttribute("sz") || 0);
  return {
    fontFamily: latin?.getAttribute("typeface") || "",
    fontSizePt: size ? size / 100 : null,
    bold: rPr?.getAttribute("b") === "1",
    italic: rPr?.getAttribute("i") === "1",
    color: srgbClr?.getAttribute("val")
      ? `#${srgbClr.getAttribute("val")}`
      : schemeClr?.getAttribute("val") || "",
  };
}

function getShapeType(shapeNode) {
  const cNvSpPr = firstDescendantByLocalName(shapeNode, "cNvSpPr");
  const ph = firstDescendantByLocalName(shapeNode, "ph");
  if (ph?.getAttribute("type")) return ph.getAttribute("type");
  if (cNvSpPr?.getAttribute("txBox") === "1") return "textBox";
  return firstDescendantByLocalName(shapeNode, "txBody") ? "shapeText" : "shape";
}

function getElementName(element) {
  const cNvPr = firstDescendantByLocalName(element, "cNvPr");
  return cNvPr?.getAttribute("name") || cNvPr?.getAttribute("descr") || "";
}

function indexElements(doc) {
  const metaByNode = new WeakMap();
  const elementSummary = {
    textBoxes: [],
    tables: [],
    charts: [],
    shapes: [],
    images: [],
    logos: [],
    icons: [],
    groupedObjects: [],
    smartArt: [],
    headersFooters: [],
  };

  const allElements = descendantsByLocalName(doc, "sp")
    .concat(descendantsByLocalName(doc, "graphicFrame"))
    .concat(descendantsByLocalName(doc, "pic"))
    .concat(descendantsByLocalName(doc, "grpSp"))
    .sort((a, b) => {
      if (a === b) return 0;
      const position = a.compareDocumentPosition(b);
      return position & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });

  let textBoxIndex = 0;
  let shapeIndex = 0;
  let imageIndex = 0;
  let tableIndex = 0;
  let chartIndex = 0;
  let groupIndex = 0;
  let smartArtIndex = 0;

  allElements.forEach((element) => {
    const localName = getLocalName(element);
    const bbox = getElementBBox(element);
    const name = getElementName(element);
    const top = bbox?.[1] || 0;
    const height = bbox?.[3] || 0;
    const text = getNodeText(element);

    if (localName === "grpSp") {
      const meta = { type: "groupedObject", index: groupIndex, bbox, name };
      groupIndex += 1;
      metaByNode.set(element, meta);
      elementSummary.groupedObjects.push(meta);
      return;
    }

    if (localName === "pic") {
      const meta = { type: "image", index: imageIndex, bbox, name };
      imageIndex += 1;
      metaByNode.set(element, meta);
      elementSummary.images.push(meta);
      const lowerName = normalizeComparableText(name);
      if (lowerName.includes("logo") || (bbox && bbox[2] < 240 && bbox[3] < 140 && top < 120)) {
        elementSummary.logos.push({ ...meta, type: "logo" });
      } else if (bbox && bbox[2] <= 80 && bbox[3] <= 80) {
        elementSummary.icons.push({ ...meta, type: "icon" });
      }
      return;
    }

    if (localName === "graphicFrame") {
      const hasTable = Boolean(firstDescendantByLocalName(element, "tbl"));
      const hasChart = Boolean(firstDescendantByLocalName(element, "chart"));
      const graphicData = firstDescendantByLocalName(element, "graphicData");
      const isSmartArt = /diagram|smartart/i.test(graphicData?.getAttribute("uri") || "");
      let meta;
      if (hasTable) {
        meta = { type: "table", index: tableIndex, bbox, name };
        tableIndex += 1;
        elementSummary.tables.push(meta);
      } else if (hasChart) {
        meta = { type: "chart", index: chartIndex, bbox, name };
        chartIndex += 1;
        elementSummary.charts.push(meta);
      } else if (isSmartArt) {
        meta = { type: "smartArt", index: smartArtIndex, bbox, name };
        smartArtIndex += 1;
        elementSummary.smartArt.push(meta);
      } else {
        meta = { type: "graphicFrame", index: chartIndex + tableIndex, bbox, name };
      }
      metaByNode.set(element, meta);
      return;
    }

    const shapeType = getShapeType(element);
    const meta = {
      type: shapeType === "textBox" ? "textBox" : "shape",
      shapeType,
      index: shapeType === "textBox" ? textBoxIndex : shapeIndex,
      bbox,
      name,
      text: normalizeText(text),
    };
    if (shapeType === "textBox") {
      textBoxIndex += 1;
      elementSummary.textBoxes.push(meta);
    } else {
      shapeIndex += 1;
      elementSummary.shapes.push(meta);
    }
    if (normalizeText(text) && (top < 60 || top + height > 660)) {
      elementSummary.headersFooters.push({ ...meta, type: top < 60 ? "header" : "footer" });
    }
    metaByNode.set(element, meta);
  });

  return { metaByNode, elementSummary };
}

function getTableCellMeta(cellNode) {
  const tableNode = closestByLocalName(cellNode, ["tbl"]);
  const rowNode = closestByLocalName(cellNode, ["tr"]);
  if (!tableNode || !rowNode) return null;

  const tables = descendantsByLocalName(tableNode.ownerDocument, "tbl");
  const tableIndex = tables.indexOf(tableNode);
  const rows = elementChildren(tableNode).filter((child) => getLocalName(child) === "tr");
  const rowIndex = rows.indexOf(rowNode);
  const cells = elementChildren(rowNode).filter((child) => getLocalName(child) === "tc");
  const colIndex = cells.indexOf(cellNode);
  const headerCells = rows[0]
    ? elementChildren(rows[0]).filter((child) => getLocalName(child) === "tc").map((cell) => normalizeText(getNodeText(cell)))
    : [];

  return {
    tableIndex,
    rowIndex,
    colIndex,
    columnHeader: headerCells[colIndex] || "",
    rowLabel: rowIndex > 0 ? normalizeText(getNodeText(cells[0])) : "",
    headers: headerCells,
  };
}

function extractChartTitle(chartDoc) {
  if (!chartDoc) return "";
  const title = firstDescendantByLocalName(chartDoc, "title");
  return normalizeText(getNodeText(title));
}

function getChartRelationships(archive, slidePath) {
  const rels = parseRelationships(archive, getRelsPathForPart(slidePath), slidePath);
  return Object.values(rels).filter((rel) => /\/chart$/i.test(rel.type) || /charts\/chart\d+\.xml$/.test(rel.targetPath));
}

function getNotesRelationship(archive, slidePath) {
  const rels = parseRelationships(archive, getRelsPathForPart(slidePath), slidePath);
  return Object.values(rels).find((rel) => /\/notesSlide$/i.test(rel.type) || /notesSlides\/notesSlide\d+\.xml$/.test(rel.targetPath));
}

function buildParagraphScopes(doc, partPath, partType, extraContext = {}) {
  const { metaByNode, elementSummary } = indexElements(doc);
  const paragraphs = descendantsByLocalName(doc, "p")
    .filter((paragraphNode) => descendantsByLocalName(paragraphNode, "t").length > 0)
    .map((paragraphNode, paragraphIndex) => {
      const text = normalizeText(getNodeText(paragraphNode));
      const ownerElement = closestByLocalName(paragraphNode, ["sp", "graphicFrame", "pic", "grpSp"]);
      const cellNode = closestByLocalName(paragraphNode, ["tc"]);
      const ownerMeta = ownerElement ? metaByNode.get(ownerElement) : null;
      return {
        paragraphNode,
        paragraphIndex,
        text,
        partPath,
        partType,
        bbox: ownerMeta?.bbox || null,
        elementType: ownerMeta?.type || partType,
        elementIndex: ownerMeta?.index ?? null,
        elementName: ownerMeta?.name || "",
        tableRelationship: cellNode ? getTableCellMeta(cellNode) : null,
        fontInformation: getRunStyle(paragraphNode),
        colorInformation: {
          fontColor: getRunStyle(paragraphNode).color || "",
        },
        ...extraContext,
      };
    });

  return { paragraphs, elementSummary };
}

function inferSlideTitle(paragraphs = []) {
  const titleCandidate = paragraphs.find((scope) => {
    const top = scope.bbox?.[1] || 0;
    const fontSize = Number(scope.fontInformation?.fontSizePt || 0);
    return scope.text && (top < 180 || fontSize >= 18);
  });
  return titleCandidate?.text || paragraphs.find((scope) => scope.text)?.text || "";
}

function getImmediateSuffix(fullText, tokenEnd) {
  const remainder = String(fullText || "").slice(tokenEnd);
  const match = remainder.match(/^(%|bps|bp|MM|mm|M|x|X|k|K)/);
  return match?.[1] || "";
}

function getImmediatePrefix(fullText, tokenStart) {
  const prefix = String(fullText || "").slice(Math.max(0, tokenStart - 2), tokenStart);
  const match = prefix.match(/(\$|₹|€|£)\s?$/);
  return match?.[1] || "";
}

function detectPlaceholdersInScope(scope, occurrenceStart = 0) {
  const textNodes = getParagraphTextNodes(scope.paragraphNode);
  const fullText = textNodes.map((entry) => entry.text).join("");
  const placeholders = [];
  let match;
  let occurrence = occurrenceStart;

  PLACEHOLDER_REGEX.lastIndex = 0;
  while ((match = PLACEHOLDER_REGEX.exec(fullText))) {
    const tokenText = match[0];
    const tokenInnerText = match[1];
    const tokenStart = match.index;
    const tokenEnd = tokenStart + tokenText.length;
    const suffix = getImmediateSuffix(fullText, tokenEnd);
    const prefix = getImmediatePrefix(fullText, tokenStart);
    const before = fullText.slice(Math.max(0, tokenStart - 140), tokenStart);
    const after = fullText.slice(tokenEnd, Math.min(fullText.length, tokenEnd + 140));
    const contextText = normalizeText([
      scope.slideTitle,
      scope.sectionTitle,
      scope.elementName,
      scope.tableRelationship?.columnHeader,
      scope.tableRelationship?.rowLabel,
      before,
      tokenText,
      suffix,
      after,
    ].filter(Boolean).join(" "));
    const id = `tpl:${hashString(scope.partPath)}:${occurrence}`;
    placeholders.push({
      id,
      sourcePart: scope.partPath,
      partType: scope.partType,
      slideNumber: scope.slideNumber ?? null,
      placeholderText: `${tokenText}${suffix}`,
      tokenText,
      tokenInnerText,
      prefix,
      suffix,
      paragraphText: normalizeText(fullText),
      surroundingText: contextText,
      staticContentFragments: [
        normalizeText(fullText.slice(0, tokenStart)),
        normalizeText(fullText.slice(tokenEnd + suffix.length)),
      ].filter(Boolean),
      tokenStart,
      tokenEnd,
      occurrence,
      paragraphIndex: scope.paragraphIndex,
      elementType: scope.elementType,
      elementIndex: scope.elementIndex,
      slideCoordinates: scope.bbox,
      fontInformation: scope.fontInformation,
      colorInformation: scope.colorInformation,
      tableChartRelationships: scope.tableRelationship
        ? { table: scope.tableRelationship }
        : scope.chartRelationship
          ? { chart: scope.chartRelationship }
          : null,
      contextSignature: hashString(normalizeComparableText(contextText)),
      textNodes,
    });
    occurrence += 1;
  }

  return { placeholders, nextOccurrence: occurrence };
}

function detectPlaceholdersInDocument(doc, partPath, partType, extraContext = {}) {
  const { paragraphs, elementSummary } = buildParagraphScopes(doc, partPath, partType, extraContext);
  const slideTitle = extraContext.slideTitle || inferSlideTitle(paragraphs);
  let occurrence = 0;
  const placeholders = [];

  paragraphs.forEach((scope) => {
    const detection = detectPlaceholdersInScope({ ...scope, slideTitle }, occurrence);
    placeholders.push(...detection.placeholders);
    occurrence = detection.nextOccurrence;
  });

  return {
    placeholders,
    paragraphs,
    slideTitle,
    elementSummary,
  };
}

function parseSlidePart({ archive, slidePath, slideIndex }) {
  const xml = readArchiveText(archive, slidePath);
  const doc = parseXml(xml);
  if (!doc) return null;

  const hidden = /<p:sld\b[^>]*\bshow=["'](?:0|false)["']/i.test(xml);
  const rels = parseRelationships(archive, getRelsPathForPart(slidePath), slidePath);
  const chartRelationships = getChartRelationships(archive, slidePath).map((rel, index) => ({
    index,
    relationshipId: rel.id,
    sourcePart: rel.targetPath,
    title: extractChartTitle(parseXml(readArchiveText(archive, rel.targetPath))),
  }));
  const detection = detectPlaceholdersInDocument(doc, slidePath, "slide", {
    slideNumber: slideIndex + 1,
    chartRelationship: null,
  });
  const notesRel = getNotesRelationship(archive, slidePath);
  const notesText = notesRel?.targetPath ? normalizeText(getNodeText(parseXml(readArchiveText(archive, notesRel.targetPath)))) : "";

  return {
    slideNumber: slideIndex + 1,
    sourcePart: slidePath,
    sourceSlideNumber: getSlideNumberFromPath(slidePath) || slideIndex + 1,
    hidden,
    title: detection.slideTitle,
    notes: {
      sourcePart: notesRel?.targetPath || "",
      text: notesText,
      hasNotes: Boolean(notesText),
    },
    elements: {
      ...detection.elementSummary,
      charts: detection.elementSummary.charts.map((chart) => ({
        ...chart,
        relationship: chartRelationships[chart.index] || null,
      })),
    },
    placeholders: detection.placeholders,
    relationships: Object.values(rels).map((rel) => ({
      id: rel.id,
      type: rel.type,
      targetPath: rel.targetPath,
    })),
  };
}

function parseGenericXmlPart({ archive, path, partType }) {
  const doc = parseXml(readArchiveText(archive, path));
  if (!doc) return { placeholders: [], text: "", sourcePart: path, partType };
  const detection = detectPlaceholdersInDocument(doc, path, partType, {});
  return {
    sourcePart: path,
    partType,
    text: normalizeText(getNodeText(doc)),
    placeholders: detection.placeholders.map((placeholder) => ({
      ...placeholder,
      slideNumber: null,
    })),
  };
}

function classifyPart(path = "") {
  if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(path)) return "masterSlide";
  if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(path)) return "slideLayout";
  if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(path)) return "notes";
  if (/^ppt\/charts\/chart\d+\.xml$/.test(path)) return "chart";
  return "";
}

function buildTemplateSignature({ file, slideCount, placeholders }) {
  return hashString([
    file?.name || "",
    file?.size || "",
    slideCount,
    placeholders.map((placeholder) => normalizeComparableText(placeholder.surroundingText)).join("|"),
  ].join("::"));
}

export function createEmptyTemplateIntelligenceState() {
  return {
    version: TEMPLATE_INTELLIGENCE_VERSION,
    status: "idle",
    fileMeta: null,
    analysis: null,
    mappings: {},
    validationReport: null,
    progressMessage: "",
    error: "",
    updatedAt: "",
  };
}

export function serializeTemplateIntelligenceState(state) {
  if (!state || typeof state !== "object") return createEmptyTemplateIntelligenceState();
  const analysis = state.analysis
    ? {
      ...state.analysis,
      archiveEntries: undefined,
      sourceBytes: undefined,
    }
    : null;
  return {
    ...createEmptyTemplateIntelligenceState(),
    ...state,
    analysis,
    financialSnapshot: undefined,
  };
}

export async function analyzeCustomPptxTemplate(file) {
  if (!file) throw new Error("Upload a PowerPoint template first.");
  const isPptx = /\.pptx$/i.test(file.name || "") || file.type === PPTX_MIME || !file.type;
  if (!isPptx) throw new Error("Please upload a .pptx PowerPoint template.");

  const sourceBytes = new Uint8Array(await file.arrayBuffer());
  const archiveEntries = unzipSync(sourceBytes);
  const slidePaths = getPresentationSlidePaths(archiveEntries);
  const slides = slidePaths
    .map((slidePath, index) => parseSlidePart({ archive: archiveEntries, slidePath, slideIndex: index }))
    .filter(Boolean);

  const relatedParts = Object.keys(archiveEntries)
    .map((path) => ({ path, partType: classifyPart(path) }))
    .filter((entry) => entry.partType && !slidePaths.includes(entry.path))
    .map((entry) => parseGenericXmlPart({ archive: archiveEntries, path: entry.path, partType: entry.partType }));

  const slidePlaceholders = slides.flatMap((slide) => slide.placeholders);
  const relatedPlaceholders = relatedParts.flatMap((part) => part.placeholders);
  const placeholders = [...slidePlaceholders, ...relatedPlaceholders].map((placeholder, index) => ({
    ...placeholder,
    ordinal: index + 1,
    textNodes: undefined,
  }));

  const signature = buildTemplateSignature({ file, slideCount: slides.length, placeholders });
  const schema = {
    version: TEMPLATE_INTELLIGENCE_VERSION,
    generatedAt: new Date().toISOString(),
    slides: slides.map((slide) => ({
      slideNumber: slide.slideNumber,
      sourceSlideNumber: slide.sourceSlideNumber,
      hidden: slide.hidden,
      title: slide.title,
      sourcePart: slide.sourcePart,
      notes: slide.notes,
      elements: slide.elements,
      placeholders: slide.placeholders.map((placeholder) => normalizePlaceholderForSchema(placeholder)),
    })),
    relatedParts: relatedParts.map((part) => ({
      sourcePart: part.sourcePart,
      partType: part.partType,
      placeholderCount: part.placeholders.length,
      placeholders: part.placeholders.map((placeholder) => normalizePlaceholderForSchema(placeholder)),
    })),
  };

  return {
    version: TEMPLATE_INTELLIGENCE_VERSION,
    engine: {
      parser: "Template Parser",
      placeholderDetector: "Placeholder Detector",
      semanticMappingEngine: "Semantic Mapping Engine",
      financialDataMapper: "Financial Data Mapper",
      aiContextAnalyzer: "AI Context Analyzer",
      questionnaireGenerator: "Questionnaire Generator",
      learningEngine: "Template Learning Engine",
      validationEngine: "Validation Engine",
      presentationGenerator: "Presentation Generator",
    },
    template: {
      id: signature,
      fileName: file.name || "custom-template.pptx",
      fileSize: file.size || sourceBytes.length,
      lastModified: file.lastModified || null,
      slideCount: slides.length,
      hiddenSlideCount: slides.filter((slide) => slide.hidden).length,
      masterSlideCount: relatedParts.filter((part) => part.partType === "masterSlide").length,
      notesSlideCount: slides.filter((slide) => slide.notes?.hasNotes).length,
      chartCount: slides.reduce((sum, slide) => sum + (slide.elements?.charts?.length || 0), 0),
      tableCount: slides.reduce((sum, slide) => sum + (slide.elements?.tables?.length || 0), 0),
      imageCount: slides.reduce((sum, slide) => sum + (slide.elements?.images?.length || 0), 0),
      logoCount: slides.reduce((sum, slide) => sum + (slide.elements?.logos?.length || 0), 0),
      iconCount: slides.reduce((sum, slide) => sum + (slide.elements?.icons?.length || 0), 0),
      groupedObjectCount: slides.reduce((sum, slide) => sum + (slide.elements?.groupedObjects?.length || 0), 0),
      smartArtCount: slides.reduce((sum, slide) => sum + (slide.elements?.smartArt?.length || 0), 0),
      placeholderCount: placeholders.length,
    },
    slides,
    relatedParts,
    placeholders,
    schema,
    archiveEntries,
    sourceBytes,
    analyzedAt: new Date().toISOString(),
  };
}

function normalizePlaceholderForSchema(placeholder) {
  return {
    slideNumber: placeholder.slideNumber,
    placeholderText: placeholder.placeholderText,
    placeholderType: inferPlaceholderType(placeholder),
    semanticMeaning: "",
    expectedDataType: "",
    mappingConfidence: 0,
    selectedDataSource: "",
    validationRules: [],
    formattingRules: inferFormattingRules(placeholder),
    slideCoordinates: placeholder.slideCoordinates,
    fontInformation: placeholder.fontInformation,
    colorInformation: placeholder.colorInformation,
    tableChartRelationships: placeholder.tableChartRelationships,
    sourcePart: placeholder.sourcePart,
    paragraphText: placeholder.paragraphText,
    surroundingText: placeholder.surroundingText,
  };
}

function inferPlaceholderType(placeholder) {
  const text = `${placeholder.placeholderText || ""} ${placeholder.surroundingText || ""}`;
  if (/%/.test(text)) return "percentage";
  if (/[$₹€£]|\bM\b|\bMM\b|\bmm\b/i.test(text)) return "currency";
  if (/FY\d{2,4}|fiscal year|period|date/i.test(text)) return "period";
  if (/\b(count|number|employees|customers|headcount|fte)\b/i.test(text)) return "number";
  return "text";
}

function inferFormattingRules(placeholder) {
  const rules = [];
  if (placeholder.prefix) rules.push({ kind: "prefix", value: placeholder.prefix });
  if (placeholder.suffix) rules.push({ kind: "suffix", value: placeholder.suffix });
  if (placeholder.suffix === "%") rules.push({ kind: "percentSymbolOutsidePlaceholder", value: true });
  if (/M|MM|mm/.test(placeholder.suffix || "") || placeholder.prefix === "$") {
    rules.push({ kind: "millionsScale", value: true });
  }
  return rules;
}

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[$,%(),]/g, ""));
  if (!Number.isFinite(numeric)) return fallback;
  return String(value).includes("(") ? -Math.abs(numeric) : numeric;
}

function getLatestYear(snapshot = {}) {
  return snapshot.latestYear || snapshot.years?.[snapshot.years.length - 1] || new Date().getFullYear();
}

function getYearMetrics(snapshot = {}, year = null) {
  const targetYear = year || getLatestYear(snapshot);
  return snapshot.metricsByYear?.[targetYear] || snapshot.metricsByYear?.[String(targetYear)] || snapshot.trailingMetrics || {};
}

function parseFyYears(text = "") {
  const years = [];
  String(text || "").replace(/FY\s*'?(\d{2,4})/gi, (_, rawYear) => {
    const numeric = Number(rawYear);
    if (!Number.isFinite(numeric)) return "";
    years.push(numeric < 100 ? 2000 + numeric : numeric);
    return "";
  });
  return Array.from(new Set(years)).sort((a, b) => a - b);
}

function calculateGrowth(snapshot, metricKey, year = null) {
  const years = [...(snapshot.years || [])].sort((a, b) => Number(a) - Number(b));
  const latestYear = year || getLatestYear(snapshot);
  const latestIndex = years.map(Number).indexOf(Number(latestYear));
  const previousYear = latestIndex > 0 ? years[latestIndex - 1] : years[years.length - 2];
  const currentValue = toNumber(getYearMetrics(snapshot, latestYear)?.[metricKey], 0);
  const previousValue = toNumber(getYearMetrics(snapshot, previousYear)?.[metricKey], 0);
  if (!previousValue) return null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

function calculateCagr(snapshot, metricKey, years = []) {
  const availableYears = [...(snapshot.years || [])].sort((a, b) => Number(a) - Number(b));
  const selectedYears = years.length >= 2 ? years : availableYears;
  if (selectedYears.length < 2) return null;
  const firstYear = selectedYears[0];
  const lastYear = selectedYears[selectedYears.length - 1];
  const firstValue = toNumber(getYearMetrics(snapshot, firstYear)?.[metricKey], 0);
  const lastValue = toNumber(getYearMetrics(snapshot, lastYear)?.[metricKey], 0);
  const periods = Number(lastYear) - Number(firstYear);
  if (firstValue <= 0 || lastValue <= 0 || periods <= 0) return null;
  return (Math.pow(lastValue / firstValue, 1 / periods) - 1) * 100;
}

function calculateFcfConversion(snapshot) {
  const latest = snapshot.trailingMetrics || getYearMetrics(snapshot);
  const fcf = toNumber(latest.freeCashFlow, 0);
  const ebitda = toNumber(latest.adjustedEbitda || latest.ebitda, 0);
  return ebitda ? (fcf / ebitda) * 100 : null;
}

function formatNumber(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const fixed = numeric.toFixed(digits);
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
}

function formatPeriodRange(snapshot, contextYears = []) {
  const years = contextYears.length >= 2 ? contextYears : snapshot.years || [];
  if (!years.length) return "";
  const first = years[0];
  const last = years[years.length - 1];
  return first === last ? `FY${String(last).slice(-2)}` : `FY${String(first).slice(-2)}-FY${String(last).slice(-2)}`;
}

function formatMappedValue({ value, expectedDataType, placeholder }) {
  if (value === null || value === undefined || value === "") return "";
  if (expectedDataType === "percentage") {
    const formatted = formatNumber(value, 1);
    return placeholder?.suffix === "%" ? formatted : `${formatted}%`;
  }
  if (expectedDataType === "currency") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    const scaled = /M|MM|mm/i.test(placeholder?.suffix || "") || placeholder?.prefix === "$"
      ? numeric / 1_000_000
      : numeric;
    const formatted = Math.abs(scaled) >= 100 ? formatNumber(scaled, 0) : formatNumber(scaled, 1);
    return placeholder?.prefix || placeholder?.suffix ? formatted : `$${formatted}M`;
  }
  if (expectedDataType === "number") return formatNumber(value, Number(value) % 1 === 0 ? 0 : 1);
  return String(value);
}

function scoreRule(rule, context) {
  const normalized = normalizeComparableText(context);
  const keywordScore = (rule.keywords || []).some((keyword) => normalized.includes(normalizeComparableText(keyword))) ? 0.64 : 0;
  const requiredScore = (rule.requiredAny || []).length
    ? (rule.requiredAny.some((keyword) => normalized.includes(normalizeComparableText(keyword))) ? 0.24 : -0.24)
    : 0.12;
  const tableScore = /\b(row|column|header|table)\b/.test(normalized) ? 0.02 : 0;
  return keywordScore + requiredScore + tableScore;
}

function findSemanticRule(placeholder, learning = {}) {
  const context = `${placeholder.surroundingText || ""} ${placeholder.paragraphText || ""}`;
  const learned = findLearnedMapping(placeholder, learning);
  if (learned) {
    return {
      ...learned,
      fromLearning: true,
      score: Math.max(0.84, Number(learned.confidence || 0.84)),
    };
  }

  const matches = SEMANTIC_RULES
    .map((rule) => ({ ...rule, score: scoreRule(rule, context) }))
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score);

  if (matches[0]) return matches[0];

  const type = inferPlaceholderType(placeholder);
  if (type === "period") {
    return {
      semanticMeaning: "Fiscal Period",
      metricKey: "periodRange",
      expectedDataType: "period",
      sourceHints: ["Selected reporting period"],
      score: 0.82,
    };
  }

  return {
    semanticMeaning: "Unresolved Template Placeholder",
    metricKey: "",
    expectedDataType: type,
    sourceHints: [],
    score: 0,
  };
}

function resolveMetricValue({ rule, placeholder, snapshot = {}, globalDetails = {}, company = null }) {
  const contextYears = parseFyYears(`${placeholder.placeholderText || ""} ${placeholder.surroundingText || ""}`);
  const latest = snapshot.trailingMetrics || getYearMetrics(snapshot);
  const currentPeriod = snapshot.currentPeriod || {};

  if (rule.metricKey === "periodRange") {
    return formatPeriodRange(snapshot, contextYears);
  }
  if (rule.metricKey === "revenueCagr") {
    return calculateCagr(snapshot, "totalRevenue", contextYears);
  }
  if (rule.metricKey === "revenueGrowth") {
    return calculateGrowth(snapshot, "totalRevenue", contextYears.at(-1));
  }
  if (rule.metricKey === "fcfConversion") {
    return calculateFcfConversion(snapshot);
  }
  if (rule.metricKey === "companyName") {
    return globalDetails.companyName || globalDetails.companyLegalName || company?.name || "";
  }
  if (rule.metricKey && Object.prototype.hasOwnProperty.call(latest || {}, rule.metricKey)) {
    return latest[rule.metricKey];
  }
  if (rule.metricKey && currentPeriod?.[rule.metricKey]) {
    return currentPeriod[rule.metricKey];
  }
  return "";
}

function getSourceLabel(snapshot = {}, rule = {}) {
  const sourceLedger = snapshot.validation?.sourceLedger;
  const base = sourceLedger?.sourceLabel || snapshot.sourceKey || "Financial reports";
  const hints = (rule.sourceHints || []).filter(Boolean);
  return [base, ...hints].join("; ");
}

function getConfidence({ rule, rawValue, snapshot }) {
  if (!rule.metricKey) return 0.28;
  let confidence = Number(rule.score || 0.64);
  if (rule.fromLearning) confidence += 0.08;
  if (rawValue !== "" && rawValue !== null && rawValue !== undefined) confidence += 0.12;
  if (snapshot.validation?.sourceLedger?.verified) confidence += 0.06;
  if (snapshot.validation?.summary?.sourceWarnings) confidence -= 0.06;
  if (snapshot.validation?.summary?.discrepancies) confidence -= 0.08;
  if (rawValue === "" || rawValue === null || rawValue === undefined) confidence = Math.min(confidence, 0.54);
  return Math.max(0, Math.min(0.98, confidence));
}

function buildMappingForPlaceholder({ placeholder, snapshot, globalDetails, company, learning }) {
  const rule = findSemanticRule(placeholder, learning);
  const rawValue = resolveMetricValue({ rule, placeholder, snapshot, globalDetails, company });
  const expectedDataType = rule.expectedDataType || inferPlaceholderType(placeholder);
  const value = formatMappedValue({ value: rawValue, expectedDataType, placeholder });
  const confidence = getConfidence({ rule, rawValue, snapshot });
  const status = value && confidence >= TEMPLATE_MAPPING_CONFIDENCE_THRESHOLD ? "auto_filled" : "needs_review";

  return {
    id: placeholder.id,
    placeholderId: placeholder.id,
    slideNumber: placeholder.slideNumber,
    sourcePart: placeholder.sourcePart,
    placeholderText: placeholder.placeholderText,
    tokenText: placeholder.tokenText,
    semanticMeaning: rule.semanticMeaning,
    metricKey: rule.metricKey,
    expectedDataType,
    value,
    suggestedValue: value,
    rawValue,
    mappingConfidence: confidence,
    selectedDataSource: getSourceLabel(snapshot, rule),
    validationRules: buildValidationRules(expectedDataType, placeholder),
    formattingRules: inferFormattingRules(placeholder),
    slideCoordinates: placeholder.slideCoordinates,
    fontInformation: placeholder.fontInformation,
    colorInformation: placeholder.colorInformation,
    tableChartRelationships: placeholder.tableChartRelationships,
    contextSignature: placeholder.contextSignature,
    surroundingText: placeholder.surroundingText,
    status,
    approved: false,
    ignored: false,
    sourceFreshness: snapshot.currentPeriod?.endDate || "",
    updatedAt: new Date().toISOString(),
  };
}

function buildValidationRules(expectedDataType, placeholder) {
  const rules = [];
  if (expectedDataType === "percentage") rules.push({ kind: "numeric", min: -100, max: 1000 });
  if (expectedDataType === "currency") rules.push({ kind: "numeric" });
  if (expectedDataType === "number") rules.push({ kind: "numeric" });
  if (placeholder.suffix === "%") rules.push({ kind: "preservePercentSuffix", value: true });
  return rules;
}

export function mapTemplatePlaceholders({
  analysis,
  financialSnapshot = {},
  globalDetails = {},
  company = null,
  learning = {},
} = {}) {
  const placeholders = analysis?.placeholders || [];
  const mappings = {};

  placeholders.forEach((placeholder) => {
    const mapping = buildMappingForPlaceholder({
      placeholder,
      snapshot: financialSnapshot || {},
      globalDetails,
      company,
      learning,
    });
    mappings[placeholder.id] = mapping;
  });

  return mappings;
}

function parseMappedNumeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(String(value).replace(/[$,%(),]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return String(value).includes("(") ? -Math.abs(numeric) : numeric;
}

export function createTemplateValidationReport({ analysis, mappings = {}, financialSnapshot = {} } = {}) {
  const mappingList = Object.values(mappings || {});
  const unresolved = mappingList.filter((mapping) => (
    !mapping.ignored &&
    (!normalizeText(mapping.value) || mapping.status === "needs_review" || mapping.mappingConfidence < TEMPLATE_MAPPING_CONFIDENCE_THRESHOLD)
  ));
  const autoFilled = mappingList.filter((mapping) => mapping.status === "auto_filled" && normalizeText(mapping.value));
  const manualResponses = mappingList.filter((mapping) => mapping.approved || mapping.status === "manual");
  const warnings = [];

  const bySemantic = new Map();
  mappingList.forEach((mapping) => {
    if (!mapping.metricKey || !normalizeText(mapping.value) || mapping.ignored) return;
    const key = `${mapping.metricKey}:${mapping.expectedDataType}`;
    const current = bySemantic.get(key) || [];
    current.push(mapping);
    bySemantic.set(key, current);
  });

  bySemantic.forEach((items, key) => {
    const numericValues = items.map((item) => parseMappedNumeric(item.value)).filter((value) => value !== null);
    if (numericValues.length < 2) return;
    const min = Math.min(...numericValues);
    const max = Math.max(...numericValues);
    if (Math.abs(max - min) > Math.max(0.2, Math.abs(max) * 0.015)) {
      warnings.push({
        id: `consistency:${key}`,
        severity: "warning",
        message: `${items[0].semanticMeaning} has inconsistent values across placeholders.`,
        placeholders: items.map((item) => item.placeholderId),
      });
    }
  });

  (financialSnapshot.validation?.issues || []).forEach((issue, index) => {
    warnings.push({
      id: `financial:${issue.id || index}`,
      severity: issue.status === "discrepancy" ? "warning" : "info",
      message: issue.message || issue.label || "Financial validation item requires review.",
      sources: issue.sources || [],
    });
  });

  const duplicateValues = new Map();
  mappingList.forEach((mapping) => {
    const value = normalizeComparableText(mapping.value);
    if (!value || mapping.ignored) return;
    const list = duplicateValues.get(value) || [];
    list.push(mapping);
    duplicateValues.set(value, list);
  });
  duplicateValues.forEach((items, value) => {
    const semantics = new Set(items.map((item) => item.semanticMeaning));
    if (items.length > 2 && semantics.size > 1) {
      warnings.push({
        id: `duplicate:${hashString(value)}`,
        severity: "info",
        message: "The same value is used for multiple different placeholder meanings.",
        placeholders: items.map((item) => item.placeholderId),
      });
    }
  });

  const confidenceScore = mappingList.length
    ? mappingList.reduce((sum, mapping) => sum + Number(mapping.mappingConfidence || 0), 0) / mappingList.length
    : 0;

  return {
    version: TEMPLATE_INTELLIGENCE_VERSION,
    generatedAt: new Date().toISOString(),
    templateId: analysis?.template?.id || "",
    summary: {
      placeholderCount: mappingList.length,
      autoFilled: autoFilled.length,
      manualResponses: manualResponses.length,
      missing: unresolved.length,
      unresolved: unresolved.length,
      ignored: mappingList.filter((mapping) => mapping.ignored).length,
      warnings: warnings.length,
      confidenceScore,
    },
    autoFilledPlaceholders: autoFilled.map(summarizeMapping),
    manualResponses: manualResponses.map(summarizeMapping),
    missingPlaceholders: unresolved.map(summarizeMapping),
    confidenceByMapping: mappingList.map((mapping) => ({
      placeholderId: mapping.placeholderId,
      slideNumber: mapping.slideNumber,
      semanticMeaning: mapping.semanticMeaning,
      confidence: mapping.mappingConfidence,
      source: mapping.selectedDataSource,
    })),
    warnings,
    financialInconsistencies: warnings.filter((warning) => warning.id.startsWith("financial:") || warning.id.startsWith("consistency:")),
  };
}

function summarizeMapping(mapping) {
  return {
    placeholderId: mapping.placeholderId,
    slideNumber: mapping.slideNumber,
    placeholderText: mapping.placeholderText,
    semanticMeaning: mapping.semanticMeaning,
    value: mapping.value,
    confidence: mapping.mappingConfidence,
    source: mapping.selectedDataSource,
    status: mapping.status,
  };
}

function replaceRangeInTextNodes(textNodes, start, end, replacement) {
  const affected = textNodes.filter((entry) => entry.end > start && entry.start < end);
  if (!affected.length) return;
  const first = affected[0];
  const last = affected[affected.length - 1];

  if (first === last) {
    const current = first.node.textContent || "";
    const relativeStart = Math.max(0, start - first.start);
    const relativeEnd = Math.max(relativeStart, end - first.start);
    first.node.textContent = `${current.slice(0, relativeStart)}${replacement}${current.slice(relativeEnd)}`;
    return;
  }

  affected.forEach((entry, index) => {
    const current = entry.node.textContent || "";
    if (index === 0) {
      const relativeStart = Math.max(0, start - entry.start);
      entry.node.textContent = `${current.slice(0, relativeStart)}${replacement}`;
      return;
    }
    if (entry === last) {
      const relativeEnd = Math.max(0, end - entry.start);
      entry.node.textContent = current.slice(relativeEnd);
      return;
    }
    entry.node.textContent = "";
  });
}

function applyMappingsToDocument(doc, partPath, mappingsById) {
  const detection = detectPlaceholdersInDocument(doc, partPath, classifyPart(partPath) || "slide", {});
  const scoped = detection.placeholders
    .map((placeholder) => ({
      placeholder,
      mapping: mappingsById[placeholder.id],
    }))
    .filter(({ mapping }) => mapping && !mapping.ignored && normalizeText(mapping.value))
    .sort((a, b) => b.placeholder.tokenStart - a.placeholder.tokenStart);

  scoped.forEach(({ placeholder, mapping }) => {
    replaceRangeInTextNodes(placeholder.textNodes, placeholder.tokenStart, placeholder.tokenEnd, mapping.value);
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function buildCustomTemplatePptxBlob({ analysis, mappings = {} } = {}) {
  if (!analysis?.archiveEntries) {
    throw new Error("Re-upload the custom template before generating the final PowerPoint.");
  }
  const files = { ...analysis.archiveEntries };
  const mappingList = Array.isArray(mappings) ? mappings : Object.values(mappings || {});
  const mappingsById = Object.fromEntries(mappingList.map((mapping) => [mapping.placeholderId || mapping.id, mapping]));
  const parts = Array.from(new Set(mappingList.map((mapping) => mapping.sourcePart).filter(Boolean)));

  parts.forEach((partPath) => {
    const doc = parseXml(readArchiveText(files, partPath));
    if (!doc) return;
    applyMappingsToDocument(doc, partPath, mappingsById);
    files[partPath] = strToU8(serializeXml(doc));
  });

  return new Blob([zipSync(files, { level: 6 })], { type: PPTX_MIME });
}

export function generateCustomTemplatePptx({ analysis, mappings, filename = "custom-cim.pptx" } = {}) {
  const blob = buildCustomTemplatePptxBlob({ analysis, mappings });
  downloadBlob(blob, filename);
  return blob;
}

export function downloadTemplateSchemaJson({ analysis, mappings = {}, validationReport = null, filename = "template-schema.json" } = {}) {
  const mappingById = mappings || {};
  const schema = {
    ...(analysis?.schema || {}),
    placeholders: (analysis?.placeholders || []).map((placeholder) => {
      const mapping = mappingById[placeholder.id] || {};
      return {
        ...normalizePlaceholderForSchema(placeholder),
        semanticMeaning: mapping.semanticMeaning || "",
        expectedDataType: mapping.expectedDataType || "",
        mappingConfidence: mapping.mappingConfidence || 0,
        selectedDataSource: mapping.selectedDataSource || "",
        validationRules: mapping.validationRules || [],
        formattingRules: mapping.formattingRules || inferFormattingRules(placeholder),
      };
    }),
    validationReport,
  };
  const blob = new Blob([JSON.stringify(schema, null, 2)], { type: "application/json" });
  downloadBlob(blob, filename);
  return schema;
}

export function buildTemplateQuestionnaireItems({ mappings = {}, user = null } = {}) {
  const now = new Date().toISOString();
  return Object.values(mappings || {})
    .filter((mapping) => (
      !mapping.ignored &&
      (!normalizeText(mapping.value) ||
        mapping.status === "needs_review" ||
        Number(mapping.mappingConfidence || 0) < TEMPLATE_MAPPING_CONFIDENCE_THRESHOLD)
    ))
    .map((mapping) => ({
      id: `custom-template:${mapping.placeholderId}`,
      fieldId: `custom-template:${mapping.placeholderId}`,
      slideNumber: mapping.slideNumber,
      sectionId: "custom-template",
      sectionTitle: "Custom Template",
      label: `${mapping.placeholderText} · ${mapping.semanticMeaning || "Template placeholder"}`,
      fieldKind: "text",
      assetKey: null,
      prompt: buildQuestionPrompt(mapping),
      sourceText: mapping.surroundingText,
      status: "open",
      archived: false,
      createdAt: now,
      requestedAt: now,
      updatedAt: now,
      updatedBy: user ? { id: user.id || null, name: user.name || user.email || "Broker", email: user.email || "" } : null,
      templatePlaceholderId: mapping.placeholderId,
      customTemplate: true,
    }));
}

function buildQuestionPrompt(mapping) {
  const source = mapping.selectedDataSource ? ` Suggested source: ${mapping.selectedDataSource}.` : "";
  const confidence = Number.isFinite(Number(mapping.mappingConfidence))
    ? ` Current confidence: ${Math.round(Number(mapping.mappingConfidence) * 100)}%.`
    : "";
  return `Confirm the value for ${mapping.placeholderText} on slide ${mapping.slideNumber || "template"} (${mapping.semanticMeaning || "unresolved placeholder"}).${source}${confidence}`;
}

function loadAllLearning() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(LEARNING_STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveAllLearning(store) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LEARNING_STORAGE_KEY, JSON.stringify(store || {}));
}

export function loadTemplateLearning(companyId = "default") {
  const store = loadAllLearning();
  return {
    global: store.global || {},
    company: store.companies?.[companyId] || {},
  };
}

function findLearnedMapping(placeholder, learning = {}) {
  const signature = placeholder.contextSignature;
  if (!signature) return null;
  return learning.company?.[signature] || learning.global?.[signature] || null;
}

export function saveApprovedTemplateMappings({ companyId = "default", analysis, mappings = {} } = {}) {
  const approved = Object.values(mappings || {}).filter((mapping) => mapping.approved && mapping.contextSignature && mapping.metricKey);
  if (!approved.length) return loadTemplateLearning(companyId);

  const store = loadAllLearning();
  const companies = { ...(store.companies || {}) };
  const companyLearning = { ...(companies[companyId] || {}) };
  const globalLearning = { ...(store.global || {}) };

  approved.forEach((mapping) => {
    const entry = {
      templateId: analysis?.template?.id || "",
      semanticMeaning: mapping.semanticMeaning,
      metricKey: mapping.metricKey,
      expectedDataType: mapping.expectedDataType,
      selectedDataSource: mapping.selectedDataSource,
      confidence: Math.max(TEMPLATE_MAPPING_CONFIDENCE_THRESHOLD, Number(mapping.mappingConfidence || 0)),
      formattingRules: mapping.formattingRules || [],
      approvedAt: new Date().toISOString(),
    };
    companyLearning[mapping.contextSignature] = entry;
    globalLearning[mapping.contextSignature] = entry;
  });

  companies[companyId] = companyLearning;
  saveAllLearning({ ...store, global: globalLearning, companies });
  return loadTemplateLearning(companyId);
}

export function updateMappingValue(mappings = {}, placeholderId, value, patch = {}) {
  const current = mappings[placeholderId];
  if (!current) return mappings;
  return {
    ...mappings,
    [placeholderId]: {
      ...current,
      value,
      status: normalizeText(value) ? "manual" : "needs_review",
      mappingConfidence: patch.mappingConfidence ?? Math.max(Number(current.mappingConfidence || 0), 0.82),
      approved: patch.approved ?? current.approved,
      ignored: patch.ignored ?? false,
      updatedAt: new Date().toISOString(),
      ...patch,
    },
  };
}

export function getTemplateAnalysisSummary(state = {}) {
  const analysis = state.analysis || {};
  const report = state.validationReport || {};
  const summary = report.summary || {};
  return {
    slideCount: analysis.template?.slideCount || 0,
    placeholderCount: analysis.template?.placeholderCount || 0,
    autoFilled: summary.autoFilled || 0,
    unresolved: summary.unresolved || 0,
    warnings: summary.warnings || 0,
    confidenceScore: summary.confidenceScore || 0,
  };
}

export const TemplateParser = Object.freeze({
  analyzeCustomPptxTemplate,
});

export const PlaceholderDetector = Object.freeze({
  detectPlaceholdersInDocument,
});

export const SemanticMappingEngine = Object.freeze({
  mapTemplatePlaceholders,
});

export const FinancialDataMapper = Object.freeze({
  mapTemplatePlaceholders,
});

export const AIContextAnalyzer = Object.freeze({
  findSemanticRule,
});

export const QuestionnaireGenerator = Object.freeze({
  buildTemplateQuestionnaireItems,
});

export const TemplateLearningEngine = Object.freeze({
  loadTemplateLearning,
  saveApprovedTemplateMappings,
});

export const ValidationEngine = Object.freeze({
  createTemplateValidationReport,
});

export const PresentationGenerator = Object.freeze({
  generateCustomTemplatePptx,
  buildCustomTemplatePptxBlob,
});
