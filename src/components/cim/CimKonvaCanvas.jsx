import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Ellipse, Text, Image as KonvaImage, Transformer } from "react-konva";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const SYNC_DEBOUNCE_MS = 300;
const MIN_SIZE = 4;

// Proof-of-concept visual editor built directly on Konva.js/react-konva --
// no Polotno SDK. Konva is already a project dependency (free/MIT, unlike
// Polotno's $899/month SDK layer) and its Transformer was already proven
// live in the earlier Polotno POC. Building directly on it also means this
// canvas can render the template's decorative background shapes (bars,
// dividers, theme-colored panels) via cimKind:"shape" specs -- something
// the Polotno POC never mapped at all -- and Konva's canvas `font` string
// is plain CSS font shorthand, so the full font-family fallback stack from
// getElementStyle() can be passed straight through instead of needing to be
// narrowed to a single name (as Polotno's stricter typed model required).
function konvaFontStyle(fontWeight, fontStyle) {
  const bold = Number(fontWeight) >= 600;
  const italic = fontStyle === "italic";
  if (bold && italic) return "italic bold";
  if (bold) return "bold";
  if (italic) return "italic";
  return "normal";
}

function specKey(spec, index) {
  return spec.cimFieldId || spec.cimAssetKey || `${spec.cimKind}-${index}`;
}

function URLImage({ src, ...rest }) {
  const [image, setImage] = useState(null);

  useEffect(() => {
    if (!src) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to the new src, not derived state
      setImage(null);
      return undefined;
    }
    const img = new window.Image();
    img.onload = () => setImage(img);
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  if (!image) return null;
  return <KonvaImage image={image} {...rest} />;
}

export default function CimKonvaCanvas({ slideKey, elementSpecs, onElementsChange }) {
  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const trRef = useRef(null);
  const nodeRefs = useRef({});
  const debounceRef = useRef(null);

  const [elements, setElements] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [scale, setScale] = useState(1);

  // Rebuild the page from the CIM data model on slide navigation only --
  // not on every fieldValues keystroke, which would fight the sync effect below.
  useEffect(() => {
    const built = (elementSpecs || []).map((spec, index) => ({
      id: specKey(spec, index),
      rotation: 0,
      ...spec,
    }));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- rebuilding the working copy on slide navigation, not derived state
    setElements(built);
    setSelectedId(null);
    setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKey]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width) setScale(width / SLIDE_WIDTH);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!trRef.current) return;
    const node = selectedId ? nodeRefs.current[selectedId] : null;
    trRef.current.nodes(node ? [node] : []);
    trRef.current.getLayer()?.batchDraw();
  }, [selectedId, elements]);

  // Debounced sync: local element state -> this app's fieldValues, mirroring
  // applyPolotnoElementsToFieldValues's expected shape so the existing
  // handlePolotnoElementsChange callback in WorkspaceCimPrep.jsx needs no changes.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const children = elements
        .filter((el) => el.cimKind === "text" && el.cimFieldId)
        .map((el) => ({ type: "text", text: el.text || "", custom: { cimFieldId: el.cimFieldId } }));
      onElementsChange?.(children);
    }, SYNC_DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [elements, onElementsChange]);

  const updateElement = useCallback((id, patch) => {
    setElements((prev) => prev.map((el) => (el.id === id ? { ...el, ...patch } : el)));
  }, []);

  const handleDragEnd = useCallback((id, node) => {
    updateElement(id, { x: node.x(), y: node.y() });
  }, [updateElement]);

  const handleTransformEnd = useCallback((id) => {
    const node = nodeRefs.current[id];
    if (!node) return;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    node.scaleX(1);
    node.scaleY(1);
    updateElement(id, {
      x: node.x(),
      y: node.y(),
      width: Math.max(node.width() * scaleX, MIN_SIZE),
      height: Math.max(node.height() * scaleY, MIN_SIZE),
      rotation: node.rotation(),
    });
  }, [updateElement]);

  const beginEdit = useCallback((el) => {
    if (el.cimKind !== "text" || !el.cimFieldId) return;
    setSelectedId(el.id);
    setEditingId(el.id);
  }, []);

  const commitEdit = useCallback((id, text) => {
    updateElement(id, { text });
    setEditingId(null);
  }, [updateElement]);

  const deselect = useCallback((event) => {
    if (event.target === event.target.getStage()) setSelectedId(null);
  }, []);

  const registerNode = useCallback((id) => (node) => {
    if (node) nodeRefs.current[id] = node;
  }, []);

  const editingElement = editingId ? elements.find((el) => el.id === editingId) : null;

  return (
    <div
      ref={containerRef}
      className="relative mx-auto w-full overflow-hidden bg-white shadow-card"
      style={{ aspectRatio: "16 / 9" }}
    >
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
        <Stage ref={stageRef} width={SLIDE_WIDTH} height={SLIDE_HEIGHT} onMouseDown={deselect} onTouchStart={deselect}>
          <Layer>
            {elements.map((el) => {
              if (el.cimKind === "shape") {
                const isRule = !el.width || !el.height;
                const width = isRule ? Math.max(el.width, 2) : el.width;
                const height = isRule ? Math.max(el.height, 2) : el.height;
                const fill = isRule ? (el.stroke && el.stroke !== "transparent" ? el.stroke : el.fill) : el.fill;
                const interactionProps = {
                  draggable: true,
                  onClick: () => setSelectedId(el.id),
                  onTap: () => setSelectedId(el.id),
                  onDragEnd: (e) => handleDragEnd(el.id, e.target),
                  onTransformEnd: () => handleTransformEnd(el.id),
                  ref: registerNode(el.id),
                };
                return el.isEllipse ? (
                  <Ellipse
                    key={el.id}
                    x={el.x + width / 2}
                    y={el.y + height / 2}
                    radiusX={width / 2}
                    radiusY={height / 2}
                    rotation={el.rotation || 0}
                    fill={fill}
                    stroke={isRule ? "transparent" : el.stroke}
                    strokeWidth={isRule ? 0 : el.strokeWidth}
                    {...interactionProps}
                  />
                ) : (
                  <Rect
                    key={el.id}
                    x={el.x}
                    y={el.y}
                    width={width}
                    height={height}
                    rotation={el.rotation || 0}
                    fill={fill}
                    stroke={isRule ? "transparent" : el.stroke}
                    strokeWidth={isRule ? 0 : el.strokeWidth}
                    {...interactionProps}
                  />
                );
              }

              if (el.cimKind === "image" || el.cimKind === "chart") {
                return (
                  <URLImage
                    key={el.id}
                    src={el.src}
                    x={el.x}
                    y={el.y}
                    width={el.width}
                    height={el.height}
                    rotation={el.rotation || 0}
                    draggable
                    onClick={() => setSelectedId(el.id)}
                    onTap={() => setSelectedId(el.id)}
                    onDragEnd={(e) => handleDragEnd(el.id, e.target)}
                    onTransformEnd={() => handleTransformEnd(el.id)}
                    ref={registerNode(el.id)}
                  />
                );
              }

              if (el.cimKind === "tableRect") {
                return (
                  <Rect
                    key={el.id}
                    x={el.x}
                    y={el.y}
                    width={el.width}
                    height={el.height}
                    fill={el.fill}
                    listening={false}
                  />
                );
              }

              if (el.cimKind === "tableCell") {
                return (
                  <Text
                    key={el.id}
                    x={el.x}
                    y={el.y}
                    width={el.width}
                    height={el.height}
                    text={el.text}
                    fontFamily={el.fontFamily}
                    fontSize={el.fontSize}
                    fill={el.fill}
                    align={el.align}
                    listening={false}
                  />
                );
              }

              // text
              return (
                <Text
                  key={el.id}
                  x={el.x}
                  y={el.y}
                  width={el.width}
                  height={el.height}
                  rotation={el.rotation || 0}
                  text={el.text}
                  fontFamily={el.fontFamily}
                  fontSize={el.fontSize}
                  fill={el.fill}
                  align={el.align}
                  fontStyle={konvaFontStyle(el.fontWeight, el.fontStyle)}
                  visible={editingId !== el.id}
                  draggable
                  onClick={() => setSelectedId(el.id)}
                  onTap={() => setSelectedId(el.id)}
                  onDblClick={() => beginEdit(el)}
                  onDblTap={() => beginEdit(el)}
                  onDragEnd={(e) => handleDragEnd(el.id, e.target)}
                  onTransformEnd={() => handleTransformEnd(el.id)}
                  ref={registerNode(el.id)}
                />
              );
            })}
            <Transformer
              ref={trRef}
              rotateEnabled
              boundBoxFunc={(oldBox, newBox) => (
                newBox.width < MIN_SIZE || newBox.height < MIN_SIZE ? oldBox : newBox
              )}
            />
          </Layer>
        </Stage>

        {editingElement && (
          <textarea
            autoFocus
            defaultValue={editingElement.text}
            onBlur={(e) => commitEdit(editingElement.id, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingId(null);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit(editingElement.id, e.target.value);
              }
            }}
            style={{
              position: "absolute",
              top: editingElement.y,
              left: editingElement.x,
              width: editingElement.width,
              height: editingElement.height,
              fontFamily: editingElement.fontFamily,
              fontSize: editingElement.fontSize,
              fontWeight: editingElement.fontWeight,
              fontStyle: editingElement.fontStyle,
              color: editingElement.fill,
              textAlign: editingElement.align,
              lineHeight: 1.08,
              border: "1px solid #2563eb",
              padding: 0,
              margin: 0,
              background: "white",
              resize: "none",
              outline: "none",
            }}
          />
        )}
      </div>
    </div>
  );
}
