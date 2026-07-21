import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  Bold,
  Circle,
  Copy,
  ImagePlus,
  Italic,
  Minus,
  MousePointer2,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Type,
  Underline,
  Upload,
} from "lucide-react";
import { createBuilderElement } from "../../lib/cimNativeBuilderModel";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const MIN_ELEMENT_SIZE = 8;

function makeBuilderId(prefix = "element") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function roundSlideValue(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function normalizeHexColor(value, fallback = "#000000") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`;
  return fallback;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function useElementWidth(ref) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!ref.current) return undefined;
    const element = ref.current;
    const update = () => setWidth(element.getBoundingClientRect().width || 0);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function renderBuilderElement(element, scale = 1, options = {}) {
  const selected = Boolean(options.selected);
  const editable = Boolean(options.editable);
  const style = {
    position: "absolute",
    left: Number(element.x || 0) * scale,
    top: Number(element.y || 0) * scale,
    width: Math.max(Number(element.width || 1) * scale, 1),
    height: Math.max(Number(element.height || 1) * scale, element.type === "line" ? 1 : 1),
    opacity: Number(element.opacity ?? 1),
    transform: `rotate(${Number(element.rotation || 0)}deg)`,
    transformOrigin: "top left",
    zIndex: Number(element.zIndex || 1),
  };

  if (element.type === "image") {
    return (
      <img
        src={element.src}
        alt={element.name || "Slide image"}
        draggable={false}
        className="block select-none"
        style={{
          ...style,
          objectFit: element.fit || "contain",
          border: Number(element.strokeWidth || 0) > 0
            ? `${Math.max(Number(element.strokeWidth || 0) * scale, 0.5)}px solid ${element.stroke || "transparent"}`
            : "none",
        }}
      />
    );
  }

  if (element.type === "line") {
    return (
      <svg
        style={style}
        viewBox={`0 0 ${Math.max(Number(element.width || 1), 1)} ${Math.max(Math.abs(Number(element.height || 0)), 1)}`}
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          y1={Number(element.height || 0) < 0 ? Math.max(Math.abs(Number(element.height || 0)), 1) : 0}
          x2={Math.max(Number(element.width || 1), 1)}
          y2={Number(element.height || 0) < 0 ? 0 : Math.max(Number(element.height || 0), 0)}
          stroke={element.stroke || element.fill || "#111827"}
          strokeWidth={Math.max(Number(element.strokeWidth || 2) * scale, 1)}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  if (element.type === "shape") {
    return (
      <div
        style={{
          ...style,
          backgroundColor: element.fill || "transparent",
          border: Number(element.strokeWidth || 0) > 0
            ? `${Math.max(Number(element.strokeWidth || 0) * scale, 0.5)}px solid ${element.stroke || "transparent"}`
            : "none",
          borderRadius: element.subType === "ellipse" ? "50%" : Math.max(Number(element.cornerRadius || 0) * scale, 0),
        }}
      />
    );
  }

  const textBaseStyle = {
    ...style,
    display: "flex",
    alignItems: element.verticalAlign === "middle" ? "center" : element.verticalAlign === "bottom" ? "flex-end" : "flex-start",
    justifyContent: element.align === "center" ? "center" : element.align === "right" ? "flex-end" : "flex-start",
    overflow: "hidden",
    padding: Math.max(Number(element.padding || 0) * scale, 0),
    backgroundColor: element.backgroundFill || "transparent",
    border: Number(element.strokeWidth || 0) > 0
      ? `${Math.max(Number(element.strokeWidth || 0) * scale, 0.5)}px solid ${element.stroke || "transparent"}`
      : "none",
    color: element.fill || "#111827",
    fontFamily: element.fontFamily || "Calibri, Aptos, Arial, sans-serif",
    fontSize: Math.max(Number(element.fontSize || 12) * scale, 5),
    fontWeight: element.fontWeight || 400,
    fontStyle: element.fontStyle || "normal",
    textDecoration: element.textDecoration || "none",
    textAlign: element.align || "left",
    lineHeight: element.lineHeight || 1.08,
    letterSpacing: Number(element.letterSpacing || 0) * scale,
    whiteSpace: "pre-wrap",
  };

  if (editable && selected) {
    return (
      <textarea
        aria-label="Selected slide text"
        value={element.text || ""}
        onChange={(event) => options.onTextChange?.(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        className="resize-none outline-none"
        spellCheck={false}
        style={{
          ...textBaseStyle,
          display: "block",
        }}
      />
    );
  }

  return (
    <div style={textBaseStyle}>
      <span className="block w-full">{element.text || ""}</span>
    </div>
  );
}

export function CimBuilderPagePreview({ page, className = "" }) {
  const stageRef = useRef(null);
  const stageWidth = useElementWidth(stageRef);
  const scale = stageWidth > 0 ? stageWidth / SLIDE_WIDTH : 1;
  const elements = [...(page?.elements || [])].sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0));

  return (
    <div
      ref={stageRef}
      className={`relative mx-auto w-full overflow-hidden bg-white shadow-card ${className}`}
      style={{ aspectRatio: "16 / 9", backgroundColor: page?.backgroundColor || "#FFFFFF" }}
    >
      {page?.backgroundImage ? (
        <img
          src={page.backgroundImage}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
          style={{ opacity: Number(page.backgroundImageOpacity ?? 1) }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
          transformOrigin: "top left",
          transform: `scale(${scale})`,
        }}
      >
        {elements.map((element) => (
          <div key={element.id} className="pointer-events-none">
            {renderBuilderElement(element, 1)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolbarButton({ active = false, disabled = false, title, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex h-8 w-8 items-center justify-center rounded-md border transition ${
        active
          ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
          : "border-border bg-white text-[#5E6673] hover:border-[#8BC53D]/70 hover:bg-[#F8FCF3] hover:text-[#476E2C]"
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      {children}
    </button>
  );
}

function InspectorInput({ label, value, type = "number", onChange, min, max, step = 1 }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.06em] text-[#8A8F98]">{label}</span>
      <input
        type={type}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(type === "number" ? Number(event.target.value) : event.target.value)}
        className="h-7 w-full rounded-md border border-border bg-white px-2 text-xs font-semibold text-[#111827] outline-none focus:border-[#8BC53D]"
      />
    </label>
  );
}

export default function CimNativeBuilderCanvas({
  slideKey,
  page,
  pageTabs = [],
  activePageIndex = 0,
  onSelectPage,
  onAddPage,
  onDeletePage,
  onRestorePage,
  onChange,
}) {
  const stageRef = useRef(null);
  const stageWidth = useElementWidth(stageRef);
  const scale = stageWidth > 0 ? stageWidth / SLIDE_WIDTH : 1;
  const imageInputRef = useRef(null);
  const backgroundInputRef = useRef(null);
  const interactionRef = useRef(null);
  const [selectedElementId, setSelectedElementId] = useState("");
  const [activeTool, setActiveTool] = useState("select");
  const elements = useMemo(
    () => [...(page?.elements || [])].sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0)),
    [page?.elements],
  );
  const selectedElement = elements.find((element) => element.id === selectedElementId) || null;
  const deleted = Boolean(page?.deleted);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setSelectedElementId("");
      setActiveTool("select");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [slideKey, page?.id]);

  const commitPage = useCallback((nextPage) => {
    onChange?.({
      ...nextPage,
      elements: [...(nextPage.elements || [])].sort((a, b) => Number(a.zIndex || 0) - Number(b.zIndex || 0)),
    });
  }, [onChange]);

  const commitElements = useCallback((nextElements) => {
    commitPage({ ...page, elements: nextElements });
  }, [commitPage, page]);

  const updateElement = useCallback((elementId, patch) => {
    commitElements((page?.elements || []).map((element) => (
      element.id === elementId
        ? {
            ...element,
            ...patch,
            x: patch.x === undefined ? element.x : clamp(roundSlideValue(patch.x), -SLIDE_WIDTH, SLIDE_WIDTH * 2),
            y: patch.y === undefined ? element.y : clamp(roundSlideValue(patch.y), -SLIDE_HEIGHT, SLIDE_HEIGHT * 2),
            width: patch.width === undefined ? element.width : Math.max(roundSlideValue(patch.width), MIN_ELEMENT_SIZE),
            height: patch.height === undefined ? element.height : roundSlideValue(patch.height),
          }
        : element
    )));
  }, [commitElements, page?.elements]);

  function addElement(type, overrides = {}) {
    const element = createBuilderElement(type, {
      x: 120 + Math.min((page?.elements || []).length * 10, 140),
      y: 110 + Math.min((page?.elements || []).length * 8, 120),
      ...overrides,
    });
    commitElements([...(page?.elements || []), element]);
    setSelectedElementId(element.id);
    setActiveTool("select");
  }

  async function handleImageFile(file) {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    addElement("image", { src: dataUrl, name: file.name || "Image" });
    if (imageInputRef.current) imageInputRef.current.value = "";
  }

  async function handleBackgroundFile(file) {
    if (!file) return;
    const dataUrl = await readFileAsDataUrl(file);
    commitPage({ ...page, backgroundImage: dataUrl, backgroundImageOpacity: 1 });
    if (backgroundInputRef.current) backgroundInputRef.current.value = "";
  }

  const removeSelectedElement = useCallback(() => {
    if (!selectedElementId) return;
    commitElements((page?.elements || []).filter((element) => element.id !== selectedElementId));
    setSelectedElementId("");
  }, [commitElements, page?.elements, selectedElementId]);

  const duplicateSelectedElement = useCallback(() => {
    if (!selectedElement) return;
    const copy = {
      ...selectedElement,
      id: makeBuilderId(selectedElement.type || "element"),
      x: Number(selectedElement.x || 0) + 24,
      y: Number(selectedElement.y || 0) + 24,
      zIndex: Date.now(),
      cimFieldId: null,
      cimAssetKey: null,
    };
    commitElements([...(page?.elements || []), copy]);
    setSelectedElementId(copy.id);
  }, [commitElements, page?.elements, selectedElement]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!selectedElementId || deleted) return;
      const targetTag = event.target?.tagName?.toLowerCase();
      if (targetTag === "input" || targetTag === "textarea" || event.target?.isContentEditable) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelectedElement();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelectedElement();
        return;
      }

      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const delta = {
          ArrowUp: { y: -step },
          ArrowDown: { y: step },
          ArrowLeft: { x: -step },
          ArrowRight: { x: step },
        }[event.key];
        updateElement(selectedElementId, delta);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleted, duplicateSelectedElement, removeSelectedElement, selectedElementId, updateElement]);

  function bringForward() {
    if (!selectedElement) return;
    updateElement(selectedElement.id, { zIndex: Math.max(...elements.map((element) => Number(element.zIndex || 0)), 0) + 1 });
  }

  function sendBackward() {
    if (!selectedElement) return;
    updateElement(selectedElement.id, { zIndex: Math.min(...elements.map((element) => Number(element.zIndex || 0)), 0) - 1 });
  }

  function toSlidePoint(event) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || scale <= 0) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  }

  function startInteraction(event, element, action, handle = "") {
    if (deleted) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveTool("select");
    setSelectedElementId(element.id);
    const point = toSlidePoint(event);
    interactionRef.current = {
      action,
      handle,
      elementId: element.id,
      startPoint: point,
      startElement: { ...element },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const interaction = interactionRef.current;
    if (!interaction) return;
    const point = toSlidePoint(event);
    const dx = point.x - interaction.startPoint.x;
    const dy = point.y - interaction.startPoint.y;
    const start = interaction.startElement;

    if (interaction.action === "move") {
      updateElement(interaction.elementId, {
        x: start.x + dx,
        y: start.y + dy,
      });
      return;
    }

    const handle = interaction.handle;
    let nextX = Number(start.x || 0);
    let nextY = Number(start.y || 0);
    let nextWidth = Number(start.width || MIN_ELEMENT_SIZE);
    let nextHeight = Number(start.height || MIN_ELEMENT_SIZE);

    if (handle.includes("e")) nextWidth = Number(start.width || 0) + dx;
    if (handle.includes("s")) nextHeight = Number(start.height || 0) + dy;
    if (handle.includes("w")) {
      nextX = Number(start.x || 0) + dx;
      nextWidth = Number(start.width || 0) - dx;
    }
    if (handle.includes("n")) {
      nextY = Number(start.y || 0) + dy;
      nextHeight = Number(start.height || 0) - dy;
    }

    if (nextWidth < MIN_ELEMENT_SIZE) {
      nextX = Number(start.x || 0) + Number(start.width || 0) - MIN_ELEMENT_SIZE;
      nextWidth = MIN_ELEMENT_SIZE;
    }
    if (Math.abs(nextHeight) < MIN_ELEMENT_SIZE && start.type !== "line") {
      nextY = Number(start.y || 0) + Number(start.height || 0) - MIN_ELEMENT_SIZE;
      nextHeight = MIN_ELEMENT_SIZE;
    }

    updateElement(interaction.elementId, {
      x: nextX,
      y: nextY,
      width: nextWidth,
      height: start.type === "line" && !handle.includes("s") && !handle.includes("n") ? start.height : nextHeight,
    });
  }

  function endInteraction() {
    interactionRef.current = null;
  }

  const handlePositions = [
    ["nw", "left-[-5px] top-[-5px] cursor-nwse-resize"],
    ["n", "left-1/2 top-[-5px] -translate-x-1/2 cursor-ns-resize"],
    ["ne", "right-[-5px] top-[-5px] cursor-nesw-resize"],
    ["e", "right-[-5px] top-1/2 -translate-y-1/2 cursor-ew-resize"],
    ["se", "bottom-[-5px] right-[-5px] cursor-nwse-resize"],
    ["s", "bottom-[-5px] left-1/2 -translate-x-1/2 cursor-ns-resize"],
    ["sw", "bottom-[-5px] left-[-5px] cursor-nesw-resize"],
    ["w", "left-[-5px] top-1/2 -translate-y-1/2 cursor-ew-resize"],
  ];

  return (
    <div className="overflow-hidden rounded-md border border-border bg-[#F6F8FA]">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-white px-2 py-1.5">
        <div className="flex items-center gap-1">
          <ToolbarButton title="Select" active={activeTool === "select"} onClick={() => setActiveTool("select")}>
            <MousePointer2 size={15} />
          </ToolbarButton>
          <ToolbarButton title="Add text" onClick={() => addElement("text")}>
            <Type size={15} />
          </ToolbarButton>
          <ToolbarButton title="Add rectangle" onClick={() => addElement("rect")}>
            <Square size={15} />
          </ToolbarButton>
          <ToolbarButton title="Add circle" onClick={() => addElement("ellipse")}>
            <Circle size={15} />
          </ToolbarButton>
          <ToolbarButton title="Add line" onClick={() => addElement("line")}>
            <Minus size={15} />
          </ToolbarButton>
          <ToolbarButton title="Add image" onClick={() => imageInputRef.current?.click()}>
            <ImagePlus size={15} />
          </ToolbarButton>
          <ToolbarButton title="Set background image" onClick={() => backgroundInputRef.current?.click()}>
            <Upload size={15} />
          </ToolbarButton>
        </div>

        <div className="h-6 w-px bg-border" />

        <div className="flex items-center gap-1">
          <ToolbarButton title="Duplicate selected" disabled={!selectedElement} onClick={duplicateSelectedElement}>
            <Copy size={15} />
          </ToolbarButton>
          <ToolbarButton title="Bring forward" disabled={!selectedElement} onClick={bringForward}>
            <ArrowUp size={15} />
          </ToolbarButton>
          <ToolbarButton title="Send backward" disabled={!selectedElement} onClick={sendBackward}>
            <ArrowDown size={15} />
          </ToolbarButton>
          <ToolbarButton title="Delete selected element" disabled={!selectedElement} onClick={removeSelectedElement}>
            <Trash2 size={15} />
          </ToolbarButton>
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto">
          {pageTabs.map((tab) => (
            <button
              key={tab.index}
              type="button"
              onClick={() => onSelectPage?.(tab.index)}
              className={`h-8 shrink-0 rounded-md border px-2 text-xs font-bold transition ${
                tab.index === activePageIndex
                  ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                  : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
              }`}
            >
              {tab.label}
            </button>
          ))}
          <ToolbarButton title="Add page" onClick={onAddPage}>
            <Plus size={15} />
          </ToolbarButton>
          <ToolbarButton title={deleted ? "Restore page" : "Delete page"} onClick={deleted ? onRestorePage : onDeletePage}>
            {deleted ? <RefreshCw size={15} /> : <Trash2 size={15} />}
          </ToolbarButton>
        </div>

        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={(event) => void handleImageFile(event.target.files?.[0])}
        />
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={(event) => void handleBackgroundFile(event.target.files?.[0])}
        />
      </div>

      <div className="grid min-h-[520px] gap-0 lg:grid-cols-[minmax(0,1fr)_228px]">
        <div className="flex min-w-0 items-center justify-center overflow-auto bg-[#E8EDF2] p-2">
          <div
            ref={stageRef}
            className="relative mx-auto w-full max-w-none overflow-hidden bg-white shadow-card"
            style={{ aspectRatio: "16 / 9", backgroundColor: page?.backgroundColor || "#FFFFFF" }}
            onPointerMove={handlePointerMove}
            onPointerUp={endInteraction}
            onPointerCancel={endInteraction}
            onClick={() => setSelectedElementId("")}
          >
            {page?.backgroundImage ? (
              <img
                src={page.backgroundImage}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
                style={{ opacity: Number(page.backgroundImageOpacity ?? 1) }}
              />
            ) : null}

            {deleted ? (
              <div className="absolute inset-0 z-[10000] flex items-center justify-center bg-white/92">
                <div className="max-w-sm text-center">
                  <p className="text-base font-bold text-[#111827]">This page is removed from the CIM.</p>
                  <button type="button" onClick={onRestorePage} className="theme-btn-secondary mt-4">
                    <RefreshCw size={16} />
                    Restore Page
                  </button>
                </div>
              </div>
            ) : null}

            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: SLIDE_WIDTH,
                height: SLIDE_HEIGHT,
                transformOrigin: "top left",
                transform: `scale(${scale})`,
              }}
            >
              {elements.map((element) => {
                const selected = selectedElementId === element.id;
                return (
                  <div
                    key={element.id}
                    className={selected ? "group" : ""}
                    onPointerDown={(event) => startInteraction(event, element, "move")}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedElementId(element.id);
                    }}
                    style={{
                      position: "absolute",
                      left: Number(element.x || 0),
                      top: Number(element.y || 0),
                      width: Math.max(Number(element.width || 1), 1),
                      height: Math.max(Math.abs(Number(element.height || 1)), element.type === "line" ? 1 : 1),
                      zIndex: Number(element.zIndex || 1),
                      cursor: "move",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: -Number(element.x || 0),
                        top: -Number(element.y || 0),
                      }}
                    >
                      {renderBuilderElement(element, 1, {
                        selected,
                        editable: true,
                        onTextChange: (text) => updateElement(element.id, { text }),
                      })}
                    </div>
                    {selected ? (
                      <div className="pointer-events-none absolute inset-0 ring-2 ring-[#8BC53D]">
                        {handlePositions.map(([handle, position]) => (
                          <button
                            key={handle}
                            type="button"
                            aria-label={`Resize ${handle}`}
                            className={`pointer-events-auto absolute h-[10px] w-[10px] rounded-sm border border-white bg-[#476E2C] ${position}`}
                            onPointerDown={(event) => startInteraction(event, element, "resize", handle)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="border-t border-border bg-white p-2.5 lg:border-l lg:border-t-0">
          <div className="mb-2 flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#8A8F98]">Inspector</p>
              <h3 className="text-sm font-bold text-[#111827]">{selectedElement ? "Selected element" : "Page"}</h3>
            </div>
          </div>

          <div className="space-y-2.5">
            {!selectedElement ? (
              <>
                <InspectorInput
                  label="Background"
                  type="color"
                  value={normalizeHexColor(page?.backgroundColor, "#FFFFFF")}
                  onChange={(value) => commitPage({ ...page, backgroundColor: value })}
                />
                {page?.backgroundImage ? (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <InspectorInput
                      label="Image opacity"
                      value={Number(page.backgroundImageOpacity ?? 1)}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(value) => commitPage({ ...page, backgroundImageOpacity: clamp(value, 0, 1) })}
                    />
                    <button
                      type="button"
                      onClick={() => commitPage({ ...page, backgroundImage: "" })}
                      className="mt-5 flex h-8 w-8 items-center justify-center rounded-md border border-border text-[#6D6E71] hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                      title="Remove background image"
                      aria-label="Remove background image"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <InspectorInput label="X" value={roundSlideValue(selectedElement.x)} onChange={(value) => updateElement(selectedElement.id, { x: value })} />
                  <InspectorInput label="Y" value={roundSlideValue(selectedElement.y)} onChange={(value) => updateElement(selectedElement.id, { y: value })} />
                  <InspectorInput label="W" value={roundSlideValue(selectedElement.width)} onChange={(value) => updateElement(selectedElement.id, { width: value })} />
                  <InspectorInput label="H" value={roundSlideValue(selectedElement.height)} onChange={(value) => updateElement(selectedElement.id, { height: value })} />
                </div>
                <InspectorInput
                  label="Opacity"
                  value={Number(selectedElement.opacity ?? 1)}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(value) => updateElement(selectedElement.id, { opacity: clamp(value, 0, 1) })}
                />
                <InspectorInput
                  label="Rotation"
                  value={roundSlideValue(selectedElement.rotation || 0)}
                  min={-360}
                  max={360}
                  step={0.5}
                  onChange={(value) => updateElement(selectedElement.id, { rotation: value })}
                />

                {selectedElement.type === "text" ? (
                  <>
                    <div className="grid grid-cols-[1fr_84px] gap-2">
                      <InspectorInput
                        label="Text color"
                        type="color"
                        value={normalizeHexColor(selectedElement.fill, "#111827")}
                        onChange={(value) => updateElement(selectedElement.id, { fill: value })}
                      />
                      <InspectorInput
                        label="Size"
                        value={Number(selectedElement.fontSize || 12)}
                        min={5}
                        max={160}
                        step={0.5}
                        onChange={(value) => updateElement(selectedElement.id, { fontSize: value })}
                      />
                    </div>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.06em] text-[#8A8F98]">Font</span>
                      <input
                        value={selectedElement.fontFamily || ""}
                        onChange={(event) => updateElement(selectedElement.id, { fontFamily: event.target.value })}
                        className="h-7 w-full rounded-md border border-border bg-white px-2 text-xs font-semibold text-[#111827] outline-none focus:border-[#8BC53D]"
                      />
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      <InspectorInput
                        label="Line"
                        value={Number(selectedElement.lineHeight || 1.08)}
                        min={0.75}
                        max={2.5}
                        step={0.01}
                        onChange={(value) => updateElement(selectedElement.id, { lineHeight: clamp(value, 0.75, 2.5) })}
                      />
                      <InspectorInput
                        label="Letter"
                        value={Number(selectedElement.letterSpacing || 0)}
                        min={-2}
                        max={10}
                        step={0.1}
                        onChange={(value) => updateElement(selectedElement.id, { letterSpacing: clamp(value, -2, 10) })}
                      />
                      <InspectorInput
                        label="Padding"
                        value={Number(selectedElement.padding || 0)}
                        min={0}
                        max={48}
                        step={1}
                        onChange={(value) => updateElement(selectedElement.id, { padding: clamp(value, 0, 48) })}
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <ToolbarButton
                        title="Bold"
                        active={Number(selectedElement.fontWeight || 400) >= 600}
                        onClick={() => updateElement(selectedElement.id, { fontWeight: Number(selectedElement.fontWeight || 400) >= 600 ? 400 : 700 })}
                      >
                        <Bold size={14} />
                      </ToolbarButton>
                      <ToolbarButton
                        title="Italic"
                        active={selectedElement.fontStyle === "italic"}
                        onClick={() => updateElement(selectedElement.id, { fontStyle: selectedElement.fontStyle === "italic" ? "normal" : "italic" })}
                      >
                        <Italic size={14} />
                      </ToolbarButton>
                      <ToolbarButton
                        title="Underline"
                        active={selectedElement.textDecoration === "underline"}
                        onClick={() => updateElement(selectedElement.id, { textDecoration: selectedElement.textDecoration === "underline" ? "none" : "underline" })}
                      >
                        <Underline size={14} />
                      </ToolbarButton>
                      <ToolbarButton title="Align left" active={selectedElement.align === "left"} onClick={() => updateElement(selectedElement.id, { align: "left" })}>
                        <AlignLeft size={14} />
                      </ToolbarButton>
                      <ToolbarButton title="Align center" active={selectedElement.align === "center"} onClick={() => updateElement(selectedElement.id, { align: "center" })}>
                        <AlignCenter size={14} />
                      </ToolbarButton>
                      <ToolbarButton title="Align right" active={selectedElement.align === "right"} onClick={() => updateElement(selectedElement.id, { align: "right" })}>
                        <AlignRight size={14} />
                      </ToolbarButton>
                    </div>
                    <div>
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.06em] text-[#8A8F98]">Vertical</span>
                      <div className="grid grid-cols-3 gap-1">
                        {[
                          ["top", "Top"],
                          ["middle", "Mid"],
                          ["bottom", "Bot"],
                        ].map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => updateElement(selectedElement.id, { verticalAlign: value })}
                            className={`h-7 rounded-md border text-[11px] font-bold transition ${
                              selectedElement.verticalAlign === value
                                ? "border-[#8BC53D] bg-[#EEF6E0] text-[#476E2C]"
                                : "border-border bg-white text-[#6D6E71] hover:border-[#8BC53D]/60"
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <InspectorInput
                      label="Text box fill"
                      type="color"
                      value={normalizeHexColor(selectedElement.backgroundFill, "#FFFFFF")}
                      onChange={(value) => updateElement(selectedElement.id, { backgroundFill: value })}
                    />
                  </>
                ) : null}

                {selectedElement.type === "shape" || selectedElement.type === "line" ? (
                  <div className="grid grid-cols-2 gap-2">
                    {selectedElement.type === "shape" ? (
                      <InspectorInput
                        label="Fill"
                        type="color"
                        value={normalizeHexColor(selectedElement.fill, "#EEF6E0")}
                        onChange={(value) => updateElement(selectedElement.id, { fill: value })}
                      />
                    ) : null}
                    <InspectorInput
                      label="Stroke"
                      type="color"
                      value={normalizeHexColor(selectedElement.stroke, "#111827")}
                      onChange={(value) => updateElement(selectedElement.id, { stroke: value })}
                    />
                    <InspectorInput
                      label="Stroke px"
                      value={Number(selectedElement.strokeWidth || 0)}
                      min={0}
                      max={24}
                      onChange={(value) => updateElement(selectedElement.id, { strokeWidth: value })}
                    />
                  </div>
                ) : null}

                {selectedElement.type === "image" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <InspectorInput
                      label="Border"
                      type="color"
                      value={normalizeHexColor(selectedElement.stroke, "#FFFFFF")}
                      onChange={(value) => updateElement(selectedElement.id, { stroke: value })}
                    />
                    <InspectorInput
                      label="Border px"
                      value={Number(selectedElement.strokeWidth || 0)}
                      min={0}
                      max={24}
                      onChange={(value) => updateElement(selectedElement.id, { strokeWidth: value })}
                    />
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
