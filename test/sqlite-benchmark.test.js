/**
 * test/sqlite-benchmark.test.js
 *
 * Unit tests for the SQLite benchmark layer in evaluation/benchmark.js,
 * including a conflict-tracking pipeline that mirrors the PouchDB
 * implementation in electron/db.js:
 *   - Table creation (students, equipment, loans, conflicts)
 *   - CRUD operations on all collections
 *   - Sync tracking (getUnsynced, markSynced)
 *   - logConflict / getPendingConflicts / resolveConflict
 *   - Conflict detection via local vs remote comparison
 *   - Data integrity and relationships
 *
 * Uses Node's built-in `node:test` runner (no extra dependencies).
 * Run with: `npm run test:sqlite`
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const sqlite3  = require('sqlite3').verbose();

// Fresh temp DB per run
const DB_PATH = path.join(os.tmpdir(), `cos20015-sqlite-test-${Date.now()}.db`);

// ── DB Helpers ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function closeDB(db) {
  return new Promise((resolve) => {
    db.close(() => {
      try { fs.unlinkSync(DB_PATH); } catch {}
      resolve();
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// ── SQLite Conflict Pipeline ───────────────────────────────────────────
// Mirrors the PouchDB conflict pipeline in electron/db.js using a
// SQLite `conflicts` table instead of a PouchDB `conflictsDB` instance.

async function sqliteLogConflict(db, { table, documentID, localRev, remoteRev, localDoc, remoteDoc }) {
  const existing = await get(
    db,
    `SELECT * FROM conflicts WHERE status = 'pending' AND "table" = ? AND documentID = ?`,
    [table, documentID]
  );
  if (existing) return existing;

  const conflictID = `conflict_${Date.now()}_${documentID}`;
  const now = new Date().toISOString();
  await run(db,
    `INSERT INTO conflicts (conflictID, "table", documentID, localRev, remoteRev, localDoc, remoteDoc, status, resolution, winnerData, timestamp, resolvedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
    [conflictID, table, documentID, localRev, remoteRev, JSON.stringify(localDoc), JSON.stringify(remoteDoc), now]
  );
  return await get(db, 'SELECT * FROM conflicts WHERE conflictID = ?', [conflictID]);
}

async function sqliteGetPendingConflicts(db) {
  const rows = await all(db, `SELECT * FROM conflicts WHERE status = 'pending' ORDER BY timestamp DESC`);
  return rows.map(r => ({
    ...r,
    table: r.table,
    localDoc: JSON.parse(r.localDoc || '{}'),
    remoteDoc: JSON.parse(r.remoteDoc || '{}'),
    winnerData: r.winnerData ? JSON.parse(r.winnerData) : null,
  }));
}

async function sqliteResolveConflict(db, conflictID, resolution, winnerData) {
  const conflict = await get(db, 'SELECT * FROM conflicts WHERE conflictID = ?', [conflictID]);
  if (!conflict) throw new Error(`Conflict not found: ${conflictID}`);

  const remoteDoc = JSON.parse(conflict.remoteDoc || '{}');

  const applyToTable = (tableName, doc) => {
    const cols = Object.keys(doc).filter(k => k !== 'synced' && k !== 'lastModified');
    const placeholders = cols.map(() => '?').join(', ');
    const values = cols.map(k => {
      const v = doc[k];
      return typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'object' ? JSON.stringify(v) : v);
    });
    return run(db,
      `INSERT OR REPLACE INTO ${tableName} (${cols.join(', ')}, synced, lastModified)
       VALUES (${placeholders}, 0, ?)`,
      [...values, new Date().toISOString()]
    );
  };

  if (resolution === 'remote' && remoteDoc._id) {
    await applyToTable(conflict.table, remoteDoc);
  } else if ((resolution === 'local' || resolution === 'merge') && winnerData) {
    await applyToTable(conflict.table, winnerData);
  }

  await run(db,
    `UPDATE conflicts SET status = 'resolved', resolution = ?, winnerData = ?, resolvedAt = ? WHERE conflictID = ?`,
    [resolution, winnerData ? JSON.stringify(winnerData) : null, new Date().toISOString(), conflictID]
  );

  return { success: true, conflictID, resolution };
}

// ── Sample Data ────────────────────────────────────────────────────────

const SAMPLE_STUDENTS = [
  { _id: 'S0001', studentID: 'S0001', firstName: 'William', lastName: 'Yong',   phone: '0123456789', email: 'william.yong@swinburne.edu.my' },
  { _id: 'S0002', studentID: 'S0002', firstName: 'John',    lastName: 'Tan',    phone: '0112345678', email: 'john.tan@swinburne.edu.my' },
  { _id: 'S0003', studentID: 'S0003', firstName: 'Sarah',   lastName: 'Lee',    phone: '0198765432', email: 'sarah.lee@swinburne.edu.my' },
];

const SAMPLE_EQUIPMENT = [
  { _id: 'E0001', equipmentID: 'E0001', name: 'Dell Latitude 5430',     category: 'Laptop',          available: 1 },
  { _id: 'E0002', equipmentID: 'E0002', name: 'Canon EOS R50',          category: 'Camera',          available: 1 },
  { _id: 'E0003', equipmentID: 'E0003', name: 'Arduino Uno R3',         category: 'Microcontroller', available: 1 },
];

const SAMPLE_LOANS = [
  { _id: 'loan_L0001', loanID: 'L0001', studentID: 'S0001', equipmentID: 'E0001', borrowDate: '2025-06-01', returnDate: null, status: 'Borrowed', type: 'loan' },
  { _id: 'loan_L0002', loanID: 'L0002', studentID: 'S0002', equipmentID: 'E0002', borrowDate: '2025-06-05', returnDate: '2025-06-12', status: 'Returned', type: 'loan' },
];

// ── Tests ──────────────────────────────────────────────────────────────

let db;

test('setup: open database and create tables', async () => {
  db = await openDB();

  await run(db, 'PRAGMA foreign_keys = ON');
  await run(db, `
    CREATE TABLE IF NOT EXISTS students (
      _id TEXT PRIMARY KEY,
      studentID TEXT NOT NULL UNIQUE,
      firstName TEXT NOT NULL,
      lastName TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      synced INTEGER DEFAULT 0,
      lastModified TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS equipment (
      _id TEXT PRIMARY KEY,
      equipmentID TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT,
      available INTEGER DEFAULT 1,
      synced INTEGER DEFAULT 0,
      lastModified TEXT
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS loans (
      _id TEXT PRIMARY KEY,
      loanID TEXT NOT NULL,
      studentID TEXT NOT NULL,
      equipmentID TEXT NOT NULL,
      borrowDate TEXT,
      returnDate TEXT,
      status TEXT DEFAULT 'Borrowed',
      synced INTEGER DEFAULT 0,
      type TEXT DEFAULT 'loan',
      lastModified TEXT,
      FOREIGN KEY (studentID) REFERENCES students(studentID),
      FOREIGN KEY (equipmentID) REFERENCES equipment(equipmentID)
    )
  `);
  await run(db, `
    CREATE TABLE IF NOT EXISTS conflicts (
      conflictID TEXT PRIMARY KEY,
      "table" TEXT NOT NULL,
      documentID TEXT NOT NULL,
      localRev TEXT,
      remoteRev TEXT,
      localDoc TEXT,
      remoteDoc TEXT,
      status TEXT DEFAULT 'pending',
      resolution TEXT,
      winnerData TEXT,
      timestamp TEXT,
      resolvedAt TEXT
    )
  `);

  const tables = await all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('students','equipment','loans','conflicts')");
  assert.equal(tables.length, 4, 'all four tables should exist');
});

// ── CRUD Tests ─────────────────────────────────────────────────────────

test('insertStudents: inserts all student records', async () => {
  const now = new Date().toISOString();
  for (const s of SAMPLE_STUDENTS) {
    await run(db,
      `INSERT OR REPLACE INTO students (_id, studentID, firstName, lastName, phone, email, synced, lastModified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [s._id, s.studentID, s.firstName, s.lastName, s.phone, s.email, 0, now]
    );
  }
  const rows = await all(db, 'SELECT * FROM students');
  assert.equal(rows.length, 3);
});

test('insertEquipment: inserts all equipment records', async () => {
  const now = new Date().toISOString();
  for (const e of SAMPLE_EQUIPMENT) {
    await run(db,
      `INSERT OR REPLACE INTO equipment (_id, equipmentID, name, category, available, synced, lastModified)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [e._id, e.equipmentID, e.name, e.category, e.available, 0, now]
    );
  }
  const rows = await all(db, 'SELECT * FROM equipment');
  assert.equal(rows.length, 3);
});

test('insertLoans: inserts all loan records', async () => {
  const now = new Date().toISOString();
  for (const l of SAMPLE_LOANS) {
    await run(db,
      `INSERT OR REPLACE INTO loans (_id, loanID, studentID, equipmentID, borrowDate, returnDate, status, synced, type, lastModified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l._id, l.loanID, l.studentID, l.equipmentID, l.borrowDate, l.returnDate, l.status, 0, l.type, now]
    );
  }
  const rows = await all(db, 'SELECT * FROM loans');
  assert.equal(rows.length, 2);
});

test('loan references valid student and equipment', async () => {
  const loans = await all(db, 'SELECT * FROM loans');
  for (const loan of loans) {
    const student = await get(db, 'SELECT * FROM students WHERE studentID = ?', [loan.studentID]);
    assert.ok(student, `loan ${loan.loanID} references valid student ${loan.studentID}`);
    const equip = await get(db, 'SELECT * FROM equipment WHERE equipmentID = ?', [loan.equipmentID]);
    assert.ok(equip, `loan ${loan.loanID} references valid equipment ${loan.equipmentID}`);
  }
});

// ── Sync Tracking Tests ────────────────────────────────────────────────

test('getUnsyncedFromTable: returns only unsynced records', async () => {
  const unsynced = await all(db, 'SELECT * FROM students WHERE synced = 0');
  assert.ok(unsynced.length >= 2);
  for (const row of unsynced) {
    assert.equal(row.synced, 0);
  }
});

test('markSynced: marks a record as synced', async () => {
  await run(db, 'UPDATE students SET synced = 1 WHERE _id = ?', ['S0001']);
  const row = await get(db, 'SELECT * FROM students WHERE _id = ?', ['S0001']);
  assert.equal(row.synced, 1);
});

test('markAllSynced: marks all records as synced', async () => {
  await run(db, 'UPDATE students SET synced = 0');
  await run(db, 'UPDATE students SET synced = 1 WHERE synced = 0');
  const unsynced = await all(db, 'SELECT * FROM students WHERE synced = 0');
  assert.equal(unsynced.length, 0);
});

// ── Conflict Pipeline Tests ────────────────────────────────────────────

test('logConflict writes a pending record', async () => {
  const logged = await sqliteLogConflict(db, {
    table: 'equipment',
    documentID: 'E0001',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc: { _id: 'E0001', equipmentID: 'E0001', name: 'Dell Latitude 5430', category: 'Laptop', available: true },
    remoteDoc: { _id: 'E0001', equipmentID: 'E0001', name: 'Dell Latitude 5430', category: 'Laptop', available: false },
  });

  assert.equal(logged.status, 'pending');
  assert.equal(logged.table, 'equipment');
  assert.equal(logged.documentID, 'E0001');
  assert.match(logged.conflictID, /^conflict_\d+_E0001$/);
  assert.ok(logged.timestamp);
});

test('logConflict de-duplicates on (table, documentID) while pending', async () => {
  const first = await sqliteLogConflict(db, {
    table: 'loans',
    documentID: 'loan_L0001',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0001', loanID: 'L0001', studentID: 'S0001', equipmentID: 'E0001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0001', loanID: 'L0001', studentID: 'S0001', equipmentID: 'E0001', status: 'Returned' },
  });
  const second = await sqliteLogConflict(db, {
    table: 'loans',
    documentID: 'loan_L0001',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0001', loanID: 'L0001', studentID: 'S0001', equipmentID: 'E0001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0001', loanID: 'L0001', studentID: 'S0001', equipmentID: 'E0001', status: 'Returned' },
  });

  assert.equal(second.conflictID, first.conflictID);
  const pending = await sqliteGetPendingConflicts(db);
  const loans = pending.filter(c => c.documentID === 'loan_L0001');
  assert.equal(loans.length, 1, 'only one pending conflict for loan_L0001');
});

test('getPendingConflicts returns only pending, sorted newest-first', async () => {
  await sqliteLogConflict(db, {
    table: 'students', documentID: 'S0001',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0001', studentID: 'S0001', firstName: 'William', lastName: 'Yong', email: 'william.yong@swinburne.edu.my' },
    remoteDoc: { _id: 'S0001', studentID: 'S0001', firstName: 'William', lastName: 'Yong', email: 'william.yong@example.com' },
  });
  await new Promise(r => setTimeout(r, 5));
  await sqliteLogConflict(db, {
    table: 'students', documentID: 'S0002',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0002', studentID: 'S0002', firstName: 'John', lastName: 'Tan', email: 'john.tan@swinburne.edu.my' },
    remoteDoc: { _id: 'S0002', studentID: 'S0002', firstName: 'John', lastName: 'Tan', email: 'john.tan@example.com' },
  });

  const pending = await sqliteGetPendingConflicts(db);
  for (const c of pending) {
    assert.equal(c.status, 'pending');
  }
  const s0001 = pending.findIndex(c => c.documentID === 'S0001');
  const s0002 = pending.findIndex(c => c.documentID === 'S0002');
  assert.ok(s0001 >= 0 && s0002 >= 0, 'both present');
  assert.ok(s0002 < s0001, `S0002 (idx ${s0002}) should be before S0001 (idx ${s0001})`);
});

test('resolveConflict("remote") applies the remote revision', async () => {
  const logged = await sqliteLogConflict(db, {
    table: 'equipment',
    documentID: 'E0002',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc: { _id: 'E0002', equipmentID: 'E0002', name: 'Canon EOS R50', category: 'Camera', available: true },
    remoteDoc: { _id: 'E0002', equipmentID: 'E0002', name: 'Canon EOS R50', category: 'Camera', available: false },
  });

  const result = await sqliteResolveConflict(db, logged.conflictID, 'remote');
  assert.equal(result.success, true);
  assert.equal(result.resolution, 'remote');

  const after = await get(db, 'SELECT * FROM equipment WHERE _id = ?', ['E0002']);
  assert.equal(after.name, 'Canon EOS R50');
  assert.equal(after.available, 0, 'should be unavailable (remote version)');

  const pending = await sqliteGetPendingConflicts(db);
  assert.equal(pending.find(c => c.conflictID === logged.conflictID), undefined, 'resolved conflict should not appear in pending list');
});

test('resolveConflict("merge") writes the caller-supplied winnerData', async () => {
  const logged = await sqliteLogConflict(db, {
    table: 'equipment',
    documentID: 'E0003',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'E0003', equipmentID: 'E0003', name: 'Arduino Uno R3', category: 'Microcontroller' },
    remoteDoc: { _id: 'E0003', equipmentID: 'E0003', name: 'Arduino Uno R3 (Rev3)', category: 'Microcontroller' },
  });

  const merged = { _id: 'E0003', equipmentID: 'E0003', name: 'Arduino Uno R3', category: 'Microcontroller', available: true };
  await sqliteResolveConflict(db, logged.conflictID, 'merge', merged);

  const after = await get(db, 'SELECT * FROM equipment WHERE _id = ?', ['E0003']);
  assert.equal(after.name, 'Arduino Uno R3');
});

test('resolveConflict("local") keeps the local version', async () => {
  const logged = await sqliteLogConflict(db, {
    table: 'students',
    documentID: 'S0003',
    localRev: '1-a', remoteRev: '1-b',
    localDoc: { _id: 'S0003', studentID: 'S0003', firstName: 'Sarah', lastName: 'Lee', email: 'sarah.lee@swinburne.edu.my' },
    remoteDoc: { _id: 'S0003', studentID: 'S0003', firstName: 'Sarah', lastName: 'Lee', email: 'sarah.lee@example.com' },
  });

  const localData = { _id: 'S0003', studentID: 'S0003', firstName: 'Sarah', lastName: 'Lee', phone: '0198765432', email: 'sarah.lee@swinburne.edu.my' };
  await sqliteResolveConflict(db, logged.conflictID, 'local', localData);

  const after = await get(db, 'SELECT * FROM students WHERE _id = ?', ['S0003']);
  assert.equal(after.email, 'sarah.lee@swinburne.edu.my', 'should keep local email');
});

test('resolveConflict throws on unknown conflictID', async () => {
  await assert.rejects(
    () => sqliteResolveConflict(db, 'conflict_does_not_exist', 'remote'),
    /Conflict not found/
  );
});

test('multiple conflicts on different tables coexist', async () => {
  await sqliteLogConflict(db, {
    table: 'students', documentID: 'S0001',
    localRev: '3-a', remoteRev: '3-b',
    localDoc: { _id: 'S0001', firstName: 'William' },
    remoteDoc: { _id: 'S0001', firstName: 'Will' },
  });
  await sqliteLogConflict(db, {
    table: 'loans', documentID: 'loan_L0002',
    localRev: '1-a', remoteRev: '1-b',
    localDoc: { _id: 'loan_L0002', status: 'Returned' },
    remoteDoc: { _id: 'loan_L0002', status: 'Borrowed' },
  });

  const pending = await sqliteGetPendingConflicts(db);
  const studentConflicts = pending.filter(c => c.table === 'students');
  const loanConflicts = pending.filter(c => c.table === 'loans');
  assert.ok(studentConflicts.length >= 1, 'should have student conflicts');
  assert.ok(loanConflicts.length >= 1, 'should have loan conflicts');
});

test('resolveConflict marks resolvedAt timestamp', async () => {
  const logged = await sqliteLogConflict(db, {
    table: 'equipment', documentID: 'E0001',
    localRev: '2-a', remoteRev: '2-b',
    localDoc: { _id: 'E0001', name: 'Dell Latitude 5430' },
    remoteDoc: { _id: 'E0001', name: 'Dell Latitude 5430 Gen 2' },
  });

  const before = Date.now();
  await sqliteResolveConflict(db, logged.conflictID, 'remote');
  const after = await get(db, 'SELECT * FROM conflicts WHERE conflictID = ?', [logged.conflictID]);

  assert.equal(after.status, 'resolved');
  assert.equal(after.resolution, 'remote');
  assert.ok(after.resolvedAt, 'resolvedAt should be set');
  assert.ok(new Date(after.resolvedAt).getTime() >= before, 'resolvedAt should be recent');
});

test('cleanup: close database', async () => {
  await closeDB(db);
});
