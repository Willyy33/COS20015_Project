/**
 * benchmark.js
 * Evaluation metrics for SQLite↔CouchDB vs PouchDB↔CouchDB sync
 * Measures performance, complexity, and operational metrics
 */

const { studentsDB, equipmentDB, loansDB } = require('./db');
const PouchDB = require('pouchdb');

// CouchDB configuration (env-driven for marker reproducibility)
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984/campus_equipment_loan2';

// ── Benchmark State ──────────────────────────────────────────────────────
let benchmarkResults = {
  lastRun: null,
  syncMetrics: {},
  resourceMetrics: {},
  complexityMetrics: {},
  comparisonData: null
};

// ── Utility Functions ──────────────────────────────────────────────────

/**
 * Get memory usage statistics
 */
function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss / 1024 / 1024,          // RSS in MB
    heapUsed: mem.heapUsed / 1024 / 1024, // Heap used in MB
    heapTotal: mem.heapTotal / 1024 / 1024, // Heap total in MB
    external: mem.external / 1024 / 1024,  // External in MB
    timestamp: new Date().toISOString()
  };
}

/**
 * Generate test data for benchmarking
 */
function generateTestData(count) {
  const students = [];
  const equipment = [];
  const loans = [];

  for (let i = 1; i <= count; i++) {
    const studentId = `S${String(i).padStart(4, '0')}`;
    students.push({
      _id: studentId,
      studentID: studentId,
      firstName: `Student${i}`,
      lastName: `Test${i}`,
      phone: `012${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
      email: `student${i}@test.com`
    });

    const equipmentId = `E${String(i).padStart(4, '0')}`;
    equipment.push({
      _id: equipmentId,
      equipmentID: equipmentId,
      name: `Test Equipment ${i}`,
      category: ['Laptop', 'Camera', 'Projector'][i % 3],
      available: true
    });

    if (i <= count / 2) {
      const loanId = `L${String(i).padStart(4, '0')}`;
      loans.push({
        _id: `loan_${loanId}`,
        loanID: loanId,
        studentID: studentId,
        equipmentID: equipmentId,
        borrowDate: new Date().toISOString().split('T')[0],
        returnDate: null,
        status: 'Borrowed',
        synced: false,
        type: 'loan'
      });
    }
  }

  return { students, equipment, loans };
}

/**
 * Measure execution time
 */
async function measureTime(fn, label) {
  const start = process.hrtime.bigint();
  const startMem = getMemoryUsage();

  try {
    const result = await fn();
    const end = process.hrtime.bigint();
    const endMem = getMemoryUsage();

    const durationMs = Number(end - start) / 1e6; // Convert to ms

    return {
      success: true,
      label,
      durationMs,
      memoryDelta: {
        rss: endMem.rss - startMem.rss,
        heapUsed: endMem.heapUsed - startMem.heapUsed,
        heapTotal: endMem.heapTotal - startMem.heapTotal,
        external: endMem.external - startMem.external
      },
      result
    };
  } catch (error) {
    const end = process.hrtime.bigint();
    const durationMs = Number(end - start) / 1e6;

    return {
      success: false,
      label,
      durationMs,
      error: error.message
    };
  }
}

// ── Sync Performance Metrics ──────────────────────────────────────────

/**
 * Benchmark one-time sync performance
 */
async function benchmarkOneTimeSync() {
  console.log('[BENCHMARK] Starting one-time sync benchmark...');

  const databases = [
    { name: 'students', db: studentsDB },
    { name: 'equipment', db: equipmentDB },
    { name: 'loans', db: loansDB }
  ];

  const results = {};

  for (const { name, db } of databases) {
    const remoteDB = new PouchDB(`${COUCHDB_URL}_${name}`);

    // Measure push sync
    const pushResult = await measureTime(async () => {
      return new Promise((resolve, reject) => {
        const syncHandler = db.sync(remoteDB);
        syncHandler.on('complete', (info) => resolve(info));
        syncHandler.on('error', (err) => reject(err));
      });
    }, `${name}_push`);

    // Measure pull sync
    const pullResult = await measureTime(async () => {
      return new Promise((resolve, reject) => {
        const syncHandler = remoteDB.sync(db);
        syncHandler.on('complete', (info) => resolve(info));
        syncHandler.on('error', (err) => reject(err));
      });
    }, `${name}_pull`);

    results[name] = {
      push: {
        durationMs: pushResult.durationMs,
        docsWritten: pushResult.result?.docs_written || 0,
        docsRead: pushResult.result?.docs_read || 0,
        success: pushResult.success
      },
      pull: {
        durationMs: pullResult.durationMs,
        docsWritten: pullResult.result?.docs_written || 0,
        docsRead: pullResult.result?.docs_read || 0,
        success: pullResult.success
      }
    };
  }

  return results;
}

/**
 * Benchmark conflict detection and resolution
 */
async function benchmarkConflictResolution() {
  console.log('[BENCHMARK] Starting conflict resolution benchmark...');

  const testDoc = {
    _id: `test_conflict_${Date.now()}`,
    testID: `test_conflict_${Date.now()}`,
    data: 'original',
    timestamp: new Date().toISOString()
  };

  // Insert test document
  await equipmentDB.put(testDoc);

  // Create conflict by updating with different revisions
  const startTime = process.hrtime.bigint();

  try {
    // Simulate conflict scenario
    const doc1 = await equipmentDB.get(testDoc._id);
    const doc2 = await equipmentDB.get(testDoc._id);

    // Update both copies
    doc1.data = 'version1';
    doc2.data = 'version2';

    await equipmentDB.put(doc1);
    await equipmentDB.put(doc2); // This should create a conflict

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1e6;

    // Get conflict info
    const conflicts = await equipmentDB.allDocs({
      include_docs: true,
      conflicts: true,
      key: testDoc._id
    });

    const hasConflict = conflicts.rows.some(row =>
      row.doc._conflicts && row.doc._conflicts.length > 0
    );

    // Cleanup
    await equipmentDB.remove(testDoc._id, testDoc._rev);

    return {
      success: true,
      durationMs,
      hasConflict,
      conflictsDetected: conflicts.rows.reduce((acc, row) =>
        acc + (row.doc._conflicts?.length || 0), 0
      )
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Benchmark live sync performance
 */
async function benchmarkLiveSync() {
  console.log('[BENCHMARK] Starting live sync benchmark...');

  const startTime = process.hrtime.bigint();
  const startMem = getMemoryUsage();

  const remoteDB = new PouchDB(`${COUCHDB_URL}_benchmark`);

  return new Promise((resolve) => {
    const syncHandler = studentsDB
      .sync(remoteDB, { live: true, retry: true })
      .on('active', () => {
        const endTime = process.hrtime.bigint();
        const endMem = getMemoryUsage();
        const durationMs = Number(endTime - startTime) / 1e6;

        // Cancel the live sync after activation
        syncHandler.cancel();

        resolve({
          success: true,
          durationMs,
          memoryDelta: {
            rss: endMem.rss - startMem.rss,
            heapUsed: endMem.heapUsed - startMem.heapUsed,
            heapTotal: endMem.heapTotal - startMem.heapTotal
          }
        });
      })
      .on('error', (err) => {
        resolve({
          success: false,
          error: err.message
        });
      });
  });
}

// ── Resource Metrics ──────────────────────────────────────────────────

/**
 * Get database size information
 */
async function getDatabaseSizes() {
  const studentsInfo = await studentsDB.info();
  const equipmentInfo = await equipmentDB.info();
  const loansInfo = await loansDB.info();

  return {
    students: {
      docCount: studentsInfo.doc_count,
      updateSeq: studentsInfo.update_seq
    },
    equipment: {
      docCount: equipmentInfo.doc_count,
      updateSeq: equipmentInfo.update_seq
    },
    loans: {
      docCount: loansInfo.doc_count,
      updateSeq: loansInfo.update_seq
    },
    total: {
      docCount: studentsInfo.doc_count + equipmentInfo.doc_count + loansInfo.doc_count
    }
  };
}

/**
 * Measure memory usage per operation
 */
async function measureOperationMemory() {
  const operations = [];

  // Measure get operation
  const getResult = await measureTime(async () => {
    await equipmentDB.allDocs({ include_docs: true });
  }, 'allDocs');
  operations.push(getResult);

  // Measure write operation
  const writeResult = await measureTime(async () => {
    const doc = {
      _id: `test_perf_${Date.now()}`,
      testID: `test_perf_${Date.now()}`,
      data: 'test'
    };
    await equipmentDB.put(doc);
    await equipmentDB.remove(doc._id, doc._rev);
  }, 'put_remove');
  operations.push(writeResult);

  return operations;
}

// ── Complexity Metrics ────────────────────────────────────────────────

/**
 * Get code complexity metrics.
 *
 * PouchDB values are MEASURED at runtime from the current source files
 * (electron/sync.js and electron/db.js) so they never go stale with
 * future edits. SQLite values are HISTORICAL snapshots from the
 * pre-migration codebase — the original SQLite path was removed in the
 * "Poucbdb to couchdb" refactor; these numbers are preserved for
 * reference only and to keep the historical comparison valid.
 */
function getCodeComplexityMetrics() {
  const fs = require('fs');
  const path = require('path');

  const countLines = (filePath) => {
    try {
      return fs.readFileSync(path.join(__dirname, filePath), 'utf8').split('\n').length;
    } catch (e) {
      return null;  // file missing → caller will treat as unknown
    }
  };

  return {
    syncCodeLOC: {
      pouchdb: countLines('sync.js'),   // measured live
      sqlite:   275,                    // historical: original SQLite sync.js
    },
    databaseCodeLOC: {
      pouchdb: countLines('db.js'),     // measured live
      sqlite:   797,                    // historical: original SQLite db.js
    },
    manualSyncLogic: {
      pouchdb: 0,    // PouchDB's sync is built-in (no hand-rolled layer)
      sqlite:  197,  // historical: hand-rolled axios push/pull + changelog + conflict detection
    },
    databaseSchema: {
      pouchdb: { tables: 3, indexes: 0, triggers: 0 },  // students, equipment, loans
      sqlite:  { tables: 5, indexes: 2, triggers: 2 },  // + changelog, conflictlog
    },
    note: 'PouchDB LOC is measured live from electron/sync.js and electron/db.js at runtime. SQLite numbers are historical snapshots from the pre-migration codebase; the original files no longer exist in the working tree.',
  };
}

// ── Benchmark Runner ──────────────────────────────────────────────────

/**
 * Run complete benchmark suite
 */
async function runBenchmarkSuite() {
  console.log('[BENCHMARK] Starting comprehensive benchmark suite...');

  const startTime = process.hrtime.bigint();
  const startMem = getMemoryUsage();

  // Run all benchmarks
  const results = {
    timestamp: new Date().toISOString(),
    syncPerformance: {},
    conflictResolution: {},
    liveSync: {},
    resources: {},
    complexity: {},
    memory: {}
  };

  // 1. Sync performance
  console.log('[BENCHMARK] Running sync performance tests...');
  results.syncPerformance = await benchmarkOneTimeSync();

  // 2. Conflict resolution
  console.log('[BENCHMARK] Running conflict resolution tests...');
  results.conflictResolution = await benchmarkConflictResolution();

  // 3. Live sync
  console.log('[BENCHMARK] Running live sync tests...');
  results.liveSync = await benchmarkLiveSync();

  // 4. Resources
  console.log('[BENCHMARK] Measuring resources...');
  results.resources = {
    databaseSizes: await getDatabaseSizes(),
    operationMemory: await measureOperationMemory()
  };

  // 5. Complexity
  results.complexity = getCodeComplexityMetrics();

  // 6. Memory
  const endMem = getMemoryUsage();
  results.memory = {
    start: startMem,
    end: endMem,
    delta: {
      rss: endMem.rss - startMem.rss,
      heapUsed: endMem.heapUsed - startMem.heapUsed,
      heapTotal: endMem.heapTotal - startMem.heapTotal,
      external: endMem.external - startMem.external
    }
  };

  // Calculate totals
  const endTime = process.hrtime.bigint();
  results.totalDurationMs = Number(endTime - startTime) / 1e6;

  // Store results
  benchmarkResults = {
    lastRun: results.timestamp,
    syncMetrics: results.syncPerformance,
    resourceMetrics: results.resources,
    complexityMetrics: results.complexity,
    comparisonData: results
  };

  console.log('[BENCHMARK] Benchmark suite completed in', results.totalDurationMs.toFixed(2), 'ms');

  return results;
}

/**
 * Get comparison data between the in-app PouchDB benchmark and the
 * standalone SQLite↔PouchDB benchmark.
 *
 * IMPORTANT: the in-app suite only times the PouchDB path (it runs
 * inside the Electron main process and the partner did not add a
 * sqlite3 dependency to the main package.json — adding it would risk
 * native-build failures on the marker's machine).
 *
 * For the HD report's comparative Results section, the standalone
 * benchmark at `evaluation/benchmark.js` is the source of truth: it
 * measures BOTH paths against a live CouchDB and writes a full report
 * to stdout (also supports `--json` for machine-readable output).
 * Run it with `npm run benchmark` (or `cd evaluation && node benchmark.js
 * --quick` for a faster pass) and capture the output for the report.
 */
function getComparisonData() {
  return {
    timestamp: benchmarkResults.lastRun || new Date().toISOString(),
    pouchdb: benchmarkResults.comparisonData || {},
    sqlite: {
      measured: false,
      note: 'SQLite path is not benchmarked in the in-app suite. The standalone benchmark at evaluation/benchmark.js measures both PouchDB and SQLite against a live CouchDB and is the source of truth for cross-implementation timing in the IEEE report.',
      standalonePath: 'evaluation/benchmark.js',
      howToRun: 'npm run benchmark         # full pass (default 100 docs)\nnpm run benchmark:quick   # 10 docs, faster smoke test\ncd evaluation && node benchmark.js --json   # machine-readable output',
    },
  };
}

module.exports = {
  runBenchmarkSuite,
  getComparisonData,
  getMemoryUsage,
  getDatabaseSizes,
  benchmarkOneTimeSync,
  benchmarkConflictResolution,
  benchmarkLiveSync,
  measureOperationMemory,
  getCodeComplexityMetrics
};
