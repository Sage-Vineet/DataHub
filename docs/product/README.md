# Product source material

The authoritative product documents the OpenSpec capability specs are derived from. Vendored so that
the feature IDs cited throughout `openspec/changes/centuriuum-product-surface/` resolve to something in
the repo rather than to a shared drive.

**Provenance:** `OneDrive_2026-08-18.zip`, exported 18 Aug 2026 from the `Feature Tracking` folder.
Product list and feature specifications by Josh Tonnesen; feature specifications dated 14 Aug 2026.

## Layout

| Path | What it is |
|---|---|
| `source/` | The originals, byte-for-byte, in their shared-drive folder structure. **Authoritative.** |
| `markdown/` | Text conversions of every `.docx` / `.xlsx` in `source/`. Diffable; not authoritative. |
| `convert.py` | The converter that produces `markdown/` from `source/`. |

`source/` keeps the original folder names — spaces, `&`, and all — so that a later export of the same
folder can be dropped straight over it and the diff shows exactly what the product team changed. That
is the point of vendoring these: the last revision renumbered an entire module silently, and nobody
noticed until the specs were reconciled against it by hand.

## Authority

Where a requirement in an OpenSpec capability spec and its source document disagree, **the document
governs** and the spec is wrong. Every requirement carries the feature ID that identifies its source, so
any requirement can be checked against `source/` in one step. Nothing enforces that automatically.

`markdown/` is a reading and diffing convenience only. It is generated output — never edit it by hand,
and never cite it as the source of a requirement.

## Regenerating the conversions

```sh
cd docs/product
find source -name '*.docx' | while read -r f; do
  python3 convert.py "$f" > "markdown/$(basename "$f" .docx).md"
done
python3 convert.py "source/0000 - Centuriuum Product List.xlsx" \
  > markdown/0000_Centuriuum_Product_List.txt
```

Pure standard library — no `pandoc`, no `python-docx`, no `openpyxl`. `.docx` and `.xlsx` are zipped
XML and the converter reads them directly, extracting headings, paragraphs, lists and tables from
`word/document.xml`, and cells from the sheet XML plus `sharedStrings.xml`. Conversion is
deterministic: regenerating from the vendored sources reproduces `markdown/` exactly.

The four `.md` files under `source/TAS - Claude Project Files/` are already text and are not converted.

## Coverage

98 features across 14 modules in the product list. 59 have a per-feature specification document; the
other 39 exist only as a product-list row. `openspec/changes/centuriuum-product-surface/design.md` §D3
records which is which, and Register A in that file reconciles the identifiers that changed between
this revision and the previous one.

## Adding a later revision

Drop the new export over `source/`, regenerate `markdown/`, and read the diff before touching any spec.
The diff on `markdown/0000_Centuriuum_Product_List.txt` is the fastest way to see renumbering, added
rows, and removed rows; the per-feature diffs show behaviour changes. Then reconcile the capability
specs and update the ID notes in their headers.
