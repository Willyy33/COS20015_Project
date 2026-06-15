# Campus Equipment Loan — Electron App

A desktop application for managing campus equipment loans, built with
**Electron + React + Vite**. Stores data locally with **PouchDB** and
replicates to a remote **CouchDB** for multi-device sync, with built-in
conflict detection and resolution.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main process (electron/main.js)                  │
│  ├── db.js   — PouchDB collections (students/equipment/     │
│  │             loans/conflicts) + CRUD + conflict tracking  │
│  ├── sync.js — PouchDB↔CouchDB replication, debounced      │
│  │             conflict scanning on every change            │
│  └── benchmark.js — in-app performance suite               │
│                                                             │
│  ┌─────────────┐    contextBridge    ┌──────────────────┐   │
│  │ preload.js  │ ─────────────────►  │  React renderer  │   │
│  │ (narrow IPC)│                     │  (src/App.jsx)   │   │
│  └─────────────┘                     └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

Local-first design: reads and writes hit PouchDB synchronously; a
background replication loop pushes changes to CouchDB and pulls
remote changes. The conflict scanner runs after each sync pass and
writes any new `_conflicts` into a separate `conflicts` PouchDB for
the Conflict Modal to resolve.

## Project Structure

```
equipment-loan-app/
├── electron/
│   ├── main.js          # Window creation, IPC handlers
│   ├── preload.js       # contextBridge — narrow renderer API
│   ├── db.js            # PouchDB module (4 collections: students,
│   │                    #   equipment, loans, conflicts)
│   ├── sync.js          # PouchDB↔CouchDB replication + conflict scan
│   └── benchmark.js     # In-app performance suite (PouchDB timing)
│
├── src/
│   ├── App.jsx              # Top bar, tabs, sync mode selector,
│   │                        #   pending + conflict badges
│   ├── main.jsx             # React entry
│   ├── components/
│   │   ├── ui/              # Badge, Modal, StatCard, TitleBar, Toast
│   │   ├── equipment/       # EquipmentCard, EquipmentGrid,
│   │   │                    #   Add/EditEquipmentModal
│   │   ├── loans/           # LoanFormModal, LoanRow, ReturnModal
│   │   └── sync/            # ConflictModal (resolve pending conflicts)
│   ├── hooks/
│   │   └── useLoans.js      # Renderer-side state hook (calls IPC)
│   ├── pages/
│   │   ├── EquipmentPage.jsx
│   │   ├── LoansPage.jsx
│   │   └── BenchmarkPage.jsx
│   └── utils/helpers.js
│
├── scripts/
│   └── seed-couchdb.js      # One-shot: copy PouchDB → CouchDB
│
├── evaluation/
│   ├── benchmark.js         # STANDALONE comparative benchmark
│   │                        #   (SQLite + PouchDB paths vs live CouchDB)
│   └── package.json
│
├── .env.example             # COUCHDB_URL, POUCHDB_DIR
├── .gitignore
├── package.json
├── vite.config.js
└── index.html
```

## Getting Started

### 1. Install dependencies

```bash
npm install
cd evaluation && npm install && cd ..
```

### 2. Configure CouchDB

Copy the example env file and set your CouchDB URL (auth + database
prefix):

```bash
cp .env.example .env
# edit .env → COUCHDB_URL=http://admin:admin@your-host:5984/campus_equipment_loan2
```

If unset, the app falls back to `http://localhost:5984/...` (assumes
a local CouchDB with no auth — see *Environment Configuration* below).

### 3. Run in development mode

```bash
npm run dev
```

Starts the Vite dev server and Electron together with hot reload.

### 4. Build a distributable

```bash
npm run dist
```

Outputs a platform installer to `dist-electron/`.

## Environment Configuration

The CouchDB URL is **never hardcoded** — it comes from the `COUCHDB_URL`
env var, with a safe localhost fallback. See `.env.example`.

| Variable       | Default                                                | Used by                                                                |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `COUCHDB_URL`  | `http://localhost:5984/campus_equipment_loan2`         | `electron/sync.js`, `electron/benchmark.js`, `scripts/seed-couchdb.js`, `evaluation/benchmark.js` |
| `POUCHDB_DIR`  | (unset → `~/.equipment-loan-app/` in seed script only) | `scripts/seed-couchdb.js` (the app itself uses Electron's `userData`) |
| `DB_NAME`      | `benchmark_test`                                       | `evaluation/benchmark.js` — prefix for test databases on the remote    |
| `DOC_COUNT`    | `100`                                                  | `evaluation/benchmark.js` — number of test documents per run          |

`.env` is git-ignored. Do not commit credentials.

## Sync Modes

The top-bar selector has four modes. The default is `manual`.

| Mode                | Behaviour                                                                  |
| ------------------- | -------------------------------------------------------------------------- |
| `manual`            | Sync only when the user clicks the **Sync** button                         |
| `Every 5s`          | Background `setInterval` runs `oneTimeSync` every 5 seconds                |
| `Every 1min`        | Background `setInterval` runs `oneTimeSync` every 60 seconds               |
| `Auto (on change)`  | Live two-way PouchDB replication (`db.sync(remote, { live: true })`)       |

The conflict scanner runs after every sync pass (manual, interval, or
live) on a 750ms debounce — a burst of changes from live sync only
triggers one scan, not one per doc.

## Data Architecture

### Local store (PouchDB)

Four separate PouchDB instances, one per logical collection, all in
Electron's `userData` directory:

| Collection  | Document IDs                          | Purpose                              |
| ----------- | ------------------------------------- | ------------------------------------ |
| `students`  | `S001`, `S002`, …                     | Student directory (read-only in UI) |
| `equipment` | `E001`, `E002`, …                     | Equipment inventory                  |
| `loans`     | `loan_<loanID>`                       | Loan records (open + returned)       |
| `conflicts` | `conflict_<timestamp>_<docID>`        | Detected sync conflicts (pending + resolved) |

PouchDB's `_rev` field powers automatic concurrency control. When two
clients edit the same document, the second writer gets a conflict and
the `_conflicts` array on the doc lists the losing revisions.

### Sync layer (PouchDB ↔ CouchDB)

Replication is PouchDB's built-in `db.sync(remoteDB)` — no hand-rolled
push/pull. The sync layer adds:

- `startLiveSync()` — for "Auto (on change)" mode
- `oneTimeSync()` — for manual and interval modes
- `scheduleConflictScan(dbName)` — debounced conflict detector
  that runs after every change event

### Conflict resolution

When `_conflicts` appears on any document, `detectConflicts()` writes
one record per conflicting revision into the `conflicts` PouchDB with:

```
{ conflictID, table, documentID, localRev, remoteRev,
  localDoc, remoteDoc, status, resolution, winnerData,
  timestamp, resolvedAt }
```

The Conflict Modal in the renderer lets the user pick one of three
resolutions per conflict:

| Resolution | Effect on the source table                                     |
| ---------- | -------------------------------------------------------------- |
| `local`    | Keeps the local revision; rejects the remote revision          |
| `remote`   | Pulls the remote revision into the local PouchDB               |
| `merge`    | Writes the user-edited `winnerData` to the source PouchDB      |

The conflict record is then marked `status: 'resolved'` and the
badge in the top bar clears.

## Evaluation / Benchmark

Two complementary benchmarks measure performance.

### In-app (Electron Evaluation tab)

`electron/benchmark.js` — runs in the renderer when the user clicks
**Run Benchmark** on the Evaluation tab. Times PouchDB operations
(insert, read, push, pull, memory delta). The comparison object also
returns real source-file LOC for `sync.js` and `db.js` (counted at
runtime so it never goes stale).

### Standalone (npm run benchmark)

`evaluation/benchmark.js` — pure Node, no Electron. Measures BOTH
SQLite + axios and PouchDB + replication paths against a live CouchDB
and writes a side-by-side report. This is the source of truth for the
HD report's comparative Results section.

```bash
npm run benchmark         # full pass (default 100 docs)
npm run benchmark:quick   # 10 docs, faster smoke test
cd evaluation && node benchmark.js --json   # machine-readable output
```

The standalone `SQLiteBenchmark` class implements the full SQLite path
(schema, CRUD, manual axios push/pull, conflict-aware changelog) so
the comparison is real, not estimated.

## Security Notes

- `contextIsolation: true` and `nodeIntegration: false` are set in
  `electron/main.js` (the renderer is sandboxed)
- All Node access from the renderer goes through the narrow
  `contextBridge` in `electron/preload.js`
- No secrets are committed. `COUCHDB_URL` and any auth are read from
  the `.env` file, which is git-ignored
- External links opened from the app are routed to the system browser
  via `shell.openExternal()` — the in-app window cannot open arbitrary
  URLs

## License

This project is for academic submission only.
