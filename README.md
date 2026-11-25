# SNS Agro — Real-Time Monthly Overall & Payroll Dashboard

A zero-dependency, real-time web dashboard for Windows that syncs live with Google Sheets to generate **Summary #1: Monthly Overall Report** and **Summary #2: Monthly Payroll Report**.

## Features

- **Real-Time Google Sheets Sync**
  - Polls all three Google Sheets in parallel (default every `15s`, configurable in the UI to `10s`, `15s`, `30s`, `60s`, or `Paused`) plus instant **Sync Now**.
  - Detects any added row, edited quantity, or updated unit price/cash flow via SHA-256 snapshot hashing and refreshes the UI automatically.
- **Summary #1 — Monthly Overall Report (`Job Type` rates)**
  - Lists every job type from `Job Type.gsheet` with **Cash Flow `In` = Positive (`+`)** and **`Out` = Negative (`−`)**.
  - Interactive Month Filter pills (`All Months` or any active month) + **Monthly Overall Matrix** across all months with **Amount (RM)** / **Quantity** toggle and Grand Total.
  - Monthly Inflow vs Outflow SVG charts, clickable job-type transaction drill-down drawer, and CSV export.
- **Summary #2 — Monthly Payroll Report (`Upah` rates)**
  - Aggregates worker earnings (`In = +`) and advances/deductions (`Out = −`) using live rates from `Upah.gsheet`.
  - Automatically merges case differences in worker names (e.g. `ali bin ahmad` → `Ali Bin Ahmad`).
  - Separates company/non-worker entries (`SNS Agro`) out of Worker Payroll totals into a dedicated **Company / Non-Worker Entries** card for 100% reconciliation.
  - Expandable per-worker job breakdown, printable individual **Worker Payslip**, **Monthly Payroll Matrix** (`Net Payable` / `Earnings (+)` / `Deductions (−)`), and CSV export.
- **Live Entries & Rate Cards**
  - Inspect live `Job Type` and `Upah` rate cards side by side and search/export the full live ledger with both Overall and Payroll amounts calculated per row.

## Prerequisites

- **Windows 10 / 11** with built-in Windows PowerShell 5.1 & .NET Framework (no Node.js or Python installation required).
- Authenticated **`gsheets` CLI** installed (either on `PATH`, at `%USERPROFILE%\.gemini\antigravity\bin\gsheets.cmd`, or pointed to via the `GSHEETS_CLI` environment variable).

## Quick Start

1. **Clone or download this repository.**
2. **Create your local config from the example template:**
   ```powershell
   Copy-Item config.example.json config.json
   ```
3. **Edit `config.json`** and replace the placeholder IDs with your Google Spreadsheet IDs (the segment between `/d/` and `/edit` in each Google Sheets URL):
   ```json
   {
     "port": 8765,
     "pollIntervalSeconds": 15,
     "spreadsheets": {
       "completedEntries": { "id": "<SPREADSHEET_ID>", "name": "Completed Jom Entry", "range": "Sheet1!A1:H" },
       "jobTypes":         { "id": "<SPREADSHEET_ID>", "name": "Job Type",            "range": "Sheet1!A1:D" },
       "upah":             { "id": "<SPREADSHEET_ID>", "name": "Upah",                "range": "Sheet1!A1:D" }
     }
   }
   ```
   > **Note:** `config.json` is listed in `.gitignore` so your private Spreadsheet IDs are never committed to GitHub.
4. **Launch the dashboard:**
   Double-click **`Start-Dashboard.bat`**, or run:
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".\server.ps1" -OpenBrowser
   ```
5. Open **http://127.0.0.1:8765/** in your browser.

## Expected Google Sheet Schemas

### 1. `Completed Jom Entry` (`Sheet1!A1:H`)
| Col | Header | Example |
|---|---|---|
| A | `Bank account` | `account@example.com` |
| B | `Entry Date and time` | `2026-10-10 19:27:24` |
| C | `Job complete date` | `2026-10-10` |
| D | `Job Type` | `Cop Buah` |
| E | `Quantity` | `2.14` |
| F | `Unit` | `Ton` |
| G | `Job Done By` | `Worker Name` |
| H | `Remark` | *(Optional)* |

### 2. `Job Type` (`Sheet1!A1:D`) & `Upah` (`Sheet1!A1:D`)
| Col | Header | Example |
|---|---|---|
| A | `Job Type` | `Cop Buah` |
| B | `Unit` | `Ton` |
| C | `Unit Price` | `15.00` or `RM15.00` |
| D | `Cash Flow` / `Cashflow` | `In` (positive `+`) or `Out` (negative `−`) |

## Project Structure

```text
.
├── Start-Dashboard.bat   # One-click Windows launcher
├── server.ps1            # Embedded C#/.NET HTTP server & parallel Google Sheets poller
├── config.example.json   # Template configuration (copy to config.json)
├── public/
│   ├── index.html        # Dashboard markup
│   ├── styles.css        # Responsive & print-ready styling
│   └── app.js            # Real-time calculation engine, charts, drill-downs & CSV export
├── .gitignore            # Keeps config.json, tokens, and logs out of Git
├── .gitattributes        # Consistent CRLF/LF line endings
├── LICENSE               # MIT License
└── README.md
```

## License

[MIT](LICENSE)
