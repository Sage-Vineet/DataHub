function makeBuilderId(prefix = "element") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createBlankBuilderPage(overrides = {}) {
  return {
    id: makeBuilderId("page"),
    name: "Added page",
    backgroundColor: "#FFFFFF",
    backgroundImage: "",
    backgroundImageOpacity: 1,
    elements: [],
    ...overrides,
  };
}

export function normalizeBuilderImageSource(element = {}) {
  if (!element || typeof element !== "object") return "";
  const direct = element.src || element.dataUrl || element.url || element.href;
  if (direct) return String(direct);
  const nested = element.image || element.asset || element.media || {};
  return String(nested.dataUrl || nested.src || nested.url || "");
}

export function createBuilderElement(type, overrides = {}) {
  const base = {
    id: makeBuilderId(type),
    type,
    x: 120,
    y: 120,
    width: type === "line" ? 260 : 260,
    height: type === "line" ? 0 : 90,
    rotation: 0,
    opacity: 1,
    zIndex: 1,
  };

  if (type === "text") {
    return {
      ...base,
      text: "New text",
      fontFamily: "Calibri, Aptos, Arial, sans-serif",
      fontSize: 28,
      fill: "#111827",
      align: "left",
      verticalAlign: "top",
      lineHeight: 1.08,
      letterSpacing: 0,
      fontWeight: 400,
      fontStyle: "normal",
      textDecoration: "none",
      backgroundFill: "transparent",
      stroke: "transparent",
      strokeWidth: 0,
      ...overrides,
    };
  }

  if (type === "image") {
    return {
      ...base,
      width: 320,
      height: 180,
      src: "",
      name: "Image",
      fit: "contain",
      objectPosition: "center center",
      stroke: "transparent",
      strokeWidth: 0,
      ...overrides,
    };
  }

  if (type === "line") {
    return {
      ...base,
      fill: "transparent",
      stroke: "#111827",
      strokeWidth: 3,
      ...overrides,
    };
  }

  return {
    ...base,
    type: "shape",
    subType: type === "ellipse" ? "ellipse" : "rect",
    fill: "#EEF6E0",
    stroke: "#8BC53D",
    strokeWidth: 2,
    cornerRadius: 0,
    ...overrides,
  };
}
