import { parseBalanceSheetDetailFromAllReports } from "../src/lib/report-parsers.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Regression check:
// Some QuickBooks BalanceSheet payloads omit `type` fields on Section rows.
// The detail parser should still produce groups/accounts for rendering.
const payload = {
  BalanceSheet: {
    Header: { EndPeriod: "2026-04-10" },
    Rows: {
      Row: [
        {
          Header: { ColData: [{ value: "ASSETS" }] },
          Rows: {
            Row: [
              {
                Header: { ColData: [{ value: "Current Assets" }] },
                Rows: {
                  Row: [
                    {
                      Header: { ColData: [{ value: "Bank Accounts" }] },
                      Rows: {
                        Row: [
                          {
                            ColData: [
                              { value: "Checking", id: "35" },
                              { value: "1201.00" },
                            ],
                          },
                        ],
                      },
                      Summary: {
                        ColData: [
                          { value: "Total Bank Accounts" },
                          { value: "1201.00" },
                        ],
                      },
                    },
                  ],
                },
                Summary: {
                  ColData: [
                    { value: "Total Current Assets" },
                    { value: "1201.00" },
                  ],
                },
              },
            ],
          },
          Summary: { ColData: [{ value: "TOTAL ASSETS" }, { value: "1201.00" }] },
        },
      ],
    },
  },
  GeneralLedger: {
    Header: { EndPeriod: "2026-04-10" },
    Rows: {
      Row: [
        {
          type: "Section",
          Header: { ColData: [{ value: "Checking", id: "35" }] },
          Rows: { Row: [{ type: "Data", ColData: [{ value: "Beginning Balance" }] }] },
        },
      ],
    },
  },
};

const parsed = parseBalanceSheetDetailFromAllReports(payload, "2026-04-10");
assert(Array.isArray(parsed?.groups), "Expected `groups` array");
assert(parsed.groups.length === 1, "Expected 1 group");
assert(parsed.groups[0]?.name === "Current Assets", "Expected group name `Current Assets`");
assert(Array.isArray(parsed.groups[0]?.accounts), "Expected `accounts` array");
assert(parsed.groups[0].accounts.length === 1, "Expected 1 account");
assert(parsed.groups[0].accounts[0]?.name === "Checking", "Expected account name `Checking`");

console.log("OK: BalanceSheet detail parser produced groups/accounts.");

