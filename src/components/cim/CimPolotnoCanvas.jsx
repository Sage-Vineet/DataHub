import { useEffect, useMemo, useRef } from "react";
import { createStore } from "polotno/model/store";
import { PolotnoContainer, WorkspaceWrap } from "polotno";
import { Workspace } from "polotno/canvas/workspace";
import { autorun } from "mobx";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const SYNC_DEBOUNCE_MS = 300;

// getElementStyle() (WorkspaceCimPrep.jsx) produces CSS-ready values -- a full
// font-stack string with fallbacks, and a numeric font-weight -- for the old
// HTML/CSS SlideCanvas. Polotno's TextElement model expects a single font
// name and a *string* fontWeight ("normal"/"bold"/a numeric string), so both
// need to be narrowed down at this boundary rather than upstream, since
// SlideCanvas still needs the original CSS-stack/numeric forms.
function firstFontFamily(fontFamily) {
  const first = String(fontFamily || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return first || "Calibri";
}

function normalizeFontWeight(fontWeight) {
  if (fontWeight === undefined || fontWeight === null || fontWeight === "") return "normal";
  return String(fontWeight);
}

// Proof-of-concept visual editor: replaces SlideCanvas at the one call site
// that's actually interactive (the main editing canvas). Every other
// SlideCanvas call site (previews/thumbnails/client viewer/style-editor)
// keeps using the existing HTML/CSS implementation untouched -- see the
// "Konva.js + Polotno Visual Editor" plan for the full scoping rationale.
//
// Deliberately decoupled from WorkspaceCimPrep.jsx's internals: `elementSpecs`
// is pre-built by the caller via buildPolotnoElementSpecs (exported from
// WorkspaceCimPrep.jsx) and passed in as plain data, and edits are reported
// back via `onFieldValuesChange` rather than this component importing any
// CIM-specific resolution logic itself or reaching back into that module
// (which would create a circular import, since that's also where this
// component gets rendered from).
//
// Source-of-truth model (per the approved plan): Polotno's own store is
// authoritative during the editing session; fieldValues (React state owned
// by the parent) is authoritative at rest, kept in sync via a debounced
// mobx autorun rather than per-keystroke or only-on-Save.
export default function CimPolotnoCanvas({
  slideKey,
  elementSpecs,
  onElementsChange,
}) {
  const store = useMemo(() => createStore({ key: "cim-polotno-poc", showCredit: false }), []);
  const debounceRef = useRef(null);

  // Rebuild the page from the CIM data model on slide navigation only --
  // not on every fieldValues keystroke, which would fight the autorun below.
  useEffect(() => {
    store.deletePages(store.pages.map((page) => page.id));
    store.setSize(SLIDE_WIDTH, SLIDE_HEIGHT);
    const page = store.addPage();

    (elementSpecs || []).forEach((spec) => {
      if (spec.cimKind === "tableRect") return; // cosmetic-only, deferred for the POC

      if (spec.cimKind === "image" || spec.cimKind === "chart") {
        page.addElement({
          type: "image", x: spec.x, y: spec.y, width: spec.width, height: spec.height,
          src: spec.src,
          custom: spec.cimAssetKey ? { cimAssetKey: spec.cimAssetKey } : {},
        });
        return;
      }

      // "text" and "tableCell" both materialize as Polotno text elements;
      // only "text" carries a cimFieldId anchor (tableCell content isn't
      // directly editable today either -- SlideCanvas renders it as a plain
      // non-editable span).
      page.addElement({
        type: "text",
        x: spec.x, y: spec.y, width: spec.width, height: Math.max(spec.height, 1),
        text: spec.text || "",
        fontFamily: firstFontFamily(spec.fontFamily),
        fontSize: spec.fontSize || 12,
        fill: spec.fill || "#000000",
        align: spec.align || "left",
        fontWeight: normalizeFontWeight(spec.fontWeight),
        fontStyle: spec.fontStyle || "normal",
        custom: spec.cimFieldId ? { cimFieldId: spec.cimFieldId } : {},
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideKey, store]);

  // Debounced sync: Polotno's store -> this app's fieldValues state, so
  // handleSave (which reads fieldValues directly) and other views sharing
  // that same state pick up edits without requiring per-keystroke sync.
  useEffect(() => {
    const disposeAutorun = autorun(() => {
      const json = store.toJSON();
      const children = json?.pages?.[0]?.children || [];
      void children.length; // read access, so mobx tracks this reaction

      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onElementsChange?.(children);
      }, SYNC_DEBOUNCE_MS);
    });

    return () => {
      disposeAutorun();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  return (
    <div className="relative mx-auto w-full overflow-hidden bg-white shadow-card" style={{ aspectRatio: "16 / 9" }}>
      <PolotnoContainer style={{ width: "100%", height: "100%" }}>
        <WorkspaceWrap>
          <Workspace store={store} />
        </WorkspaceWrap>
      </PolotnoContainer>
    </div>
  );
}
