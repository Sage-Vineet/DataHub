import assert from "node:assert/strict";
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
    const modelModule = await vite.ssrLoadModule("/src/lib/cimNativeBuilderModel.js");
    const workspaceModule = await vite.ssrLoadModule("/src/pages/broker/workspace/WorkspaceCimPrep.jsx");

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
