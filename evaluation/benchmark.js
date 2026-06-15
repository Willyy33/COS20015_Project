#!/usr/bin/env node

/**
 * benchmark.js
 * Standalone evaluation script for SQLite↔CouchDB vs PouchDB↔CouchDB
 *
 * Usage:
 *   node benchmark.js              # Full benchmark
 *   node benchmark.js --quick      # Quick benchmark (smaller dataset)
 *   node benchmark.js --verbose    # Verbose output
 *   node benchmark.js --json       # Output as JSON
 *
 * Environment variables:
 *   COUCHDB_URL  - CouchDB URL (default: http://localhost:5984)
 *   DB_NAME      - Database name prefix (default: benchmark_test)
 *   DOC_COUNT    - Number of documents to test with (default: 100)
 */

const PouchDB = require('pouchdb');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────
// Defaults to a local CouchDB; override with the COUCHDB_URL env var
// (e.g. http://admin:admin@192.168.0.18:5984 for a LAN instance).
const COUCHDB_URL = process.env.COUCHDB_URL || 'http://localhost:5984';
const DB_NAME = process.env.DB_NAME || 'benchmark_test';
const DOC_COUNT = parseInt(process.env.DOC_COUNT) || 100;
const SQLITE_DB_PATH = path.join(os.tmpdir(), `benchmark_${Date.now()}.db`);

// Parse CLI args
const args = process.argv.slice(2);
const QUICK_MODE = args.includes('--quick');
const VERBOSE = args.includes('--verbose');
const JSON_OUTPUT = args.includes('--json');

const TEST_DOC_COUNT = QUICK_MODE ? 10 : DOC_COUNT;

// ── Utility Functions ──────────────────────────────────────────────────

function log(message, level = 'info') {
  if (!JSON_OUTPUT) {
    const prefix = {
      info: '  ',
      success: '✓ ',
      error: '✗ ',
      metric: '  ',
      header: '\n━━━'
    }[level] || '  ';
    console.log(`${prefix}${message}`);
  }
}

function formatMs(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test Data Generator ────────────────────────────────────────────────

function generateTestDocuments(count) {
  const docs = [];
  for (let i = 1; i <= count; i++) {
    docs.push({
      _id: `doc_${String(i).padStart(6, '0')}`,
      testID: `doc_${String(i).padStart(6, '0')}`,
      name: `Test Document ${i}`,
      category: ['Laptop', 'Camera', 'Projector', 'Tablet', 'Accessory'][i % 5],
      available: i % 3 !== 0,
      metadata: {
        createdBy: `user_${i % 10}`,
        createdAt: new Date().toISOString(),
        version: 1
      }
    });
  }
  return docs;
}

// ── SQLite Benchmark ───────────────────────────────────────────────────

class SQLiteBenchmark {
  constructor() {
    this.db = null;
    this.dbPath = SQLITE_DB_PATH;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async createTable() {
    return new Promise((resolve, reject) => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS benchmark_docs (
          _id TEXT PRIMARY KEY,
          testID TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT,
          available INTEGER,
          metadata TEXT,
          synced INTEGER DEFAULT 0,
          lastModified TEXT
        )
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async insertDocuments(docs) {
    return new Promise((resolve, reject) => {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO benchmark_docs 
        (_id, testID, name, category, available, metadata, synced, lastModified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.db.serialize(() => {
        this.db.run('BEGIN TRANSACTION');
        docs.forEach(doc => {
          stmt.run(
            doc._id,
            doc.testID,
            doc.name,
            doc.category,
            doc.available ? 1 : 0,
            JSON.stringify(doc.metadata),
            0,
            new Date().toISOString()
          );
        });
        this.db.run('COMMIT', (err) => {
          stmt.finalize();
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async getDocument(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM benchmark_docs WHERE _id = ?',
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async getAllDocuments() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM benchmark_docs',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async getUnsyncedDocuments() {
    return new Promise((resolve, reject) => {
      this.db.all(
        'SELECT * FROM benchmark_docs WHERE synced = 0',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async markSynced(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE benchmark_docs SET synced = 1 WHERE _id = ?',
        [id],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async markAllSynced() {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE benchmark_docs SET synced = 1 WHERE synced = 0',
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async pushToCouchDB(remoteURL) {
    const unsyncedDocs = await this.getUnsyncedDocuments();
    let pushed = 0;
    let bytesSent = 0;

    for (const doc of unsyncedDocs) {
      try {
        // Get existing remote doc
        let existingRev = null;
        try {
          const existing = await axios.get(`${remoteURL}/${doc._id}`);
          existingRev = existing.data._rev;
        } catch (e) {
          // Doc doesn't exist yet
        }

        const couchDoc = {
          _id: doc._id,
          testID: doc.testID,
          name: doc.name,
          category: doc.category,
          available: doc.available === 1,
          metadata: JSON.parse(doc.metadata || '{}'),
          localTimestamp: doc.lastModified,
          pushedAt: new Date().toISOString()
        };

        if (existingRev) {
          couchDoc._rev = existingRev;
        }

        const payload = JSON.stringify(couchDoc);
        bytesSent += Buffer.byteLength(payload);

        await axios.put(`${remoteURL}/${doc._id}`, couchDoc);
        await this.markSynced(doc._id);
        pushed++;
      } catch (err) {
        if (VERBOSE) log(`Failed to push ${doc._id}: ${err.message}`, 'error');
      }
    }

    return { pushed, bytesSent };
  }

  async pullFromCouchDB(remoteURL) {
    try {
      const response = await axios.get(`${remoteURL}/_all_docs?include_docs=true`);
      const remoteDocs = response.data.rows.filter(r => !r.id.startsWith('_design/'));
      let pulled = 0;
      let bytesReceived = 0;

      for (const row of remoteDocs) {
        const doc = row.doc;
        bytesReceived += Buffer.byteLength(JSON.stringify(doc));

        await new Promise((resolve, reject) => {
          this.db.run(
            `INSERT OR REPLACE INTO benchmark_docs 
             (_id, testID, name, category, available, metadata, synced, lastModified)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
            [
              doc._id,
              doc.testID || doc._id,
              doc.name,
              doc.category,
              doc.available ? 1 : 0,
              JSON.stringify(doc.metadata || {}),
              doc.pushedAt || new Date().toISOString()
            ],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
        pulled++;
      }

      return { pulled, bytesReceived };
    } catch (err) {
      throw new Error(`Pull failed: ${err.message}`);
    }
  }

  async cleanup() {
    return new Promise((resolve) => {
      this.db.close(() => {
        try {
          fs.unlinkSync(this.dbPath);
        } catch (e) {}
        resolve();
      });
    });
  }
}

// ── PouchDB Benchmark ──────────────────────────────────────────────────

class PouchDBBenchmark {
  constructor() {
    this.db = null;
  }

  async initialize() {
    const dbPath = path.join(os.tmpdir(), `pouchdb_benchmark_${Date.now()}`);
    this.db = new PouchDB(dbPath);
  }

  async insertDocuments(docs) {
    const result = await this.db.bulkDocs(docs);
    return result;
  }

  async getDocument(id) {
    try {
      return await this.db.get(id);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async getAllDocuments() {
    const result = await this.db.allDocs({ include_docs: true });
    return result.rows.map(row => row.doc);
  }

  async getUnsyncedDocuments() {
    const result = await this.db.allDocs({ include_docs: true });
    return result.rows
      .map(row => row.doc)
      .filter(doc => !doc._id.startsWith('_design/') && doc.synced === false);
  }

  async markSynced(id) {
    try {
      const doc = await this.db.get(id);
      await this.db.put({ ...doc, synced: true });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  async markAllSynced() {
    const docs = await this.getAllDocuments();
    const unsynced = docs.filter(d => d.synced === false);
    for (const doc of unsynced) {
      await this.db.put({ ...doc, synced: true });
    }
  }

  async pushToCouchDB(remoteURL) {
    const remoteDB = new PouchDB(remoteURL);

    return new Promise((resolve, reject) => {
      let bytesSent = 0;
      const syncHandler = this.db
        .sync(remoteDB)
        .on('change', (info) => {
          if (info.direction === 'push') {
            bytesSent += info.change?.docs?.length || 0;
          }
        })
        .on('complete', (info) => {
          resolve({
            pushed: info.push?.docs_written || 0,
            bytesSent: bytesSent * 500 // Estimate ~500 bytes per doc
          });
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }

  async pullFromCouchDB(remoteURL) {
    const remoteDB = new PouchDB(remoteURL);

    return new Promise((resolve, reject) => {
      let bytesReceived = 0;
      // this.db.sync(remoteDB) — sync from the local DB's perspective,
      // so info.direction === 'pull' means data came FROM remoteDB INTO
      // this.db (which is what the function name says: pull FROM CouchDB).
      // The previous code had remoteDB.sync(this.db) which inverted the
      // semantics — info.pull would have counted docs pushed local→remote
      // instead of pulled remote→local.
      const syncHandler = this.db
        .sync(remoteDB)
        .on('change', (info) => {
          if (info.direction === 'pull') {
            bytesReceived += info.change?.docs?.length || 0;
          }
        })
        .on('complete', (info) => {
          resolve({
            pulled: info.pull?.docs_written || 0,
            bytesReceived: bytesReceived * 500 // Estimate ~500 bytes per doc
          });
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }

  async cleanup() {
    await this.db.destroy();
  }

  /**
   * One-shot pull from a remote into a fresh, empty local PouchDB.
   * Used by the "initial pull" benchmark scenario — simulates a new
   * device joining the sync for the first time, with the remote
   * already containing the documents.
   */
  async initialPullFromCouchDB(remoteURL) {
    const remoteDB = new PouchDB(remoteURL);
    return new Promise((resolve, reject) => {
      const syncHandler = this.db
        .sync(remoteDB)
        .on('complete', (info) => {
          resolve({
            pulled: info.pull?.docs_written || 0,
            pushed: info.push?.docs_written || 0,
          });
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }
}

// ── Benchmark Runner ───────────────────────────────────────────────────

class BenchmarkRunner {
  constructor() {
    this.results = {
      timestamp: new Date().toISOString(),
      config: {
        couchdbUrl: COUCHDB_URL,
        dbName: DB_NAME,
        docCount: TEST_DOC_COUNT,
        quickMode: QUICK_MODE
      },
      sqlite: {},
      pouchdb: {},
      initialPull: {},
      comparison: {}
    };
  }

  async runSQLiteBenchmark() {
    log('━━━ SQLite Benchmark ━━━', 'header');
    const sqlite = new SQLiteBenchmark();
    const memBefore = getMemoryUsage();

    try {
      // Initialize
      log('Initializing SQLite database...');
      await sqlite.initialize();
      await sqlite.createTable();

      // Insert documents
      const testDocs = generateTestDocuments(TEST_DOC_COUNT);
      const insertStart = performance.now();
      await sqlite.insertDocuments(testDocs);
      const insertTime = performance.now() - insertStart;
      log(`Inserted ${TEST_DOC_COUNT} documents in ${formatMs(insertTime)}`, 'success');

      // Read documents
      const readStart = performance.now();
      const allDocs = await sqlite.getAllDocuments();
      const readTime = performance.now() - readStart;
      log(`Read ${allDocs.length} documents in ${formatMs(readTime)}`, 'success');

      // Push to CouchDB
      const remoteURL = `${COUCHDB_URL}/${DB_NAME}_sqlite`;
      log(`Pushing to CouchDB: ${remoteURL}`);
      const pushStart = performance.now();
      const pushResult = await sqlite.pushToCouchDB(remoteURL);
      const pushTime = performance.now() - pushStart;
      log(`Pushed ${pushResult.pushed} documents in ${formatMs(pushTime)}`, 'success');

      // Pull from CouchDB
      log('Pulling from CouchDB...');
      const pullStart = performance.now();
      const pullResult = await sqlite.pullFromCouchDB(remoteURL);
      const pullTime = performance.now() - pullStart;
      log(`Pulled ${pullResult.pulled} documents in ${formatMs(pullTime)}`, 'success');

      const memAfter = getMemoryUsage();

      this.results.sqlite = {
        insert: { timeMs: insertTime, docCount: TEST_DOC_COUNT, docsPerSec: TEST_DOC_COUNT / (insertTime / 1000) },
        read: { timeMs: readTime, docCount: allDocs.length, docsPerSec: allDocs.length / (readTime / 1000) },
        push: { timeMs: pushTime, docsWritten: pushResult.pushed, bytesSent: pushResult.bytesSent, docsPerSec: pushResult.pushed / (pushTime / 1000) },
        pull: { timeMs: pullTime, docsRead: pullResult.pulled, bytesReceived: pullResult.bytesReceived, docsPerSec: pullResult.pulled / (pullTime / 1000) },
        memory: {
          before: memBefore,
          after: memAfter,
          deltaRss: memAfter.rss - memBefore.rss,
          deltaHeap: memAfter.heapUsed - memBefore.heapUsed
        }
      };

      await sqlite.cleanup();
      return this.results.sqlite;
    } catch (err) {
      log(`SQLite benchmark failed: ${err.message}`, 'error');
      await sqlite.cleanup().catch(() => {});
      throw err;
    }
  }

  async runPouchDBBenchmark() {
    log('━━━ PouchDB Benchmark ━━━', 'header');
    const pouchdb = new PouchDBBenchmark();
    const memBefore = getMemoryUsage();

    try {
      // Initialize
      log('Initializing PouchDB database...');
      await pouchdb.initialize();

      // Insert documents
      const testDocs = generateTestDocuments(TEST_DOC_COUNT);
      const insertStart = performance.now();
      await pouchdb.insertDocuments(testDocs);
      const insertTime = performance.now() - insertStart;
      log(`Inserted ${TEST_DOC_COUNT} documents in ${formatMs(insertTime)}`, 'success');

      // Read documents
      const readStart = performance.now();
      const allDocs = await pouchdb.getAllDocuments();
      const readTime = performance.now() - readStart;
      log(`Read ${allDocs.length} documents in ${formatMs(readTime)}`, 'success');

      // Push to CouchDB
      const remoteURL = `${COUCHDB_URL}/${DB_NAME}_pouchdb`;
      log(`Pushing to CouchDB: ${remoteURL}`);
      const pushStart = performance.now();
      const pushResult = await pouchdb.pushToCouchDB(remoteURL);
      const pushTime = performance.now() - pushStart;
      log(`Pushed ${pushResult.pushed} documents in ${formatMs(pushTime)}`, 'success');

      // Pull from CouchDB
      log('Pulling from CouchDB...');
      const pullStart = performance.now();
      const pullResult = await pouchdb.pullFromCouchDB(remoteURL);
      const pullTime = performance.now() - pullStart;
      log(`Pulled ${pullResult.pulled} documents in ${formatMs(pullTime)}`, 'success');

      const memAfter = getMemoryUsage();

      this.results.pouchdb = {
        insert: { timeMs: insertTime, docCount: TEST_DOC_COUNT, docsPerSec: TEST_DOC_COUNT / (insertTime / 1000) },
        read: { timeMs: readTime, docCount: allDocs.length, docsPerSec: allDocs.length / (readTime / 1000) },
        push: { timeMs: pushTime, docsWritten: pushResult.pushed, bytesSent: pushResult.bytesSent, docsPerSec: pushResult.pushed / (pushTime / 1000) },
        pull: { timeMs: pullTime, docsRead: pullResult.pulled, bytesReceived: pullResult.bytesReceived, docsPerSec: pullResult.pulled / (pullTime / 1000) },
        memory: {
          before: memBefore,
          after: memAfter,
          deltaRss: memAfter.rss - memBefore.rss,
          deltaHeap: memAfter.heapUsed - memBefore.heapUsed
        }
      };

      await pouchdb.cleanup();
      return this.results.pouchdb;
    } catch (err) {
      log(`PouchDB benchmark failed: ${err.message}`, 'error');
      await pouchdb.cleanup().catch(() => {});
      throw err;
    }
  }

  /**
   * "Initial pull" scenario — a fresh, empty PouchDB instance joins
   * a sync that already has data on the remote. This produces a
   * NON-ZERO pull count, unlike the regular PouchDB benchmark where
   * push + pull on the same local DB correctly returns 0.
   *
   * Uses the same remote database that the regular PouchDB benchmark
   * just pushed into, so no additional setup is needed.
   */
  async runInitialPullBenchmark() {
    log('━━━ PouchDB Initial-Pull Benchmark (fresh device joins) ━━━', 'header');

    const fresh = new PouchDBBenchmark();
    const memBefore = getMemoryUsage();

    try {
      await fresh.initialize();
      log('Initializing fresh PouchDB (empty) for initial-pull scenario...');

      const remoteURL = `${COUCHDB_URL}/${DB_NAME}_pouchdb`;
      log(`Pulling from CouchDB: ${remoteURL}`);

      const pullStart = performance.now();
      const pullResult = await fresh.initialPullFromCouchDB(remoteURL);
      const pullTime = performance.now() - pullStart;
      log(`Pulled ${pullResult.pushed === 0 ? pullResult.pulled : '??'} documents in ${formatMs(pullTime)}`, 'success');

      // Verify the local now has the docs
      const allDocs = await fresh.getAllDocuments();
      const memAfter = getMemoryUsage();

      this.results.initialPull = {
        timeMs: pullTime,
        docsRead: pullResult.pulled,
        docsPushed: pullResult.pushed,
        finalLocalCount: allDocs.length,
        docsPerSec: pullResult.pulled / (pullTime / 1000),
        memory: {
          before: memBefore,
          after: memAfter,
          deltaRss: memAfter.rss - memBefore.rss,
          deltaHeap: memAfter.heapUsed - memBefore.heapUsed
        }
      };

      await fresh.cleanup();
      return this.results.initialPull;
    } catch (err) {
      log(`Initial-pull benchmark failed: ${err.message}`, 'error');
      await fresh.cleanup().catch(() => {});
      throw err;
    }
  }

  async verifyCouchDB() {
    try {
      await axios.get(`${COUCHDB_URL}/_all_dbs`);
      return true;
    } catch (err) {
      return false;
    }
  }

  async cleanupTestDatabases() {
    const databases = [
      `${DB_NAME}_sqlite`,
      `${DB_NAME}_pouchdb`
    ];

    for (const dbName of databases) {
      try {
        const db = new PouchDB(`${COUCHDB_URL}/${dbName}`);
        await db.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  generateComparison() {
    const s = this.results.sqlite;
    const p = this.results.pouchdb;

    this.results.comparison = {
      insert: {
        winner: s.insert.timeMs < p.insert.timeMs ? 'sqlite' : 'pouchdb',
        sqliteMs: s.insert.timeMs,
        pouchdbMs: p.insert.timeMs,
        ratio: (p.insert.timeMs / s.insert.timeMs).toFixed(2) + 'x'
      },
      read: {
        winner: s.read.timeMs < p.read.timeMs ? 'sqlite' : 'pouchdb',
        sqliteMs: s.read.timeMs,
        pouchdbMs: p.read.timeMs,
        ratio: (p.read.timeMs / s.read.timeMs).toFixed(2) + 'x'
      },
      push: {
        winner: s.push.timeMs < p.push.timeMs ? 'sqlite' : 'pouchdb',
        sqliteMs: s.push.timeMs,
        pouchdbMs: p.push.timeMs,
        ratio: (p.push.timeMs / s.push.timeMs).toFixed(2) + 'x'
      },
      pull: {
        winner: s.pull.timeMs < p.pull.timeMs ? 'sqlite' : 'pouchdb',
        sqliteMs: s.pull.timeMs,
        pouchdbMs: p.pull.timeMs,
        ratio: (p.pull.timeMs / s.pull.timeMs).toFixed(2) + 'x'
      },
      memory: {
        winner: s.memory.deltaHeap < p.memory.deltaHeap ? 'sqlite' : 'pouchdb',
        sqliteHeapDelta: s.memory.deltaHeap,
        pouchdbHeapDelta: p.memory.deltaHeap
      },
      codeComplexity: {
        syncCodeLOC: { sqlite: 275, pouchdb: 201 },
        dbCodeLOC: { sqlite: 797, pouchdb: 434 },
        manualSyncLogic: { sqlite: 197, pouchdb: 0 },
        schemaTables: { sqlite: 5, pouchdb: 3 }
      }
    };

    return this.results.comparison;
  }

  printReport() {
    if (JSON_OUTPUT) {
      console.log(JSON.stringify(this.results, null, 2));
      return;
    }

    console.log('\n');
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║     SQLite↔CouchDB vs PouchDB↔CouchDB Benchmark Report    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`\n  Timestamp: ${this.results.timestamp}`);
    console.log(`  Documents: ${TEST_DOC_COUNT}`);
    console.log(`  CouchDB: ${COUCHDB_URL}`);

    const s = this.results.sqlite;
    const p = this.results.pouchdb;
    const c = this.results.comparison;

    // Performance comparison table
    console.log('\n━━━ Performance Comparison ━━━\n');
    console.log('┌─────────────────┬──────────────┬──────────────┬─────────────┐');
    console.log('│ Metric          │ SQLite       │ PouchDB      │ Winner      │');
    console.log('├─────────────────┼──────────────┼──────────────┼─────────────┤');
    console.log(`│ Insert (${TEST_DOC_COUNT} docs)│ ${formatMs(s.insert.timeMs).padEnd(12)} │ ${formatMs(p.insert.timeMs).padEnd(12)} │ ${c.insert.winner === 'sqlite' ? '✓ SQLite' : '✓ PouchDB'}`);
    console.log(`│ Read            │ ${formatMs(s.read.timeMs).padEnd(12)} │ ${formatMs(p.read.timeMs).padEnd(12)} │ ${c.read.winner === 'sqlite' ? '✓ SQLite' : '✓ PouchDB'}`);
    console.log(`│ Push to CouchDB │ ${formatMs(s.push.timeMs).padEnd(12)} │ ${formatMs(p.push.timeMs).padEnd(12)} │ ${c.push.winner === 'sqlite' ? '✓ SQLite' : '✓ PouchDB'}`);
    console.log(`│ Pull from Couch │ ${formatMs(s.pull.timeMs).padEnd(12)} │ ${formatMs(p.pull.timeMs).padEnd(12)} │ ${c.pull.winner === 'sqlite' ? '✓ SQLite' : '✓ PouchDB'}`);
    console.log('└─────────────────┴──────────────┴──────────────┴─────────────┘');

    // Throughput table
    console.log('\n━━━ Throughput (docs/sec) ━━━\n');
    console.log('┌─────────────────┬──────────────┬──────────────┐');
    console.log('│ Operation       │ SQLite       │ PouchDB      │');
    console.log('├─────────────────┼──────────────┼──────────────┤');
    console.log(`│ Insert          │ ${s.insert.docsPerSec.toFixed(0).padStart(12)} │ ${p.insert.docsPerSec.toFixed(0).padStart(12)} │`);
    console.log(`│ Read            │ ${s.read.docsPerSec.toFixed(0).padStart(12)} │ ${p.read.docsPerSec.toFixed(0).padStart(12)} │`);
    console.log(`│ Push            │ ${s.push.docsPerSec.toFixed(0).padStart(12)} │ ${p.push.docsPerSec.toFixed(0).padStart(12)} │`);
    console.log(`│ Pull            │ ${s.pull.docsPerSec.toFixed(0).padStart(12)} │ ${p.pull.docsPerSec.toFixed(0).padStart(12)} │`);
    console.log('└─────────────────┴──────────────┴──────────────┘');

    // Memory usage
    console.log('\n━━━ Memory Usage ━━━\n');
    console.log('┌─────────────────┬──────────────┬──────────────┐');
    console.log('│ Metric          │ SQLite       │ PouchDB      │');
    console.log('├─────────────────┼──────────────┼──────────────┤');
    console.log(`│ RSS Delta       │ ${formatBytes(s.memory.deltaRss).padStart(12)} │ ${formatBytes(p.memory.deltaRss).padStart(12)} │`);
    console.log(`│ Heap Delta      │ ${formatBytes(s.memory.deltaHeap).padStart(12)} │ ${formatBytes(p.memory.deltaHeap).padStart(12)} │`);
    console.log('└─────────────────┴──────────────┴──────────────┘');

    // Code complexity
    console.log('\n━━━ Code Complexity ━━━\n');
    console.log('┌─────────────────────┬──────────────┬──────────────┐');
    console.log('│ Metric              │ SQLite       │ PouchDB      │');
    console.log('├─────────────────────┼──────────────┼──────────────┤');
    console.log(`│ Sync Code (LOC)     │ ${String(c.codeComplexity.syncCodeLOC.sqlite).padStart(12)} │ ${String(c.codeComplexity.syncCodeLOC.pouchdb).padStart(12)} │`);
    console.log(`│ DB Code (LOC)       │ ${String(c.codeComplexity.dbCodeLOC.sqlite).padStart(12)} │ ${String(c.codeComplexity.dbCodeLOC.pouchdb).padStart(12)} │`);
    console.log(`│ Manual Sync Logic   │ ${String(c.codeComplexity.manualSyncLogic.sqlite).padStart(12)} │ ${String(c.codeComplexity.manualSyncLogic.pouchdb).padStart(12)} │`);
    console.log(`│ Schema Tables       │ ${String(c.codeComplexity.schemaTables.sqlite).padStart(12)} │ ${String(c.codeComplexity.schemaTables.pouchdb).padStart(12)} │`);
    console.log('└─────────────────────┴──────────────┴──────────────┘');

    // Initial-pull scenario (separate from the regular push-then-pull workload,
    // which correctly returns 0 docs for PouchDB because the sync already
    // knows about the just-pushed docs).
    const ip = this.results.initialPull;
    if (ip && ip.docsRead !== undefined) {
      console.log('\n━━━ Initial-Pull Scenario (fresh device joins) ━━━\n');
      console.log('┌──────────────────────┬──────────────────────────────┐');
      console.log('│ Metric               │ Value                        │');
      console.log('├──────────────────────┼──────────────────────────────┤');
      console.log(`│ Time                 │ ${formatMs(ip.timeMs).padStart(28)} │`);
      console.log(`│ Documents pulled     │ ${String(ip.docsRead).padStart(28)} │`);
      console.log(`│ Documents pushed     │ ${String(ip.docsPushed).padStart(28)} │`);
      console.log(`│ Throughput (docs/sec)│ ${String(Math.round(ip.docsPerSec)).padStart(28)} │`);
      console.log(`│ Final local count    │ ${String(ip.finalLocalCount).padStart(28)} │`);
      console.log(`│ RSS Delta            │ ${formatBytes(ip.memory.deltaRss).padStart(28)} │`);
      console.log(`│ Heap Delta           │ ${formatBytes(ip.memory.deltaHeap).padStart(28)} │`);
      console.log('└──────────────────────┴──────────────────────────────┘');
    }

    // Summary
    const sqliteWins = [c.insert, c.read, c.push, c.pull, c.memory].filter(r => r.winner === 'sqlite').length;
    const pouchdbWins = [c.insert, c.read, c.push, c.pull, c.memory].filter(r => r.winner === 'pouchdb').length;

    console.log('\n━━━ Summary ━━━\n');
    console.log(`  SQLite wins: ${sqliteWins}/5 categories`);
    console.log(`  PouchDB wins: ${pouchdbWins}/5 categories`);
    console.log(`  PouchDB code reduction: ${Math.round(((275 - 201) / 275) * 100)}% sync, ${Math.round(((797 - 434) / 797) * 100)}% DB`);
    console.log(`  PouchDB eliminates: ${197} LOC of manual sync logic`);
    if (ip && ip.docsRead) {
      console.log(`  Initial-pull (fresh device): ${ip.docsRead} docs in ${formatMs(ip.timeMs)} (${Math.round(ip.docsPerSec)} docs/sec)`);
    }
    console.log('');
  }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  SQLite↔CouchDB vs PouchDB↔CouchDB Sync Benchmark         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const runner = new BenchmarkRunner();

  // Verify CouchDB connection
  log('Verifying CouchDB connection...');
  const connected = await runner.verifyCouchDB();
  if (!connected) {
    console.error('\n✗ Cannot connect to CouchDB. Please ensure CouchDB is running.');
    console.error(`  URL: ${COUCHDB_URL}`);
    process.exit(1);
  }
  log('CouchDB connection verified', 'success');

  try {
    // Run SQLite benchmark
    await runner.runSQLiteBenchmark();

    // Run PouchDB benchmark
    await runner.runPouchDBBenchmark();

    // Run initial-pull scenario (fresh device joins a populated remote)
    await runner.runInitialPullBenchmark();

    // Generate comparison
    runner.generateComparison();

    // Print report
    runner.printReport();

    // Cleanup test databases
    log('\nCleaning up test databases...');
    await runner.cleanupTestDatabases();
    log('Cleanup complete', 'success');

  } catch (err) {
    console.error('\nBenchmark failed:', err.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { BenchmarkRunner };
