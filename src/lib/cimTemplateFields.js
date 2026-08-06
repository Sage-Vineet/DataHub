import {
  NAV_SECTIONS,
  TEMPLATE_SLIDE_COUNT,
  extractTemplateFields,
  getSlideLayoutPath,
  prepareCimLayout,
} from "../pages/broker/workspace/WorkspaceCimPrep";

function sectionForSlide(slideNumber) {
  return NAV_SECTIONS.find((section) => (section.slides || []).includes(slideNumber)) || null;
}

async function fetchAllSlideEntries() {
  return Promise.all(
    Array.from({ length: TEMPLATE_SLIDE_COUNT }, async (_, index) => {
      const slideNumber = index + 1;
      try {
        const response = await fetch(getSlideLayoutPath(slideNumber), { cache: "no-store" });
        if (!response.ok) return [slideNumber, null, []];
        const layout = prepareCimLayout(slideNumber, await response.json());
        return [slideNumber, layout, extractTemplateFields(slideNumber, layout)];
      } catch {
        return [slideNumber, null, []];
      }
    }),
  );
}

// Fetches the (public, template-wide) slide layouts and returns both a flattened, deduped list
// of field descriptors (for the list-format review) and the raw per-slide layouts/fields (for
// rendering the actual PPT-style slides) — the same data the broker's CIM editor derives from
// these layouts, reused here so the client review page doesn't need its own copy of the field
// template logic.
export async function loadCimTemplateData() {
  const entries = await fetchAllSlideEntries();

  const layouts = {};
  const fieldsBySlide = {};
  const seen = new Set();
  const fields = [];

  entries.forEach(([slideNumber, layout, slideFields]) => {
    layouts[slideNumber] = layout;
    fieldsBySlide[slideNumber] = slideFields;

    const section = sectionForSlide(slideNumber);
    slideFields
      .filter((field) => !field.hidden && field.label)
      .forEach((field) => {
        if (seen.has(field.id)) return;
        seen.add(field.id);
        fields.push({
          id: field.id,
          label: field.label,
          slideNumber,
          sectionId: section?.id || "",
          sectionTitle: section?.title || "",
          fieldKind: field.fieldKind || "text",
        });
      });
  });

  return { fields, layouts, fieldsBySlide };
}
