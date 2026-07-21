const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAspose, loadJava, ensureLicense } = require("./asposeSlidesRuntime");

let aspose = null;
let java = null;

function findShapesByExactName(slide, name) {
  const matches = [];
  const shapes = slide.getShapes();
  for (let i = 0; i < shapes.size(); i += 1) {
    const shape = shapes.get_Item(i);
    if (shape.getName() === name) matches.push(shape);
  }
  return matches;
}

function findShapesByNamePrefix(slide, prefix) {
  const matches = [];
  const shapes = slide.getShapes();
  for (let i = 0; i < shapes.size(); i += 1) {
    const shape = shapes.get_Item(i);
    if (String(shape.getName() || "").startsWith(prefix)) matches.push(shape);
  }
  return matches;
}

// tableSpec = { shapeTag, bbox: [left, top, width, height], rows, cols, matrix: string[][] }
function buildNativeTable(slide, tableSpec) {
  const rows = Number(tableSpec?.rows || 0);
  const cols = Number(tableSpec?.cols || 0);
  const [left, top, width, height] = tableSpec?.bbox || [0, 0, 0, 0];
  if (!rows || !cols) return;

  const colWidth = width / cols;
  const rowHeight = height / rows;
  const dblCols = java.newArray("double", Array(cols).fill(colWidth));
  const dblRows = java.newArray("double", Array(rows).fill(rowHeight));
  const table = slide.getShapes().addTable(left, top, dblCols, dblRows);

  const matrix = Array.isArray(tableSpec.matrix) ? tableSpec.matrix : [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const cellText = matrix[r]?.[c] ?? "";
      // Aspose addresses table cells as (column, row).
      table.get_Item(c, r).getTextFrame().setText(String(cellText));
    }
  }
}

// chartSpec = { shapeTag, bbox, type: "bar"|"line"|"pie"|"waterfall", title, categories: string[], series: [{name, values:number[]}] }
function buildNativeChart(slide, chartSpec) {
  const [left, top, width, height] = chartSpec?.bbox || [0, 0, 500, 350];
  const categories = Array.isArray(chartSpec?.categories) ? chartSpec.categories : [];
  const series = Array.isArray(chartSpec?.series) ? chartSpec.series : [];

  const aspType = {
    bar: aspose.slides.ChartType.ClusteredColumn,
    line: aspose.slides.ChartType.Line,
    pie: aspose.slides.ChartType.Pie,
    waterfall: aspose.slides.ChartType.Waterfall,
  }[chartSpec?.type] || aspose.slides.ChartType.ClusteredColumn;

  const chart = slide.getShapes().addChart(aspType, left, top, Math.max(width, 1), Math.max(height, 1));
  chart.getChartTitle().addTextFrameForOverriding(String(chartSpec?.title || ""));

  const workbook = chart.getChartData().getChartDataWorkbook();
  chart.getChartData().getSeries().clear();
  chart.getChartData().getCategories().clear();

  categories.forEach((category, rowIndex) => {
    chart.getChartData().getCategories().add(workbook.getCell(0, rowIndex + 1, 0, category));
  });

  // pie/waterfall are always single-series in this app's data model (only
  // row.values[0] is ever used -- see buildPieChart/buildWaterfallChart in
  // WorkspaceCimPrep.jsx), so only the first series is used for those types
  // even if more were somehow supplied.
  const seriesToBuild = (chartSpec?.type === "pie" || chartSpec?.type === "waterfall")
    ? series.slice(0, 1)
    : series;

  seriesToBuild.forEach((seriesInput, seriesIndex) => {
    const seriesObj = chart.getChartData().getSeries().add(
      workbook.getCell(0, 0, seriesIndex + 1, seriesInput.name),
      chart.getType(),
    );
    const values = seriesInput.values || [];

    if (chartSpec.type === "waterfall") {
      values.forEach((value, rowIndex) => {
        const dataPoint = seriesObj.getDataPoints().addDataPointForWaterfallSeries(
          workbook.getCell(0, rowIndex + 1, seriesIndex + 1, Number(value) || 0),
        );
        // Matches buildWaterfallChart's exact semantics: only the first and
        // last bar are totals, everything between is a running delta.
        if (rowIndex === 0 || rowIndex === values.length - 1) {
          dataPoint.setSetAsTotal(true);
        }
      });
    } else if (chartSpec.type === "pie") {
      values.forEach((value, rowIndex) => {
        seriesObj.getDataPoints().addDataPointForPieSeries(
          workbook.getCell(0, rowIndex + 1, seriesIndex + 1, Number(value) || 0),
        );
      });
    } else if (chartSpec.type === "line") {
      values.forEach((value, rowIndex) => {
        seriesObj.getDataPoints().addDataPointForLineSeries(
          workbook.getCell(0, rowIndex + 1, seriesIndex + 1, Number(value) || 0),
        );
      });
    } else {
      values.forEach((value, rowIndex) => {
        seriesObj.getDataPoints().addDataPointForBarSeries(
          workbook.getCell(0, rowIndex + 1, seriesIndex + 1, Number(value) || 0),
        );
      });
    }
  });
}

// Loads the legacy-exporter's own PPTX output and surgically replaces every
// tagged table/chart shape with a genuine native OOXML equivalent, leaving
// everything else (text, images, backgrounds, watermarks) exactly as the
// legacy exporter produced it. `slides` = the manifest's `slides` array
// (see buildAsposeSpliceManifest in WorkspaceCimPrep.jsx).
async function spliceNativeTablesAndCharts({ basePptxPath, slides }) {
  ensureLicense();
  aspose = loadAspose();
  java = loadJava();

  const warnings = [];
  const pres = new aspose.slides.Presentation(basePptxPath);
  const outputPath = path.join(os.tmpdir(), `cim-aspose-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pptx`);

  try {
    (slides || []).forEach((slideSpec) => {
      const slide = pres.getSlides().get_Item(slideSpec.slideIndex - 1);
      if (!slide) {
        warnings.push(`Slide index ${slideSpec.slideIndex} not found in base presentation.`);
        return;
      }

      (slideSpec.tables || []).forEach((tableSpec) => {
        const cellShapes = findShapesByNamePrefix(slide, `${tableSpec.shapeTag}::cell::`);
        if (!cellShapes.length) {
          warnings.push(`No shapes found for table ${tableSpec.shapeTag} -- left legacy rendering in place.`);
          return;
        }
        cellShapes.forEach((shape) => slide.getShapes().remove(shape));
        buildNativeTable(slide, tableSpec);
      });

      (slideSpec.charts || []).forEach((chartSpec) => {
        const chartShapes = findShapesByExactName(slide, chartSpec.shapeTag);
        if (!chartShapes.length) {
          warnings.push(`No shape found for chart ${chartSpec.shapeTag} -- left legacy rendering in place.`);
          return;
        }
        chartShapes.forEach((shape) => slide.getShapes().remove(shape));
        buildNativeChart(slide, chartSpec);
      });
    });

    pres.save(outputPath, aspose.slides.SaveFormat.Pptx);
  } finally {
    pres.dispose();
  }

  if (warnings.length) {
    console.warn("[Aspose Export] splice warnings:", warnings);
  }

  try {
    return await fs.promises.readFile(outputPath);
  } finally {
    fs.promises.unlink(outputPath).catch(() => {});
  }
}

module.exports = { spliceNativeTablesAndCharts };
