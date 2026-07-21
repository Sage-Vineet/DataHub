import { strToU8, zipSync } from "fflate";
import { normalizeCimStyleProfile } from "./cimTemplateStyleProfiles";

const EMU_PER_PX = 9525;
// Font sizes in the layout data are authored in the same 96-DPI canvas-px unit as bbox
// coordinates (the browser preview renders them as literal CSS px). OOXML's <a:rPr sz="">
// is always hundredths of a POINT, never px, so every font size must go through this same
// 96-DPI conversion (1px = 0.75pt) that toEmu() already applies to positions/sizes —
// otherwise exported text renders ~33% larger than the preview, which is what was pushing
// single-line titles onto a second line and overlapping the content below them.
const PX_TO_PT = 0.75;
const SLIDE_WIDTH_PX = 1280;
const SLIDE_HEIGHT_PX = 720;
const SLIDE_WIDTH_EMU = SLIDE_WIDTH_PX * EMU_PER_PX;
const SLIDE_HEIGHT_EMU = SLIDE_HEIGHT_PX * EMU_PER_PX;

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseColor(value, fallback = "333333") {
  if (!value || value === "tx1") return fallback;
  const raw = String(value).trim();
  const hex = raw.match(/^#?([0-9a-f]{6})$/i);
  if (hex) return hex[1].toUpperCase();
  const rgba = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgba) {
    return [rgba[1], rgba[2], rgba[3]]
      .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  return fallback;
}

function parseDataUrl(dataUrl = "") {
  const match = String(dataUrl).match(/^data:([^,]+),(.*)$/s);
  if (!match) return null;

  const metadata = match[1] || "";
  const [mimeType = "image/png", ...parameters] = metadata.split(";");
  const isBase64 = parameters.includes("base64");
  const payload = match[2] || "";
  let bytes;

  if (isBase64) {
    const binary = typeof atob === "function"
      ? atob(payload)
      : globalThis.Buffer.from(payload, "base64").toString("binary");
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
  } else {
    bytes = strToU8(decodeURIComponent(payload));
  }

  const extension =
    mimeType === "image/jpeg" ? "jpg" :
    mimeType === "image/svg+xml" ? "svg" :
    mimeType === "image/gif" ? "gif" :
    "png";

  const dimensions = getImageDimensions(bytes, mimeType);

  return { mimeType, extension, bytes, ...dimensions };
}

function readUint32Be(bytes, offset) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readUint16Be(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16Le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function decodeBytes(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
  return globalThis.Buffer.from(bytes).toString("utf8");
}

function parseSvgDimensions(bytes) {
  const svg = decodeBytes(bytes);
  const tag = svg.match(/<svg\b[^>]*>/i)?.[0] || "";
  const width = Number(tag.match(/\bwidth=["']?([0-9.]+)/i)?.[1] || 0);
  const height = Number(tag.match(/\bheight=["']?([0-9.]+)/i)?.[1] || 0);
  if (width > 0 && height > 0) return { width, height };

  const viewBox = tag.match(/\bviewBox=["']?([0-9.\-\s]+)["']?/i)?.[1]
    ?.trim()
    .split(/\s+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }

  return {};
}

function parseJpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return {};

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    const length = readUint16Be(bytes, offset + 2);
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);

    if (isSof && offset + 8 < bytes.length) {
      return {
        width: readUint16Be(bytes, offset + 7),
        height: readUint16Be(bytes, offset + 5),
      };
    }

    offset += Math.max(length + 2, 2);
  }

  return {};
}

function getImageDimensions(bytes, mimeType) {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return { width: readUint32Be(bytes, 16), height: readUint32Be(bytes, 20) };
  }
  if (mimeType === "image/jpeg") return parseJpegDimensions(bytes);
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return { width: readUint16Le(bytes, 6), height: readUint16Le(bytes, 8) };
  }
  if (mimeType === "image/svg+xml") return parseSvgDimensions(bytes);
  return {};
}

function getRuns(element) {
  return (element?.paragraphs || []).flatMap((paragraph) => paragraph.runs || []);
}

function getElementStyle(element) {
  const runs = getRuns(element);
  const firstRun = runs.find((run) => normalizeText(run.text)) || {};
  const firstParagraph = element.paragraphs?.[0] || {};
  const resolved = element.resolvedTextStyle || {};
  const paragraphStyle = firstParagraph.resolvedTextStyle || {};

  return {
    fontSize: Number(firstRun.fontSize || element.resolvedFontSize || 12) * PX_TO_PT,
    typeface: firstRun.typeface || resolved.typeface || "Calibri",
    bold: Boolean(firstRun.bold || runs.some((run) => run.bold)),
    italic: Boolean(firstRun.italic),
    underline: Boolean(firstRun.underline),
    color: parseColor(firstRun.color, "333333"),
    align: paragraphStyle.alignment || resolved.alignment || "left",
    vertical: resolved.verticalAlignment || "top",
    insets: resolved.insets || { top: 0, right: 0, bottom: 0, left: 0 },
    lineHeight: Number(paragraphStyle.lineSpacing || resolved.lineSpacing || 1.08),
    paragraphSpacing: Number(paragraphStyle.paragraphSpacing || resolved.paragraphSpacing || 0),
    letterSpacing: Number(firstRun.letterSpacing || 0),
    wrap: resolved.wrap !== false,
  };
}

function toEmu(value) {
  return Math.round(Number(value || 0) * EMU_PER_PX);
}

function fillXml(color) {
  if (!color) return "<a:noFill/>";
  return `<a:solidFill><a:srgbClr val="${parseColor(color)}"/></a:solidFill>`;
}

function lineXml(color, width = 0) {
  if (!color || Number(width || 0) <= 0) return "<a:ln><a:noFill/></a:ln>";
  return `<a:ln w="${Math.max(1, Math.round(Number(width) * EMU_PER_PX))}"><a:solidFill><a:srgbClr val="${parseColor(color, "A5A5A5")}"/></a:solidFill></a:ln>`;
}

function parseTableText(text = "", rows = 0, cols = 0) {
  const lines = String(text || "")
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matrix = lines.map((line) => line.split("|").map((cell) => cell.trim()));

  return Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: cols }, (_, colIndex) => matrix[rowIndex]?.[colIndex] ?? ""),
  );
}

function paragraphXml(text, style) {
  const align = style.align === "center" ? "ctr" : style.align === "right" ? "r" : "l";
  const lines = String(text || "").split(/\n/);
  const lineSpacing = Math.round(Math.max(0.85, Math.min(1.8, Number(style.lineHeight || 1.08))) * 100000);
  const paragraphSpacing = Math.round(Math.max(0, Math.min(28, Number(style.paragraphSpacing || 0))) * PX_TO_PT * 100);
  const letterSpacing = Math.round(Math.max(-0.5, Math.min(3, Number(style.letterSpacing || 0))) * 1000);

  return lines.map((line) => `
        <a:p>
          <a:pPr algn="${align}" marL="0" indent="0">
            <a:lnSpc><a:spcPct val="${lineSpacing}"/></a:lnSpc>
            <a:spcBef><a:spcPts val="0"/></a:spcBef>
            <a:spcAft><a:spcPts val="${paragraphSpacing}"/></a:spcAft>
          </a:pPr>
          <a:r>
            <a:rPr lang="en-US" sz="${Math.round(style.fontSize * 100)}"${style.bold ? ' b="1"' : ""}${style.italic ? ' i="1"' : ""}${style.underline ? ' u="sng"' : ""}${letterSpacing ? ` spc="${letterSpacing}"` : ""}>
              <a:solidFill><a:srgbClr val="${style.color}"/></a:solidFill>
              <a:latin typeface="${escapeXml(style.typeface)}"/>
            </a:rPr>
            <a:t>${escapeXml(line)}</a:t>
          </a:r>
          <a:endParaRPr lang="en-US" sz="${Math.round(style.fontSize * 100)}"/>
        </a:p>`).join("");
}

function shapeXml(element, index, text) {
  const [rawLeft = 0, rawTop = 0, rawWidth = 0, rawHeight = 0] = element.bbox || [];
  const isLine = rawWidth === 0 || rawHeight === 0;
  const left = toEmu(rawLeft);
  const top = toEmu(rawTop);
  const width = toEmu(isLine && rawWidth === 0 ? Math.max(rawWidth, 1) : rawWidth);
  const height = toEmu(isLine && rawHeight === 0 ? Math.max(rawHeight, 1) : rawHeight);
  const fillColor = isLine ? element.lineColor || element.fillColor : element.fillColor;
  const style = getElementStyle(element);
  const geometry = element.geometry === "ellipse" ? "ellipse" : "rect";
  const hasText = typeof text === "string" && text.length > 0;
  const insets = style.insets || {};
  const rotation = Number(element.rotation || 0);
  const rotationAttr = rotation ? ` rot="${Math.round(rotation * 60000)}"` : "";
  // Match the browser preview's text model exactly: a fixed-size box rendered at the
  // element's literal font size, with overflow clipped rather than auto-shrunk. The
  // previous universal normAutofit(65%) had no relationship to actual content length,
  // so short text rendered needlessly tiny while long text still overflowed its box —
  // producing a slide that looked structurally different from (and often overlapped
  // relative to) the in-app preview, which never shrinks text.
  const textBody = hasText
    ? `<p:txBody>
        <a:bodyPr wrap="${style.wrap === false ? "none" : "square"}" vertOverflow="clip" horzOverflow="clip" anchor="${style.vertical === "middle" ? "ctr" : style.vertical === "bottom" ? "b" : "t"}" lIns="${toEmu(insets.left)}" rIns="${toEmu(insets.right)}" tIns="${toEmu(insets.top)}" bIns="${toEmu(insets.bottom)}">
          <a:noAutofit/>
        </a:bodyPr>
        <a:lstStyle/>
        ${paragraphXml(text, style)}
      </p:txBody>`
    : "";

  return `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${index + 2}" name="${escapeXml(element.name || `Shape ${index + 1}`)}"/>
          <p:cNvSpPr${hasText ? ' txBox="1"' : ""}/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm${rotationAttr}>
            <a:off x="${left}" y="${top}"/>
            <a:ext cx="${Math.max(width, EMU_PER_PX)}" cy="${Math.max(height, EMU_PER_PX)}"/>
          </a:xfrm>
          <a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>
          ${fillXml(fillColor)}
          ${lineXml(isLine ? fillColor : element.lineColor, element.lineWidth)}
        </p:spPr>
        ${textBody}
      </p:sp>`;
}

function tableXml(element, index, text, content = {}, shapeTag = null) {
  const rows = Number(element.rows || 0);
  const cols = Number(element.cols || 0);
  const matrix = content.tableMatrix || parseTableText(text || element.text, rows, cols);
  const visibleRows = content.visibleTableRows || Array.from({ length: rows }, (_, rowIndex) => rowIndex + 1);
  const visibleColumns = content.visibleTableColumns || Array.from({ length: cols }, (_, colIndex) => colIndex + 1);
  const [sourceLeft = 0] = element.bbox || [];
  const [targetLeft = sourceLeft, targetTop = Number(element.bbox?.[1] || 0)] = content.bbox || element.bbox || [];
  const tableScaleX = Number(content.tableScaleX || 1);
  const sourceLabelWidth = Number(
    (element.cells || []).find((cell) => Number(cell.column || 1) === 1)?.bbox?.[2] || 0,
  );
  const compactValueWidth = visibleColumns.length > 1
    ? (Number(element.bbox?.[2] || 0) - sourceLabelWidth) / (visibleColumns.length - 1)
    : 0;

  return (element.cells || []).filter((cell) => (
    visibleRows.includes(Number(cell.row || 1)) &&
    visibleColumns.includes(Number(cell.column || 1))
  )).map((cell, cellIndex) => {
    const rowIndex = Number(cell.row || 1) - 1;
    const colIndex = Number(cell.column || 1) - 1;
    const matrixValue = matrix[rowIndex]?.[colIndex];
    const cellText = content.suppressTemplateFallback
      ? (matrixValue ?? "")
      : (matrixValue || cell.text || "");
    const [cellLeft = 0, cellTop = 0, cellWidth = 0, cellHeight = 0] = cell.bbox || [];
    const compactRowIndex = visibleRows.indexOf(Number(cell.row || 1));
    const compactColumnIndex = visibleColumns.indexOf(Number(cell.column || 1));
    const cellElement = {
      ...cell,
      bbox: [
        content.compactTableColumns
          ? targetLeft + (compactColumnIndex === 0
            ? 0
            : sourceLabelWidth + (compactColumnIndex - 1) * compactValueWidth)
          : targetLeft + (cellLeft - sourceLeft) * tableScaleX,
        content.compactTableRows ? targetTop + compactRowIndex * cellHeight : cellTop,
        content.compactTableColumns
          ? (compactColumnIndex === 0 ? sourceLabelWidth : compactValueWidth)
          : cellWidth * tableScaleX,
        cellHeight,
      ],
      aid: `${element.aid || element.id}/cell-${cell.index || cellIndex}`,
      id: `${element.id || index}-${cell.index || cellIndex}`,
      // Tagged with the table's shapeTag prefix (rather than a per-cell unique
      // name) so a downstream Aspose splice step can find and remove every
      // cell belonging to this table by prefix match before inserting a
      // native replacement at the same position.
      name: shapeTag
        ? `${shapeTag}::cell::${cell.index || cellIndex}`
        : `${element.name || "Table"} Cell ${cell.index || cellIndex + 1}`,
      geometry: "rect",
      lineColor: cell.lineColor || "#FFFFFF",
      lineWidth: cell.lineWidth ?? 0.7,
    };

    return shapeXml(cellElement, index * 100 + cellIndex, cellText);
  }).join("");
}

function getContainedImageBox(element, media = {}) {
  const [rawLeft = 0, rawTop = 0, rawWidth = 0, rawHeight = 0] = element.bbox || [];
  const imageWidth = Number(media.width || 0);
  const imageHeight = Number(media.height || 0);

  if (rawWidth <= 0 || rawHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    return { left: rawLeft, top: rawTop, width: rawWidth, height: rawHeight };
  }

  const boxAspect = rawWidth / rawHeight;
  const imageAspect = imageWidth / imageHeight;

  if (imageAspect > boxAspect) {
    const height = rawWidth / imageAspect;
    return {
      left: rawLeft,
      top: rawTop + (rawHeight - height) / 2,
      width: rawWidth,
      height,
    };
  }

  const width = rawHeight * imageAspect;
  return {
    left: rawLeft + (rawWidth - width) / 2,
    top: rawTop,
    width,
    height: rawHeight,
  };
}

function pictureXml(element, index, media, name = "Image") {
  const { left, top, width, height } = getContainedImageBox(element, media);
  const opacity = Math.max(0, Math.min(1, Number(element.opacity ?? element.imageOpacity ?? 1)));
  const alphaXml = opacity < 0.999 ? `<a:alphaModFix amt="${Math.round(opacity * 100000)}"/>` : "";
  const geometry = Number(element.imageCornerRadius || 0) > 0 ? "roundRect" : "rect";
  const rotation = Number(element.rotation || 0);
  const rotationAttr = rotation ? ` rot="${Math.round(rotation * 60000)}"` : "";
  const shadowXml = element.imageShadow
    ? `<a:effectLst><a:outerShdw blurRad="38100" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="18000"/></a:srgbClr></a:outerShdw></a:effectLst>`
    : "";

  return `
      <p:pic>
        <p:nvPicPr>
          <p:cNvPr id="${index + 2}" name="${escapeXml(name)}"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="${media.relationshipId}">${alphaXml}</a:blip>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm${rotationAttr}>
            <a:off x="${toEmu(left)}" y="${toEmu(top)}"/>
            <a:ext cx="${Math.max(toEmu(width), EMU_PER_PX)}" cy="${Math.max(toEmu(height), EMU_PER_PX)}"/>
          </a:xfrm>
          <a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom>
          ${lineXml(element.imageBorderColor || element.lineColor, element.imageBorderWidth ?? element.lineWidth ?? 0)}
          ${shadowXml}
        </p:spPr>
      </p:pic>`;
}

function slideBackgroundXml(layout) {
  const color = layout?.slide?.backgroundColor || "#FFFFFF";
  if (layout?.slide?.backgroundMode === "gradient") {
    const from = parseColor(layout.slide.gradientFrom || color, "FFFFFF");
    const to = parseColor(layout.slide.gradientTo || color, "F7F8FA");
    const angle = Math.round(Number(layout.slide.gradientAngle || 0) * 60000);
    return `
    <p:bg>
      <p:bgPr>
        <a:gradFill flip="none" rotWithShape="1">
          <a:gsLst>
            <a:gs pos="0"><a:srgbClr val="${from}"/></a:gs>
            <a:gs pos="100000"><a:srgbClr val="${to}"/></a:gs>
          </a:gsLst>
          <a:lin ang="${angle}" scaled="1"/>
        </a:gradFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>`;
  }

  return `
    <p:bg>
      <p:bgPr>
        <a:solidFill><a:srgbClr val="${parseColor(color, "FFFFFF")}"/></a:solidFill>
        <a:effectLst/>
      </p:bgPr>
    </p:bg>`;
}

function slideTransitionXml(layout) {
  const transition = layout?.slide?.transition;
  if (transition === "fade") return `<p:transition><p:fade/></p:transition>`;
  if (transition === "push-left") return `<p:transition><p:push dir="l"/></p:transition>`;
  if (transition === "wipe-right") return `<p:transition><p:wipe dir="r"/></p:transition>`;
  return "";
}

function hasSameBbox(first, second, tolerance = 1) {
  const firstBox = first?.bbox || [];
  const secondBox = second?.bbox || [];
  if (firstBox.length < 4 || secondBox.length < 4) return false;
  return firstBox.every((value, index) => Math.abs(Number(value || 0) - Number(secondBox[index] || 0)) <= tolerance);
}

function isLogoPlaceholderText(element) {
  return /^\[((advisor|adviser)|company)\s+logo\]$/i.test(normalizeText(element?.text));
}

function getMatchingLogoElement(elements, index) {
  const element = elements[index];
  if (!element || element.text) return null;
  return elements.slice(index + 1).find((candidate) =>
    isLogoPlaceholderText(candidate) && hasSameBbox(element, candidate),
  ) || null;
}

function isTopRightSlideNumberElement(element) {
  const clean = normalizeText(element?.text);
  if (!/^\d{1,3}$/.test(clean)) return false;
  const [left = 0, top = 0, width = 0, height = 0] = element.bbox || [];
  return left >= SLIDE_WIDTH_PX - 96 && top <= 48 && width <= 80 && height <= 40;
}

function normalizeContent(rawContent) {
  if (rawContent && typeof rawContent === "object") return rawContent;
  return { kind: "text", text: rawContent || "" };
}

function shouldSkipLogoPlaceholderShape(elements, index, slideRef, getElementContent) {
  const logoElement = getMatchingLogoElement(elements, index);
  if (!logoElement) return false;

  const logoContent = normalizeContent(getElementContent(slideRef, logoElement));
  return logoContent.kind === "image" && Boolean(logoContent.dataUrl);
}

function slideXml(layout, slideRef, displaySlideNumber, getElementContent, mediaAllocator) {
  const elements = layout?.elements || [];
  const sourceSlideNumber = typeof slideRef === "object" ? slideRef.sourceSlideNumber : slideRef;
  const backgroundImage = layout?.slide?.backgroundImage?.dataUrl
    ? mediaAllocator(layout.slide.backgroundImage.dataUrl)
    : null;
  const backgroundPicture = backgroundImage
    ? pictureXml({
        bbox: [0, 0, SLIDE_WIDTH_PX, SLIDE_HEIGHT_PX],
        opacity: layout.slide.backgroundImageOpacity,
      }, 9000, backgroundImage, "Slide background")
    : "";
  const shapes = elements
    .map((element, index) => {
      if (shouldSkipLogoPlaceholderShape(elements, index, slideRef, getElementContent)) {
        return "";
      }

      const content = isTopRightSlideNumberElement(element)
        ? { kind: "text", text: String(displaySlideNumber) }
        : normalizeContent(getElementContent(slideRef, element));
      if (content.kind === "hidden") return "";
      if (element.kind === "table" && Array.isArray(element.cells)) {
        // Tag matches buildNativeSpliceManifest()'s shapeTag derivation exactly
        // (physical slide position + source slide number + element order) so a
        // downstream Aspose splice pass can locate and replace this table.
        const tableTag = `__cim_table__${displaySlideNumber}_${sourceSlideNumber}_${element.order}`;
        return tableXml(element, index, content.text ?? element.text ?? "", content, tableTag);
      }
      const effectiveElement = content.bbox ? { ...element, bbox: content.bbox } : element;
      if ((content.kind === "image" || content.kind === "chart") && content.dataUrl) {
        const media = mediaAllocator(content.dataUrl);
        if (media) {
          const shapeName = content.kind === "chart"
            ? `__cim_chart__${displaySlideNumber}_${sourceSlideNumber}_${element.order}`
            : (content.name || content.alt || content.kind);
          return pictureXml(effectiveElement, index, media, shapeName);
        }
      }
      return shapeXml(effectiveElement, index, content.text ?? "");
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    ${slideBackgroundXml(layout)}
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      ${backgroundPicture}
      ${shapes}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
  ${slideTransitionXml(layout)}
</p:sld>`;
}

function slideRelXml(mediaRelationships = []) {
  const mediaXml = mediaRelationships.map((item) => (
    `<Relationship Id="${item.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${item.fileName}"/>`
  )).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  ${mediaXml}
</Relationships>`;
}

function contentTypesXml(slideCount, mediaExtensions = []) {
  const slideOverrides = Array.from({ length: slideCount }, (_, index) => (
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
  )).join("");
  const defaults = Array.from(new Set(mediaExtensions)).map((extension) => {
    const contentType =
      extension === "jpg" || extension === "jpeg" ? "image/jpeg" :
      extension === "svg" ? "image/svg+xml" :
      extension === "gif" ? "image/gif" :
      "image/png";
    return `<Default Extension="${extension}" ContentType="${contentType}"/>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${defaults}
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  ${slideOverrides}
</Types>`;
}

function presentationXml(slideCount) {
  const slideIds = Array.from({ length: slideCount }, (_, index) => (
    `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
  )).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="${SLIDE_WIDTH_EMU}" cy="${SLIDE_HEIGHT_EMU}" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
  <p:defaultTextStyle/>
</p:presentation>`;
}

function presentationRelsXml(slideCount) {
  const slideRels = Array.from({ length: slideCount }, (_, index) => (
    `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`
  )).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  ${slideRels}
</Relationships>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function appXml(slideCount) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>DataHub</Application>
  <PresentationFormat>Wide</PresentationFormat>
  <Slides>${slideCount}</Slides>
  <Company>DataHub</Company>
</Properties>`;
}

function coreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>CIM Prep</dc:title>
  <dc:creator>DataHub</dc:creator>
  <cp:lastModifiedBy>DataHub</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function slideMasterXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
  <p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles>
</p:sldMaster>`;
}

function slideMasterRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}

function slideLayoutXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}

function slideLayoutRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}

function themeXml(styleProfile) {
  const profile = styleProfile ? normalizeCimStyleProfile(styleProfile) : null;
  const colors = profile?.colors || {
    title: "#000000",
    background: "#FFFFFF",
    body: "#44546A",
    highlight: "#E7E6E6",
    secondary: "#8BC53D",
    primary: "#476E2C",
    accent: "#A5A5A5",
    muted: "#6D6E71",
    divider: "#243F18",
    tableAltRow: "#F7F8FA",
    hyperlink: "#0563C1",
  };
  const titleFont = profile?.isDefault
    ? "Calibri Light"
    : profile?.typography?.roles?.title?.fontFamily || "Calibri Light";
  const bodyFont = profile?.typography?.roles?.body?.fontFamily || "Calibri";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="DataHub CIM">
  <a:themeElements>
    <a:clrScheme name="DataHub CIM">
      <a:dk1><a:srgbClr val="${parseColor(colors.title, "000000")}"/></a:dk1><a:lt1><a:srgbClr val="${parseColor(colors.background, "FFFFFF")}"/></a:lt1>
      <a:dk2><a:srgbClr val="${parseColor(colors.body, "44546A")}"/></a:dk2><a:lt2><a:srgbClr val="${parseColor(colors.highlight, "E7E6E6")}"/></a:lt2>
      <a:accent1><a:srgbClr val="${parseColor(colors.secondary, "8BC53D")}"/></a:accent1><a:accent2><a:srgbClr val="${parseColor(colors.primary, "476E2C")}"/></a:accent2><a:accent3><a:srgbClr val="${parseColor(colors.accent, "A5A5A5")}"/></a:accent3>
      <a:accent4><a:srgbClr val="${parseColor(colors.muted, "6D6E71")}"/></a:accent4><a:accent5><a:srgbClr val="${parseColor(colors.divider, "243F18")}"/></a:accent5><a:accent6><a:srgbClr val="${parseColor(colors.tableAltRow, "F7F8FA")}"/></a:accent6>
      <a:hlink><a:srgbClr val="${parseColor(colors.hyperlink, "0563C1")}"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="${escapeXml(titleFont)}"/></a:majorFont><a:minorFont><a:latin typeface="${escapeXml(bodyFont)}"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`;
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

export function buildCimPptxBlob({ layouts, slideNumbers, getElementText, getElementContent, styleProfile }) {
  const resolveContent = getElementContent || ((slideNumber, element) => getElementText?.(slideNumber, element) || "");
  const mediaFiles = [];
  const slideMedia = {};

  slideNumbers.forEach((slideRef, index) => {
    const sourceSlideNumber = typeof slideRef === "object" ? slideRef.sourceSlideNumber : slideRef;
    const relationships = [];
    const allocateMedia = (dataUrl) => {
      const media = parseDataUrl(dataUrl);
      if (!media) return null;

      const mediaIndex = mediaFiles.length + 1;
      const relationshipId = `rId${relationships.length + 2}`;
      const fileName = `image${mediaIndex}.${media.extension}`;
      mediaFiles.push({ fileName, extension: media.extension, bytes: media.bytes });
      relationships.push({ relationshipId, fileName });
      return { relationshipId, fileName, width: media.width, height: media.height };
    };

    slideMedia[index + 1] = relationships;
    slideMedia[`xml${index + 1}`] = slideXml(
      layouts[sourceSlideNumber],
      slideRef,
      index + 1,
      resolveContent,
      allocateMedia,
    );
  });

  const files = {
    "[Content_Types].xml": strToU8(contentTypesXml(slideNumbers.length, mediaFiles.map((item) => item.extension))),
    "_rels/.rels": strToU8(rootRelsXml()),
    "docProps/app.xml": strToU8(appXml(slideNumbers.length)),
    "docProps/core.xml": strToU8(coreXml()),
    "ppt/presentation.xml": strToU8(presentationXml(slideNumbers.length)),
    "ppt/_rels/presentation.xml.rels": strToU8(presentationRelsXml(slideNumbers.length)),
    "ppt/slideMasters/slideMaster1.xml": strToU8(slideMasterXml()),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(slideMasterRelsXml()),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(slideLayoutXml()),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(slideLayoutRelsXml()),
    "ppt/theme/theme1.xml": strToU8(themeXml(styleProfile)),
  };

  slideNumbers.forEach((sourceSlideNumber, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(slideMedia[`xml${index + 1}`]);
    files[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(slideRelXml(slideMedia[index + 1]));
  });

  mediaFiles.forEach((item) => {
    files[`ppt/media/${item.fileName}`] = item.bytes;
  });

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
}

export function exportCimPptx({ layouts, slideNumbers, getElementText, getElementContent, filename, styleProfile }) {
  const blob = buildCimPptxBlob({ layouts, slideNumbers, getElementText, getElementContent, styleProfile });
  downloadBlob(blob, filename || "cim-prep.pptx");
}
