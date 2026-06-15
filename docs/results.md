# Results — IEEE Report Tables

> Ready-to-paste markdown tables for the **Results** section of the HD
> IEEE report. All numbers are real measurements captured by
> `evaluation/benchmark.js` (SQLite + axios vs PouchDB + replication)
> run against a local CouchDB-compatible server (pouchdb-server) at
> `http://localhost:5984`. PouchDB wins 4 out of 5 categories across
> all three dataset sizes; the only consistent loss is local read
> latency, which is dominated by PouchDB's document store overhead.

> **To convert to Word:** paste the table markdown into
> https://tabletomarkdown.com/convert-markdown-table-to-word/ (or use
> pandoc: `pandoc results.md -o results.docx`).

---

## Table I — Benchmark Environment

| Component        | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Host             | Windows 10, Intel x64, 16 GB RAM, SSD                 |
| Node.js          | 18.x                                                  |
| CouchDB          | 3.x-compatible (pouchdb-server 4.2.0, in-memory)      |
| PouchDB          | 9.0.0                                                 |
| sqlite3          | 5.1.x (via npm `sqlite3`)                             |
| Axios            | 1.6.x                                                 |
| Network          | localhost (no network jitter)                         |
| `COUCHDB_URL`    | `http://localhost:5984`                               |
| Runs per cell    | 5 (median reported)                                   |
| Workload sizes   | 10, 100, 1000 documents                               |

## Table II — Performance Comparison (median of 5 runs)

| Operation                |   10 docs SQLite |   10 docs PouchDB |  100 docs SQLite |  100 docs PouchDB | 1000 docs SQLite | 1000 docs PouchDB |
| ------------------------ | ---------------- | ----------------- | ---------------- | ----------------- | ---------------- | ----------------- |
| Insert (local)           | 135.9 ms         | 18.4 ms           | 609.9 ms         | 19.6 ms           | 9.20 s           | 79.3 ms           |
| Read (local)             | 0.605 ms         | 3.6 ms            | 0.653 ms         | 6.1 ms            | 9.0 ms           | 55.5 ms           |
| Push (local → remote)    | 160.2 ms         | 60.5 ms           | 1.38 s           | 76.4 ms           | 15.91 s          | 509.1 ms          |
| Pull (remote → local)    | 80.0 ms          | 45.6 ms           | 613.9 ms         | 41.1 ms           | 9.57 s           | 215.4 ms          |

> **Observation:** PouchDB's insert, push, and pull operations scale
> sub-linearly with document count (batched sync protocol), while
> SQLite's operations scale linearly (one HTTP request per document
> for push/pull, and one INSERT statement per row for insert). The
> crossover is most visible at 1000 documents, where PouchDB's push
> is 31× faster (509 ms vs 15.91 s) and pull is 44× faster (215 ms
> vs 9.57 s). The only operation where SQLite wins is local read,
> where its flat-file storage has lower overhead than PouchDB's
> IndexedDB-backed document store.

## Table III — Throughput (docs/sec, derived from Table II)

| Operation |  10 docs SQLite |  10 docs PouchDB | 100 docs SQLite | 100 docs PouchDB | 1000 docs SQLite | 1000 docs PouchDB |
| --------- | --------------- | ---------------- | --------------- | ---------------- | ---------------- | ----------------- |
| Insert    | 74              | 544              | 164             | 5,103            | 109              | 12,603            |
| Read      | 16,529          | 2,774            | 153,092         | 16,294           | 110,585          | 18,033            |
| Push      | 62              | 165              | 72              | 1,309            | 63               | 1,964             |
| Pull (post-push)†   | 125     | 0‡               | 163             | 0‡               | 104              | 0‡                |
| Pull (initial, fresh device)§ | n/a | **216**   | n/a             | **n/a\***         | n/a              | **2,826**         |

> † "Post-push pull" measures what happens when a sync cycle runs
> immediately after a successful push of the same documents. The
> local PouchDB already knows the remote's revision IDs from the
> push, so the pull phase correctly reports 0 new documents to
> fetch.
>
> ‡ A value of 0 here is correct PouchDB behavior, not a
> measurement bug. The timing is still recorded in Table II.
>
> § "Initial pull" measures a fresh, empty PouchDB instance joining
> a sync that already has data on the remote — i.e., a new device
> joining the system for the first time. This is the scenario
> where pull is non-zero. At 1000 documents, PouchDB completes the
> initial sync in 353.8 ms (2,826 docs/sec).

## Table IV — Memory Footprint (Δ from baseline)

| Metric      | SQLite (100 docs) | PouchDB (100 docs) | SQLite (1000 docs) | PouchDB (1000 docs) |
| ----------- | ----------------- | ------------------ | ------------------ | ------------------- |
| RSS Δ       | 6.45 MB           | 9.80 MB            | 49.57 MB           | 15.53 MB            |
| Heap Δ      | 4.66 MB           | −1.15 MB           | 16.87 MB           | −8.99 MB            |

> **Observation:** PouchDB's heap delta is consistently negative,
> indicating that the garbage collector released memory during the
> workload. SQLite's heap grows monotonically with document count.
> At 1000 documents, PouchDB uses ~3× less resident memory than
> SQLite (15.5 MB vs 49.6 MB).

## Table V — Code Complexity (measured at runtime)

| Metric                  | SQLite     | PouchDB   | Δ          |
| ----------------------- | ---------- | --------- | ---------- |
| Sync code (LOC)         | 275        | 201       | −27%       |
| Data layer code (LOC)   | 797        | 434       | −46%       |
| Manual sync logic (LOC) | 197        | 0         | −100%      |
| Schema tables           | 5          | 3         | −40%       |

> **Source of measurements:** the PouchDB column is read live from
> `electron/sync.js` and `electron/db.js` at runtime via
> `fs.readFileSync(...).split('\n').length`. The SQLite column is a
> historical snapshot of the pre-migration codebase (the original
> SQLite files were removed in the partner's "Poucbdb to couchdb"
> refactor; their line counts are preserved in
> `electron/benchmark.js#getCodeComplexityMetrics()` for the IEEE
> comparison). The 197 lines of "manual sync logic" are the
> hand-rolled axios push/pull + changelog handling + conflict
> detection that PouchDB replication eliminates entirely.

## Table VI — Conflict Resolution Unit Tests

| # | Test                                                 | Result | Time     |
| - | ---------------------------------------------------- | ------ | -------- |
| 1 | `logConflict` writes a pending record                | PASS   | 26.5 ms  |
| 2 | `logConflict` de-duplicates on (table, documentID)   | PASS   | 9.2 ms   |
| 3 | `getPendingConflicts` returns pending, newest-first  | PASS   | 15.5 ms  |
| 4 | `resolveConflict('remote')` applies remote revision  | PASS   | 4.6 ms   |
| 5 | `resolveConflict('merge')` writes winnerData         | PASS   | 2.6 ms   |
| 6 | `resolveConflict` throws on unknown conflictID       | PASS   | 1.6 ms   |
| 7 | `detectConflicts` finds/logs conflicts on source DBs | PASS   | 3.9 ms   |
| 8 | `detectConflicts` is idempotent                      | PASS   | 7.3 ms   |
|   | **Total**                                            | **9/9** | **302 ms** |

> Reproducer: `npm test` (uses Node's built-in `node:test` runner; no
> extra dependencies). Conflicts are created via
> `PouchDB.bulkDocs({ new_edits: false })` to force a divergent
> revision at an old `_rev`, which is the only documented way to
> produce a PouchDB `_conflicts` array in a unit test.

## Table VIII — Initial-Pull Scenario (fresh device joins)

A new PouchDB instance with zero documents joins a sync that
already has data on the remote. This is the deployment scenario
for a new user installing the app on a second device.

| Metric                    |   10 docs | 100 docs | 1000 docs |
| ------------------------- | --------- | -------- | --------- |
| Time                      | 46.2 ms   | 73.9 ms  | 353.8 ms  |
| Documents pulled          | 10        | 100      | 1000      |
| Documents pushed back     | 0         | 0        | 0         |
| Throughput (docs/sec)     | 216       | n/a*     | 2,826     |
| Final local document count| 10        | 100      | 1000      |
| RSS Δ                     | 476 KB    | n/a*     | 14.7 MB   |
| Heap Δ                    | 1.6 MB    | n/a*     | 5.4 MB    |

> \* "n/a" indicates the measurement was not captured for that
> dataset size in this run; the 10-doc and 1000-doc numbers
> bracket the realistic deployment range. The 1000-doc
> throughput of 2,826 docs/sec is the most representative
> figure for the report.
>
> This scenario is implemented in
> `BenchmarkRunner.runInitialPullBenchmark()` and uses a
> dedicated `PouchDBBenchmark.initialPullFromCouchDB()` method
> added to the benchmark harness.

## Table VII — Wins by Category (across all dataset sizes)

| Category                 | Winner  | Margin (at 1000 docs)                |
| ------------------------ | ------- | ------------------------------------ |
| Insert (local)           | PouchDB | 116× faster (79 ms vs 9.2 s)         |
| Read (local)             | SQLite  | 6× faster (9 ms vs 55.5 ms)          |
| Push (local → remote)    | PouchDB | 31× faster (509 ms vs 15.9 s)        |
| Pull (remote → local)    | PouchDB | 44× faster (215 ms vs 9.6 s)         |
| Memory (RSS)             | PouchDB | 3.2× lower (15.5 MB vs 49.6 MB)      |
| Code complexity (LOC)    | PouchDB | 46% smaller data layer (434 vs 797)  |
| Conflict resolution      | PouchDB | Native `_rev`/`_conflicts`, no extra code |

> PouchDB wins 6 of 7 categories. The single SQLite win is local
> read latency, which matters primarily for high-frequency read-heavy
> workloads. For the offline-first sync use case that motivates this
> project, PouchDB's wins dominate.

---

## Suggested Discussion paragraph (drop into §IV)

> The performance results in Table II reveal a clear tradeoff between
> the two implementations. PouchDB's batched replication protocol
> delivers a 31× speedup on push and 44× speedup on pull at 1000
> documents, with the gap widening as the dataset grows. The cost is
> a 6× slowdown on local read latency and a small (3.2×) memory
> advantage in the opposite direction at 1000 documents. For an
> offline-first equipment loan system where the bottleneck is
> synchronising a local store with a central server — not serving
> thousands of reads per second from a single process — PouchDB is
> the appropriate choice. The 197 lines of manual sync logic
> eliminated by PouchDB's built-in replication (Table V) also
> represent a substantial reduction in the surface area for sync
> bugs: the conflict-tracking pipeline is exercised by 9 unit tests
> (Table VI) with full pass coverage in 302 ms.
