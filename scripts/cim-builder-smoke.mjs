import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createLogger, createServer } from "vite";

const ONE_BY_ONE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const ROUTER_SMOKE_SHIM = new URL("./react-router-dom-smoke-shim.js", import.meta.url).pathname;

async function main() {
  const logger = createLogger("error");
  const originalError = logger.error;
  logger.error = (message, options) => {
    if (String(message || "").includes("WebSocket server error")) return;
    originalError(message, options);
  };
  const vite = await createServer({
    appType: "custom",
    customLogger: logger,
    resolve: {
      alias: {
        "react-router-dom": ROUTER_SMOKE_SHIM,
      },
    },
    server: { hmr: false, middlewareMode: true },
    logLevel: "error",
  });

  try {
    const canvasModule = await vite.ssrLoadModule("/src/components/cim/CimNativeBuilderCanvas.jsx");
    const exportModule = await vite.ssrLoadModule("/src/lib/cimPptxExport.js");
    const interactionModule = await vite.ssrLoadModule("/src/lib/cimNativeBuilderInteraction.js");
    const modelModule = await vite.ssrLoadModule("/src/lib/cimNativeBuilderModel.js");
    const workspaceModule = await vite.ssrLoadModule("/src/pages/broker/workspace/WorkspaceCimPrep.jsx");

    assert.equal(
      interactionModule.shouldStartCanvasDrag({ x: 100, y: 100 }, { x: 101, y: 101 }),
      false,
    );
    assert.equal(
      interactionModule.shouldStartCanvasDrag({ clientX: 100, clientY: 100 }, { clientX: 104, clientY: 100 }),
      true,
    );

    const page = {
      id: "smoke-page",
      name: "Smoke page",
      backgroundColor: "#FFFFFF",
      backgroundImage: ONE_BY_ONE_PNG,
      backgroundImageOpacity: 0.75,
      elements: [
        modelModule.createBuilderElement("text", {
          id: "text-1",
          text: "Editable smoke text",
          x: 40,
          y: 42,
          width: 360,
          height: 72,
          zIndex: 1,
        }),
        modelModule.createBuilderElement("rect", {
          id: "shape-1",
          x: 60,
          y: 150,
          width: 220,
          height: 90,
          zIndex: 2,
        }),
        modelModule.createBuilderElement("line", {
          id: "line-1",
          x: 330,
          y: 280,
          width: 180,
          height: -70,
          zIndex: 3,
        }),
        modelModule.createBuilderElement("image", {
          id: "image-1",
          src: ONE_BY_ONE_PNG,
          name: "Smoke image",
          x: 520,
          y: 120,
          width: 240,
          height: 140,
          fit: "cover",
          zIndex: 4,
        }),
      ],
    };

    const previewHtml = renderToStaticMarkup(
      React.createElement(canvasModule.CimBuilderPagePreview, { page }),
    );
    assert.match(previewHtml, /Smoke image/);
    assert.match(previewHtml, /data:image\/png;base64/);
    assert.match(previewHtml, /object-fit:cover/);
    assert.doesNotMatch(previewHtml, /Image missing/);

    const editorHtml = renderToStaticMarkup(
      React.createElement(canvasModule.default, {
        slideKey: "smoke",
        page,
        pageTabs: [{ index: 0, label: "Template" }],
        activePageIndex: 0,
        onChange: () => {},
      }),
    );
    assert.match(editorHtml, /Smoke image/);
    assert.match(editorHtml, /data:image\/png;base64/);
    assert.match(editorHtml, /Editable smoke text/);
    assert.match(editorHtml, /Undo/);
    assert.match(editorHtml, /Redo/);
    assert.match(editorHtml, /Add text/);
    assert.match(editorHtml, /Set background image/);
    assert.match(editorHtml, /Bg opacity/);
    assert.match(editorHtml, /75%/);
    assert.doesNotMatch(editorHtml, /Image missing/);

    const slide1SourceLayout = JSON.parse(readFileSync("public/cim-template/layouts/source-slide-01.layout.json", "utf8"));
    const slide1PreparedLayout = workspaceModule.prepareCimLayout(1, slide1SourceLayout);
    const slide1AdvisorContactRuns = slide1PreparedLayout.elements
      .filter((element) => [18, 19].includes(Number(element.order || 0)))
      .flatMap((element) => element.paragraphs || [])
      .flatMap((paragraph) => paragraph.runs || []);
    assert.ok(slide1AdvisorContactRuns.length > 0);
    assert.deepEqual(Array.from(new Set(slide1AdvisorContactRuns.map((run) => run.color))), ["#6D6E71"]);
    const slide1CompanyNameRuns = slide1PreparedLayout.elements
      .filter((element) => Number(element.order || 0) === 11)
      .flatMap((element) => element.paragraphs || [])
      .flatMap((paragraph) => paragraph.runs || []);
    assert.deepEqual(Array.from(new Set(slide1CompanyNameRuns.map((run) => Number(run.fontSize)))), [30]);
    const slide1BuilderFields = workspaceModule.extractTemplateFields(1, slide1PreparedLayout);
    assert.equal(slide1BuilderFields.some((field) => Number(field.order || 0) === 7), false);
    const slide1BuilderElements = workspaceModule.buildCimBuilderElementSpecs(
      1,
      slide1PreparedLayout,
      slide1BuilderFields,
      {},
      {},
      {},
      {},
      null,
    );
    assert.equal(slide1BuilderElements.find((element) => element.id === "template:1:12")?.fontSize, 30);
    const fetchedDescriptor = "B2B software platform serving North America";
    const slide1DescriptorElements = workspaceModule.buildCimBuilderElementSpecs(
      1,
      slide1PreparedLayout,
      slide1BuilderFields,
      {
        "1:sh/u9knih4b:ppt-text": "Old separate descriptor value",
      },
      {},
      {},
      { descriptor: fetchedDescriptor },
      null,
    );
    const slide1DescriptorElement = slide1DescriptorElements.find((element) => element.id === "template:1:8");
    assert.equal(slide1DescriptorElement?.text, fetchedDescriptor);

    const slide1DescriptorPage = workspaceModule.buildCimBuilderPage([slide1DescriptorElement], {
      elementOverrides: {
        "template:1:8": {
          ...slide1DescriptorElement,
          text: "Old builder override descriptor",
          y: Number(slide1DescriptorElement.y || 0) + 12,
        },
      },
    });
    const mergedDescriptorElement = slide1DescriptorPage.elements.find((element) => element.id === "template:1:8");
    assert.equal(mergedDescriptorElement.text, fetchedDescriptor);
    assert.equal(mergedDescriptorElement.y, Number(slide1DescriptorElement.y || 0) + 12);

    const slide6SourceLayout = JSON.parse(readFileSync("public/cim-template/layouts/source-slide-06.layout.json", "utf8"));
    const slide6PreparedLayout = workspaceModule.prepareCimLayout(6, slide6SourceLayout);
    const slide6Fields = workspaceModule.extractTemplateFields(6, slide6PreparedLayout);
    const slide6Elements = workspaceModule.buildCimBuilderElementSpecs(
      6,
      slide6PreparedLayout,
      slide6Fields,
      {},
      {},
      {},
      {},
      null,
    );
    for (const elementId of ["template:6:7", "template:6:10", "template:6:32"]) {
      const editableElement = slide6Elements.find((element) => element.id === elementId);
      assert.ok(editableElement?.cimFieldId?.endsWith(":ppt-text"), `${elementId} should support direct full-text editing`);
    }
    const slide6Subtitle = slide6Elements.find((element) => element.id === "template:6:7");
    const editedSlide6Values = workspaceModule.applyCimBuilderElementsToFieldValues([
      { ...slide6Subtitle, text: "Edited subtitle from builder" },
    ]);
    assert.equal(editedSlide6Values[slide6Subtitle.cimFieldId], "Edited subtitle from builder");

    const slide8TemplateSourceLayout = JSON.parse(readFileSync("public/cim-template/layouts/source-slide-08.layout.json", "utf8"));
    const slide8TemplatePreparedLayout = workspaceModule.prepareCimLayout(8, slide8TemplateSourceLayout);
    const slide8TemplateFields = workspaceModule.extractTemplateFields(8, slide8TemplatePreparedLayout);
    const slide8TemplateElements = workspaceModule.buildCimBuilderElementSpecs(
      8,
      slide8TemplatePreparedLayout,
      slide8TemplateFields,
      {},
      {},
      {},
      {},
      null,
    );
    for (const elementId of [
      "template:8:6",
      "template:8:7",
      "template:8:9",
      "template:8:10",
      "template:8:13",
      "template:8:17",
      "template:8:21",
      "template:8:25",
      "template:8:29",
      "template:8:33",
    ]) {
      const editableElement = slide8TemplateElements.find((element) => element.id === elementId);
      assert.ok(editableElement?.cimFieldId?.endsWith(":ppt-text"), `${elementId} should support direct full-text editing`);
    }

    for (let slideNumber = 1; slideNumber <= workspaceModule.TEMPLATE_SLIDE_COUNT; slideNumber += 1) {
      const sourceLayout = JSON.parse(readFileSync(
        `public/cim-template/layouts/source-slide-${String(slideNumber).padStart(2, "0")}.layout.json`,
        "utf8",
      ));
      const preparedLayout = workspaceModule.prepareCimLayout(slideNumber, sourceLayout);
      const fontSizes = [];
      const collectFontSizes = (value) => {
        if (Array.isArray(value)) {
          value.forEach(collectFontSizes);
          return;
        }
        if (!value || typeof value !== "object") return;
        Object.entries(value).forEach(([key, child]) => {
          if (key === "fontSize" || key === "resolvedFontSize") {
            fontSizes.push(Number(child));
            return;
          }
          collectFontSizes(child);
        });
      };
      collectFontSizes(preparedLayout);
      assert.ok(fontSizes.length > 0, `slide ${slideNumber} should expose font sizes`);
      assert.ok(fontSizes.every(Number.isInteger), `slide ${slideNumber} should only use whole-number font sizes`);

      const fields = workspaceModule.extractTemplateFields(slideNumber, preparedLayout);
      const elements = workspaceModule.buildCimBuilderElementSpecs(
        slideNumber,
        preparedLayout,
        fields,
        {},
        {},
        {},
        {},
        null,
      );
      const linkedTextWithoutDirectEditor = elements.filter((element) => (
        element.type === "text" &&
        element.cimKind === "text" &&
        element.cimLinkedFieldIds?.length &&
        !element.cimFieldId
      ));
      assert.equal(
        linkedTextWithoutDirectEditor.length,
        0,
        `slide ${slideNumber} regular linked text boxes should support direct full-text editing`,
      );
    }

    const slide3SourceLayout = JSON.parse(readFileSync("public/cim-template/layouts/source-slide-03.layout.json", "utf8"));
    const slide3PreparedLayout = workspaceModule.prepareCimLayout(3, slide3SourceLayout);
    const tocStyles = [
      { orders: [6, 10, 14, 18, 22, 26, 30, 34, 38, 42], fontSize: 24, color: "#8BC53D", bold: true },
      { orders: [7, 11, 15, 19, 23, 27, 31, 35, 39, 43], fontSize: 16, color: "#2F3033", bold: true },
      { orders: [8, 12, 16, 20, 24, 28, 32, 36, 40, 44], fontSize: 11, color: "#8C8D90", bold: false },
    ];
    for (const expectedStyle of tocStyles) {
      const orderSet = new Set(expectedStyle.orders);
      const runs = slide3PreparedLayout.elements
        .filter((element) => orderSet.has(Number(element.order || 0)))
        .flatMap((element) => element.paragraphs || [])
        .flatMap((paragraph) => paragraph.runs || []);
      assert.equal(runs.length, 10);
      assert.deepEqual(Array.from(new Set(runs.map((run) => Number(run.fontSize)))), [expectedStyle.fontSize]);
      assert.deepEqual(Array.from(new Set(runs.map((run) => run.color))), [expectedStyle.color]);
      assert.deepEqual(Array.from(new Set(runs.map((run) => Boolean(run.bold)))), [expectedStyle.bold]);
    }

    const tocOverrideBase = [
      modelModule.createBuilderElement("text", {
        id: "template:3:12",
        text: "Company Overview",
        fontSize: 16,
        fill: "#2F3033",
        fontWeight: 700,
      }),
      modelModule.createBuilderElement("text", {
        id: "template:3:13",
        text: "History, milestones, corporate structure, and ownership",
        fontSize: 11,
        fill: "#8C8D90",
        fontWeight: 400,
      }),
      modelModule.createBuilderElement("text", {
        id: "template:3:16",
        text: "Products & Services",
        fontSize: 16,
        fill: "#2F3033",
        fontWeight: 700,
      }),
      modelModule.createBuilderElement("text", {
        id: "template:3:17",
        text: "Portfolio overview, competitive differentiation, and positioning",
        fontSize: 11,
        fill: "#8C8D90",
        fontWeight: 400,
      }),
    ];
    const tocOverridePage = workspaceModule.buildCimBuilderPage(tocOverrideBase, {
      elementOverrides: Object.fromEntries(tocOverrideBase.map((element) => [element.id, {
        ...element,
        fontSize: 24,
        fill: "#8BC53D",
        fontWeight: 400,
      }])),
    });
    const tocOverrideById = Object.fromEntries(tocOverridePage.elements.map((element) => [element.id, element]));
    assert.equal(tocOverrideById["template:3:12"].fontSize, 16);
    assert.equal(tocOverrideById["template:3:12"].fill, "#2F3033");
    assert.equal(tocOverrideById["template:3:12"].fontWeight, 700);
    assert.equal(tocOverrideById["template:3:13"].fontSize, 11);
    assert.equal(tocOverrideById["template:3:13"].fill, "#8C8D90");
    assert.equal(tocOverrideById["template:3:13"].fontWeight, 400);
    assert.equal(tocOverrideById["template:3:16"].fontSize, 16);
    assert.equal(tocOverrideById["template:3:16"].fill, "#2F3033");
    assert.equal(tocOverrideById["template:3:17"].fontSize, 11);
    assert.equal(tocOverrideById["template:3:17"].fill, "#8C8D90");

    const historicalIncomeTable = {
      slide: { backgroundColor: "#FFFFFF" },
      elements: [{
        id: "historical-income-table",
        kind: "table",
        order: 7,
        rows: 2,
        cols: 7,
        bbox: [20, 80, 840, 120],
        text: [
          "Historical Income Statement | [FY] | [FY] | [FY] | [FY] | [FY] | LTM [Date]",
          "Revenue | [Revenue] | [Revenue] | [Revenue] | [Revenue] | [Revenue] | [Revenue]",
        ].join("\n"),
        cells: Array.from({ length: 2 }, (_, rowIndex) =>
          Array.from({ length: 7 }, (_, colIndex) => {
            const cellTexts = [
              ["Historical Income Statement", "[FY]", "[FY]", "[FY]", "[FY]", "[FY]", "LTM [Date]"],
              ["Revenue", "[Revenue]", "[Revenue]", "[Revenue]", "[Revenue]", "[Revenue]", "[Revenue]"],
            ];
            return {
              index: rowIndex * 7 + colIndex + 1,
              row: rowIndex + 1,
              column: colIndex + 1,
              bbox: [20 + colIndex * 120, 80 + rowIndex * 32, 120, 32],
              text: cellTexts[rowIndex][colIndex],
              fillColor: rowIndex === 0 ? "#476E2C" : "#FFFFFF",
              lineColor: "#D9DEE6",
              lineWidth: 1,
              resolvedTextStyle: {
                alignment: colIndex === 0 ? "left" : "center",
                verticalAlignment: "middle",
                insets: { top: 0, right: 4, bottom: 0, left: 4 },
              },
              paragraphs: [{
                resolvedTextStyle: { alignment: colIndex === 0 ? "left" : "center" },
                runs: [{
                  text: cellTexts[rowIndex][colIndex],
                  fontSize: 12,
                  typeface: "Calibri",
                  color: rowIndex === 0 ? "#FFFFFF" : "#333333",
                  bold: rowIndex === 0,
                }],
              }],
            };
          }),
        ).flat(),
      }],
    };
    const tableFields = workspaceModule.extractTemplateFields(24, historicalIncomeTable);
    const tableValuesByIndex = {
      0: "FY2021",
      1: "FY2022",
      2: "FY2023",
      3: "FY2024",
      4: "FY2025",
      5: "Jun. 30, 2026",
      6: "$1.0M",
      7: "$1.2M",
      8: "$1.4M",
      9: "$1.6M",
      10: "$1.8M",
      11: "$2.0M",
    };
    const tableFieldValues = Object.fromEntries(tableFields.map((field) => {
      const tokenIndex = Number(String(field.id).match(/:token:(\d+):/)?.[1] ?? -1);
      return [field.valueFieldId || field.id, tableValuesByIndex[tokenIndex] || ""];
    }));
    const tableSpecs = workspaceModule.buildCimBuilderElementSpecs(
      24,
      historicalIncomeTable,
      tableFields,
      tableFieldValues,
      {},
      {},
      {},
      null,
    );
    const resolvedTableText = tableSpecs
      .filter((element) => element.cimKind === "tableCell")
      .map((element) => element.text)
      .join(" | ");
    assert.match(resolvedTableText, /Historical Income Statement/);
    assert.match(resolvedTableText, /FY2021/);
    assert.match(resolvedTableText, /LTM Jun\. 30, 2026/);
    assert.match(resolvedTableText, /\$2\.0M/);
    assert.doesNotMatch(resolvedTableText, /\[(FY|Revenue|Date)\]/);

    const slide8Layout = {
      slide: { backgroundColor: "#FFFFFF" },
      elements: [
        {
          id: "company-position",
          kind: "shape",
          order: 6,
          bbox: [50, 80, 420, 80],
          text: "Overview [Company] founded [Year] with [Position]",
          resolvedFontSize: 18,
          paragraphs: [{
            runs: [{
              text: "Overview [Company] founded [Year] with [Position]",
              fontSize: 18,
              typeface: "Calibri",
              color: "#111827",
            }],
          }],
        },
        {
          id: "founded-metric",
          kind: "shape",
          order: 12,
          bbox: [80, 210, 240, 48],
          text: "Founded [Year]",
          resolvedFontSize: 22,
          paragraphs: [{
            runs: [{
              text: "Founded [Year]",
              fontSize: 22,
              typeface: "Calibri",
              color: "#111827",
            }],
          }],
        },
      ],
    };
    const slide8Fields = workspaceModule.extractTemplateFields(8, slide8Layout);
    const foundedYearSourceField = slide8Fields.find((field) => field.order === 6 && /:token:1:/.test(field.id));
    assert.ok(foundedYearSourceField, "slide 8 source founded-year field should exist");
    const foundedMetricField = slide8Fields.find((field) => field.order === 12 && /:token:0:/.test(field.id));
    assert.equal(foundedMetricField.valueFieldId, foundedYearSourceField.id);
    const slide8Specs = workspaceModule.buildCimBuilderElementSpecs(
      8,
      slide8Layout,
      slide8Fields,
      { [foundedYearSourceField.id]: "1999" },
      {},
      {},
      {},
      null,
    );
    const foundedMetricSpec = slide8Specs.find((element) => String(element.id || "").includes("founded-metric"));
    assert.equal(foundedMetricSpec.text, "Founded 1999");
    assert.deepEqual(foundedMetricSpec.cimLinkedFieldIds, [foundedYearSourceField.id]);

    const slide1LogoLayout = {
      slide: { backgroundColor: "#FFFFFF" },
      elements: [{
        id: "company-logo-placeholder",
        kind: "shape",
        order: 8,
        bbox: [60, 540, 180, 72],
        text: "[Company Logo]",
        resolvedFontSize: 12,
        paragraphs: [{
          runs: [{
            text: "[Company Logo]",
            fontSize: 12,
            typeface: "Calibri",
            color: "#8A8F98",
          }],
        }],
      }],
    };
    const slide1LogoFields = workspaceModule.extractTemplateFields(1, slide1LogoLayout);
    const companyLogoField = slide1LogoFields.find((field) => field.fieldKind === "asset");
    assert.ok(companyLogoField, "slide 1 company logo asset field should exist");
    const logoPlaceholderSpecs = workspaceModule.buildCimBuilderElementSpecs(
      1,
      slide1LogoLayout,
      slide1LogoFields,
      {},
      {},
      {},
      {},
      null,
    );
    const logoPlaceholder = logoPlaceholderSpecs.find((element) => element.cimKind === "assetPlaceholder");
    assert.equal(logoPlaceholder.cimAssetKey, "company-logo");
    assert.equal(logoPlaceholder.cimAssetFieldId, companyLogoField.id);
    assert.equal(logoPlaceholder.src, "");

    const logoImageSpecs = workspaceModule.buildCimBuilderElementSpecs(
      1,
      slide1LogoLayout,
      slide1LogoFields,
      {},
      { "company-logo": { dataUrl: ONE_BY_ONE_PNG, name: "Company logo" } },
      {},
      {},
      null,
    );
    const logoImage = logoImageSpecs.find((element) => element.cimAssetKey === "company-logo");
    assert.equal(logoImage.cimKind, "image");
    assert.equal(logoImage.src, ONE_BY_ONE_PNG);

    const blob = exportModule.buildCimPptxBlob({
      layouts: {
        1: {
          slide: {
            backgroundColor: page.backgroundColor,
            backgroundImage: { dataUrl: page.backgroundImage },
            backgroundImageOpacity: page.backgroundImageOpacity,
          },
          elements: [
            {
              id: "text-1",
              kind: "shape",
              order: 1,
              bbox: [40, 42, 360, 72],
              text: "Editable smoke text",
              resolvedFontSize: 20,
              paragraphs: [{ runs: [{ text: "Editable smoke text", fontSize: 20, color: "#111827" }] }],
            },
            {
              id: "shape-1",
              kind: "shape",
              order: 2,
              bbox: [60, 150, 220, 90],
              fillColor: "#EEF6E0",
              lineColor: "#8BC53D",
              lineWidth: 2,
            },
            {
              id: "line-1",
              kind: "shape",
              order: 3,
              bbox: [330, 280, 180, -70],
              lineColor: "#111827",
              lineWidth: 3,
            },
            {
              id: "image-1",
              kind: "shape",
              builderKind: "image",
              order: 4,
              bbox: [520, 120, 240, 140],
              dataUrl: ONE_BY_ONE_PNG,
              imageFit: "cover",
            },
          ],
        },
      },
      slideNumbers: [1],
      getElementContent: (_slideRef, element) => {
        if (element.builderKind === "image") {
          return { kind: "image", dataUrl: element.dataUrl, name: "Smoke image" };
        }
        return { kind: "text", text: element.text || "" };
      },
    });

    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const slideXml = strFromU8(files["ppt/slides/slide1.xml"]);
    const relXml = strFromU8(files["ppt/slides/_rels/slide1.xml.rels"]);
    assert.match(slideXml, /Editable smoke text/);
    assert.match(slideXml, /<p:pic>/);
    assert.match(slideXml, /<p:sp>/);
    assert.match(slideXml, /<a:srcRect/);
    assert.match(relXml, /image1\.png/);
    assert.match(relXml, /image2\.png/);
  } finally {
    await vite.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
