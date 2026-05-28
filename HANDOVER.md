# NEET PG Processing System Project Handover Guide

Welcome! This document provides a complete technical handover, architectural overview, and guide to recent production deployments for the **NEET PG Question Paper Ingestion & Analysis System**.

---

## 🛠️ 1. Project Overview & Tech Stack

This application is a high-fidelity monorepo designed to parse, extract, normalize, and analyze medical PG entrance examination questions from multi-page PDFs, capturing complex formatting, clinical stems, and embedded clinical diagrams.

### **Core Stack**
* **Frontend**: React (v18) + Vite SPA styled with a modern, glassmorphic dark-theme visual design system (Harmonious HSL tailwinds, blur filters, smooth transitions).
* **Backend**: Node.js (v20) + Express REST API.
* **Database**: SQLite3 (embedded) running in **WAL (Write-Ahead Logging)** mode to handle highly concurrent read/write transactions during parallel ingestion without database locking.
* **Deployment**: Dockerized multi-stage builds hosted on **Fly.io** using persistent volumes.

---

## 📐 2. Key Architectural Components

### **A. Secure Passcode Authentication (Phase 5)**
* **The Login Gate**: The application is protected globally by a premium centered glassmorphic login gate. Fetches and statistics calculations are completely blocked/paused until a session token (`session_token_neetpg`) is stored in the browser's `localStorage`.
* **Verification API**: Endpoints `/api/auth/login` and `/api/settings/admin_password` validate passcodes securely against the `SystemSettings` table.
* **Passcode Seeding**: Database migrations automatically seed the default passcode **`NeetPG2026!`** on first boot. Passcodes can be updated securely inside the **⚙️ Settings** modal in the UI.

### **B. High-Fidelity PDF Parser & Image Option Pipeline**
* **Visual Option Graphic Extraction**: Located in `services/processingEngine.js`. When parsing Format 3 question papers, if options contain blank text stems (e.g. "Refer to image"), a specialized Pre-Pass extracts unassigned diagram images from the page, matches them to options A, B, C, D, writes them to disk (`public/uploads/images/${questionId}_opt[A-D].png`), and stores their web paths in the options columns.
* **Frontend Option Renderer**: Standard options that begin with `/uploads/` are rendered as responsive high-contrast image blocks with `cursor: zoom-in`, opening them in a fullscreen high-resolution lightbox on click.

### **C. SPA Routing, Auto-Refresh & YoY Drilldowns**
* **Hash-Based SPA Routing**: Listens to `hashchange` events in React. Deep-links map hashes directly to primary views:
  * `#/dashboard` ➔ Dashboard
  * `#/question-bank` ➔ Question Bank
  * `#/trends` ➔ YoY Analytics Matrix
  * `#/console` ➔ System Console settings
* **YoY Aggregate-to-Detail Drilldowns**: In the YoY Trend Hub matrix, cell counts are styled links that execute `drilldownFromTrends(subject, year)`. This scopes the React details popup modal (`modalQuestionsList`) exclusively to that cell's questions, binding Left/Right arrow navigation to the scoped subset.

---

## 🚀 3. Fly.io Production Infrastructure Details

The production application is successfully running at **[https://neetpg-analyzer.fly.dev/](https://neetpg-analyzer.fly.dev/)**.

### **Deployment Configuration**
* **Host Platform**: Fly.io V2 Machine.
* **Active Region**: **Singapore (`sin`)**. 
  > [!NOTE]
  > The primary region was shifted from Mumbai (`bom`) to Singapore (`sin`) due to physical hardware CPU/RAM resources exhaustion in Fly's Mumbai shared-host pools.
* **Persistent Disk**: 1 GB Fly volume named `neetpg_data` mounted to `/data`.
* **Binding Host**: Server binds explicitly to `'0.0.0.0'` on port `8080` (`app.listen(PORT, '0.0.0.0')`) to accept external routing via Fly's edge proxy.

### **Production Seeding & Race Condition Safeguards**
* **The Seeding Process**: On first container boot, server.js copies the database (`neet_pg_bank_v2.db`) and uploaded images from `/app/bootstrap_data` into `/data/` on the volume.
* **The Require Race Condition Fix**: Because `require('./config/database')` immediately calls `new sqlite3.Database` and creates an empty 4 KB file *before* bottom-level code can run, we placed the bootstrap copy block at the **very top of `server.js`** (above database imports).
* **The 100 KB Stub Safeguard**: If `/data/neet_pg_bank_v2.db` exists but is **under 100 KB** (an empty SQLite shell), the server automatically triggers an overwrite with your rich 1.7 MB pre-populated database.
* **WAL / SHM Cleanups**: The copy block cleanly unlinks `.db-shm` and `.db-wal` files from previous blank database sessions to prevent SQLite WAL state corruption.

---

## 📁 4. Key Files & Workspace Structure

* [server.js](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/server.js): Main Express server router containing REST endpoints, security gates, and production bootstrap seeding.
* [config/database.js](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/config/database.js): SQLite schema migration, index initialization, WAL configuration, subject normalization mappings, and admin passcode seeding.
* [services/processingEngine.js](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/services/processingEngine.js): Core PDF parsing, Gemini enrichment triggers, and visual option pre-pass extractor.
* [client/src/App.jsx](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/client/src/App.jsx): Main React UI controller, styling sheets, SPA routing listener, glassmorphic login gate overlay, and YoY Trends click actions.
* [fly.toml](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/fly.toml): Application config for Fly.io, mapping ports, volumes, and environment variables.
* [Dockerfile](file:///c:/Users/himab/OneDrive/ドキュメント/Neet_PG_Question_analysis/Dockerfile): Production multi-stage Docker build separating Vite frontend compilation from Node server runtime.

---

## 📈 5. Ongoing Tasks & Next Steps

1. **Verify 1,718 Questions In Production**:
   The user is currently running a fresh deploy sequence without caching to flush out an older cached database layer:
   ```bash
   fly volumes destroy neetpg_data --yes
   fly volumes create neetpg_data --region sin --size 1
   fly deploy --no-cache --ha=false
   ```
   Confirm that the active question count in the cloud console matches your local database count (exactly **1,718 questions**).
2. **Support Local-to-Cloud Database Overriding**:
   If the user updates the question database locally and wants to force-push it to the cloud volume in the future, guide them to do either **Method A** (quick volume reset) or **Method B** (using `fly sftp shell` to `put neet_pg_bank_v2.db /data/neet_pg_bank_v2.db`).
