# Campus Equipment Loan — Electron App

A desktop application built with **Electron + React + Vite + SQLite**.

Tracks campus equipment loans with a local SQLite database and optional CouchDB sync for multi-device/multi-user environments.

## Features

- Manage equipment inventory (CRUD)
- Borrow and return equipment
- Track loan history and status
- Automatic seed data for demo/testing
- CouchDB sync with conflict detection and resolution
- Custom Electron title bar with platform-aware controls
- Cross-platform support (Windows, macOS, Linux)

## Project Structure

```
equipment-loan-app/
├── electron/
│   ├── main.js          # Main process — window creation, IPC handlers
│   ├── preload.js       # Context bridge — exposes safe API to renderer
│   ├── db.js            # SQLite database module (students, equipment, loans, changelog, conflicts)
│   └── sync.js          # CouchDB two-way sync with conflict detection
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   ├── components/
│   │   ├── ui/
│   │   │   ├── Badge.jsx
│   │   │   ├── Modal.jsx
│   │   │   ├── StatCard.jsx
│   │   │   ├── TitleBar.jsx      # Electron-specific draggable title bar
│   │   │   └── Toast.jsx
│   │   ├── equipment/
│   │   │   ├── EquipmentCard.jsx
│   │   │   ├── EquipmentGrid.jsx
│   │   │   ├── AddEquipmentModal.jsx
│   │   │   └── EditEquipmentModal.jsx
│   │   ├── loans/
│   │   │   ├── LoanFormModal.jsx
│   │   │   ├── LoanRow.jsx
│   │   │   └── ReturnModal.jsx
│   │   └── sync/
│   │       └── ConflictModal.jsx
│   ├── hooks/
│   │   └── useLoans.js
│   ├── pages/
│   │   ├── EquipmentPage.jsx
│   │   └── LoansPage.jsx
│   └── utils/
│       └── helpers.js
├── scripts/
│   └── seed-couchdb.js  # CouchDB seed script
├── index.html
├── package.json
└── vite.config.js
```

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Run in development mode

Starts the Vite dev server and Electron together, with hot-reload.

```bash
npm run dev
```

### 3. Build a distributable

```bash
npm run dist
```

Outputs a platform installer to `dist-electron/`.

## Database

The app uses **SQLite** for local storage. The database file is stored in the user's app data directory (`userData/equipment-loan.db`).

### Tables

| Table        | Description                                       |
| ------------ | ------------------------------------------------- |
| `students`   | Student records (ID, name, phone, email)          |
| `equipment`  | Equipment inventory (ID, name, category, status)  |
| `loans`      | Loan transactions (borrower, item, dates, status) |
| `changelog`  | Change log for sync tracking                      |
| `conflictlog`| Conflict records from sync operations             |

### Seed Data

On first launch, the app seeds 5 students and 8 equipment items. To re-seed CouchDB:

```bash
npm run seed:couchdb
```

## CouchDB Sync

The app supports optional two-way sync with a CouchDB instance.

### Configuration

Edit `electron/sync.js` to set your CouchDB URL:

```js
const COUCHDB_URL = 'http://admin:admin@192.168.0.18:5984/campus_equipment_loan';
```

### How It Works

- **Push**: Local unsynced changes are pushed to CouchDB, tracked via the `changelog` table.
- **Pull**: Remote changes are pulled and merged locally. Conflicts are logged to `conflictlog`.
- **Conflict resolution**: Last-write-wins for most cases. Equal-timestamp conflicts require manual resolution via the UI.

### Sync Modes

| Mode       | Behavior                                  |
| ---------- | ----------------------------------------- |
| `manual`   | Sync only when triggered by the user      |
| `5s`       | Auto-sync every 5 seconds                 |
| `1min`     | Auto-sync every 60 seconds                |
| `auto`     | Sync on every change                      |

### IPC Channels

| Channel                       | Description                        |
| ----------------------------- | ---------------------------------- |
| `sync:verify`                 | Test CouchDB connection            |
| `sync:loans`                  | Trigger full two-way sync          |
| `sync:getSettings`            | Get current sync interval          |
| `sync:setSettings`            | Update sync interval               |
| `sync:getPendingCount`        | Get count of unsynced changes      |
| `sync:getConflicts`           | List unresolved conflicts          |
| `sync:resolveConflict`        | Resolve a conflict                 |

## API Surface (Renderer)

The preload script exposes `window.electronAPI` with:

- `electronAPI.db.equipment.*` — CRUD for equipment
- `electronAPI.db.loans.*` — Create, list, return loans
- `electronAPI.db.students.getAll` — List students
- `electronAPI.sync.*` — Sync operations
- `electronAPI.getVersion` — App version string
- `electronAPI.platform` — `'win32'` | `'darwin'` | `'linux'`

## Security Notes

- `contextIsolation: true` and `nodeIntegration: false` are set by default.
- The Content-Security-Policy in `index.html` restricts script/style sources.
- All Node access from the renderer goes through the narrow `contextBridge` in `preload.js`.
- SQLite runs only in the main process; the renderer communicates via IPC.

## Tech Stack

- **Electron** — Desktop shell
- **React** — UI library
- **Vite** — Dev server and bundler
- **SQLite** — Local database
- **CouchDB** — Remote sync target
- **Axios** — HTTP client for CouchDB
