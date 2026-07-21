const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAspose, loadJava, ensureLicense } = require("./asposeSlidesRuntime");

let aspose = null;
let java = null;

// slide4 = { elements: [{ bbox: [left, top, width, height], text }] }
function buildPocSlide4Text(slide, slide4) {
  const elements = Array.isArray(slide4?.elements) ? slide4.elements : [];
  elements.forEach((element) => {
    const [left, top, width, height] = element.bbox || [0, 0, 0, 0];
    const shape = slide.getShapes().addAutoShape(
      aspose.slides.ShapeType.Rectangle,
      left, top, Math.max(width, 1), Math.max(height, 1),
    );
    // Fill/line styling is deliberately left at Aspose's defaults for this
    // POC -- the point being proven is text autofit/clipping behavior, not
    // visual fidelity to the CIM theme.
    shape.getTextFrame().setText(String(element.text || ""));
  });
}

// slide24 = { rows, cols, bbox: [left, top, width, height], matrix: string[][] }
function buildPocSlide24Table(slide, slide24) {
  const rows = Number(slide24?.rows || 0);
  const cols = Number(slide24?.cols || 0);
  const [left, top, width, height] = slide24?.bbox || [0, 0, 0, 0];
  if (!rows || !cols) return;

  const colWidth = width / cols;
  const rowHeight = height / rows;
  const dblCols = java.newArray("double", Array(cols).fill(colWidth));
  const dblRows = java.newArray("double", Array(rows).fill(rowHeight));
  const table = slide.getShapes().addTable(left, top, dblCols, dblRows);

  const matrix = Array.isArray(slide24.matrix) ? slide24.matrix : [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cellText = matrix[r]?.[c] ?? "";
      // Aspose addresses table cells as (column, row), confirmed against the
      // official sample syntax (tbl.get_Item(1, 0)).
      table.get_Item(c, r).getTextFrame().setText(String(cellText));
    }
  }
}

// slide6 = { bbox: [left, top, width, height], title, categories: string[], series: [{name, values:number[]}] }
function buildPocSlide6Chart(slide, slide6) {
  const [left, top, width, height] = slide6?.bbox || [0, 0, 500, 350];
  const chart = slide.getShapes().addChart(
    aspose.slides.ChartType.ClusteredColumn,
    left, top, Math.max(width, 1), Math.max(height, 1),
  );
  chart.getChartTitle().addTextFrameForOverriding(String(slide6?.title || ""));

  const workbook = chart.getChartData().getChartDataWorkbook();
  chart.getChartData().getSeries().clear();
  chart.getChartData().getCategories().clear();

  const categories = Array.isArray(slide6?.categories) ? slide6.categories : [];
  const series = Array.isArray(slide6?.series) ? slide6.series : [];

  categories.forEach((category, rowIndex) => {
    chart.getChartData().getCategories().add(workbook.getCell(0, rowIndex + 1, 0, category));
  });

  series.forEach((seriesInput, seriesIndex) => {
    const seriesObj = chart.getChartData().getSeries().add(
      workbook.getCell(0, 0, seriesIndex + 1, seriesInput.name),
      chart.getType(),
    );
    (seriesInput.values || []).forEach((value, rowIndex) => {
      seriesObj.getDataPoints().addDataPointForBarSeries(
        workbook.getCell(0, rowIndex + 1, seriesIndex + 1, Number(value) || 0),
      );
    });
  });
}

// Generates the 3-slide POC deck and returns it as a Buffer. Aspose's Node
// bridge writes to a real filesystem path (there is no in-memory-stream save
// option), so this uses a scratch file under os.tmpdir() and cleans it up
// afterward -- there's no existing local-temp-file convention in this backend
// to reuse (uploads go straight to Supabase storage).
async function generatePocPptx({ slide4, slide6, slide24 }) {
  ensureLicense();
  aspose = loadAspose();
  java = loadJava();

  const pres = new aspose.slides.Presentation();
  const tmpPath = path.join(os.tmpdir(), `cim-aspose-poc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pptx`);

  try {
    const slideText = pres.getSlides().get_Item(0);
    buildPocSlide4Text(slideText, slide4);

    const slideTable = pres.getSlides().addEmptySlide(pres.getLayoutSlides().get_Item(0));
    buildPocSlide24Table(slideTable, slide24);

    const slideChart = pres.getSlides().addEmptySlide(pres.getLayoutSlides().get_Item(0));
    buildPocSlide6Chart(slideChart, slide6);

    pres.save(tmpPath, aspose.slides.SaveFormat.Pptx);
  } finally {
    pres.dispose();
  }

  try {
    return await fs.promises.readFile(tmpPath);
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = { generatePocPptx };
