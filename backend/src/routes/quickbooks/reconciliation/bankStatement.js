const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const XLSX = require("xlsx");
const path = require("path");
const os = require("os");
const pool = require("../../../db");
@@ -527,62 +526,6 @@ router.post(
const password = req.body.password || "";

console.log(`📁 Processing Excel file: ${req.file.originalname}`);

        if (lowerFileName.endsWith(".xlsx") || lowerFileName.endsWith(".xls")) {
          const workbook = XLSX.readFile(filePath, {
            password: password || undefined,
          });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: "",
          });

          let dateCol = 0,
            narrationCol = 1,
            withdrawCol = 4,
            depositCol = 5;
          const headerRow = rows.find((r) =>
            r.some((c) => String(c).toLowerCase().includes("date")),
          );
          if (headerRow) {
            headerRow.forEach((cell, idx) => {
              const c = String(cell).toLowerCase();
              if (c.includes("date") && !c.includes("value")) dateCol = idx;
              if (c.includes("narration") || c.includes("description"))
                narrationCol = idx;
              if (c.includes("withdrawal") || c.includes("debit"))
                withdrawCol = idx;
              if (c.includes("deposit") || c.includes("credit"))
                depositCol = idx;
            });
          }

          rows.forEach((row) => {
            const date = row[dateCol];
            const narration = row[narrationCol];
            const withdraw = normalizeAmount(row[withdrawCol]);
            const deposit = normalizeAmount(row[depositCol]);

            let amount = 0;
            if (withdraw) amount = -withdraw;
            if (deposit) amount = deposit;

            if (date && narration && amount !== 0) {
              transactions.push({
                date,
                narration: String(narration).trim(),
                amount,
              });
            }
          });

          console.log(
            `✓ Excel file processed: ${transactions.length} transactions extracted`,
          );
        } else {
          console.warn(`⚠ Unsupported file format: ${req.file.originalname}`);
        }
}

console.log("Total Transactions Extracted:", transactions.length);
