### A. Test Environment

All experiments were executed on a single Windows 10 workstation (Intel
x64, 16 GB RAM, SSD) under the following software stack:

| Component        | Version          | Notes                                                  |
| ---------------- | ---------------- | ------------------------------------------------------ |
| Node.js          | 18.x             | Runtime for the in-app + standalone benchmark suite    |
| PouchDB          | 9.0.0            | Local document store + replication client              |
| better-sqlite3   | 5.1.x (via `sqlite3` npm) | Local relational store for the comparison arm |
| Axios            | 1.6.x            | HTTP client for the manual SQLite ↔ CouchDB sync path |
| CouchDB          | 3.x (pouchdb-server, in-memory backend) | HTTP-compatible remote store. The benchmark suite targets the CouchDB wire protocol; the in-process pouchdb-server is a drop-in replacement for marker reproducibility without requiring a daemon install. |
| npm              | 10.x             | Dependency manager                                     |

Network: all tests run against `http://localhost:5984` (CouchDB and
the benchmark client on the same host) to remove network jitter from
the comparison. The `COUCHDB_URL` env var exposes the URL so the
marker can re-run against any reachable CouchDB.

### B. Test Categories

Five categories of test were executed, each addressing a specific
claim in this paper.

**T1 — Performance.** The two implementations (SQLite + axios vs.
PouchDB + replication) are compared on insert, read, push (local →
remote), and pull (remote → local) workloads at three dataset sizes
(10, 100, 1000 documents). Each measurement is the median of five
runs to suppress transient noise.

**T2 — Conflict resolution.** A controlled conflict scenario is
induced by writing the same document with two divergent revisions via
PouchDB's `bulkDocs({ new_edits: false })` API. The conflict
detection pipeline (`detectConflicts()` → `logConflict()` →
`getPendingConflicts()` → ConflictModal → `resolveConflict()`) is
exercised end-to-end. Asserts: one conflict record is logged, the
Conflict Modal populates with the local/remote diff, resolution with
"remote" applies the remote revision to the source collection, and
the conflict record is marked resolved.

**T3 — Offline-first behavior.** The remote CouchDB is unreachable
during a sequence of local CRUD operations. Local writes succeed
unchanged; the pending-change counter increases. On reconnection,
`oneTimeSync()` propagates the pending changes; the pending counter
returns to zero and the remote database contains the same document
set as the local one.

**T4 — Security and audit.** Every state-changing operation
(`createLoan`, `returnLoan`, `createEquipment`, `updateEquipment`,
`deleteEquipment`, conflict resolution) writes a row to the
`changelog` table with the action, the user, the document ID, and a
timestamp. The benchmark verifies that, after a workload of N
operations, exactly N rows exist in the changelog with the expected
fields populated.

**T5 — Code complexity.** Static measurement of the source code:
lines of code in the sync layer (`electron/sync.js` for PouchDB,
`electron/sync.js` historical for SQLite), lines of code in the data
layer (`electron/db.js`), lines of hand-rolled sync logic (manual
push/pull, changelog handling, conflict detection), and number of
schema tables. Numbers are measured at runtime via `fs.readFileSync`
so they always reflect the current working tree.

### C. Methodology

Each test in T1 is executed in the following sequence:

1. Initialise the local store (SQLite via `sqlite3`, PouchDB via the
   `pouchdb` Node module) in a fresh, empty working directory.
2. Generate N synthetic documents with deterministic IDs
   (`doc_000001` … `doc_00000N`) and a fixed schema (testID, name,
   category, available, metadata). The generator is the same for
   both implementations so neither gets a schema-shape advantage.
3. Insert all N documents in a single transaction (SQLite) or
   `bulkDocs` call (PouchDB) and time the operation.
4. Read all N documents and time the operation.
5. Push all N documents to the remote (CouchDB), time the operation,
   and record the byte count.
6. Pull all N documents from the remote, time the operation, and
   record the byte count.
7. Repeat steps 2–6 five times. Report the median; suppress min/max.

T2 is a single-run scenario, not a workload, because the goal is
qualitative correctness (the conflict pipeline behaves as designed)
rather than throughput.

T3 is observed qualitatively; no timing is reported. The point of
T3 is to demonstrate the offline-first design contract, not to
benchmark it.

T4 records the changelog row count after a workload of 50 mixed
operations (20 `createLoan`, 10 `returnLoan`, 15 `createEquipment`,
5 `updateEquipment`). Pass criterion: 50 changelog rows, every
required field populated.

T5 is computed at runtime and reported as a static table.

### D. Reproducibility

The full suite is reproducible from a clean checkout:

```bash
# from the project root
cp .env.example .env
# edit .env → COUCHDB_URL=http://localhost:5984 (or any reachable CouchDB)

# in-app benchmark (PouchDB-only, in the Electron renderer)
npm run dev
# → Evaluation tab → Run Benchmark

# standalone comparative benchmark (SQLite vs PouchDB, pure Node)
cd evaluation && npm install
npm run benchmark           # full pass, 100 docs
npm run benchmark:quick     # 10 docs, faster
node benchmark.js --json    # machine-readable output

# conflict-tracking unit tests
npm test                    # 9 tests, ~300ms
```

All five test categories are covered by the standalone suite except
T2 (the conflict-resolution scenario), which is covered by
`test/conflict.test.js`.
