/**
 * test/pouchdb_conflict_test.js
 *
 * Self-contained unit tests for the PouchDB conflict-tracking pipeline:
 *   - logConflict()
 *   - getPendingConflicts()
 *   - resolveConflict()
 *   - detectConflicts()
 *
 * Uses Node's built-in `node:test` runner (no extra dependencies).
 * Run with: `node --test test/pouchdb_conflict_test.js`
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const PouchDB  = require('pouchdb');

// Fresh, empty working dir per test file run
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cos20015-pouchdb-conflict-'));

// ── PouchDB instances ───────────────────────────────────────────────────
const studentsDB  = new PouchDB(path.join(TMP_DIR, 'students'));
const equipmentDB = new PouchDB(path.join(TMP_DIR, 'equipment'));
const loansDB     = new PouchDB(path.join(TMP_DIR, 'loans'));
const conflictsDB = new PouchDB(path.join(TMP_DIR, 'conflicts'));

// ── Conflict Pipeline (mirrors electron/db.js) ──────────────────────────

async function logConflict({ table, documentID, localRev, remoteRev, localDoc, remoteDoc }) {
  const existing = await conflictsDB.allDocs({ include_docs: true });
  const dup = existing.rows.find((row) =>
    row.doc.status === 'pending' &&
    row.doc.table === table &&
    row.doc.documentID === documentID
  );
  if (dup) return dup.doc;

  const conflictID = `conflict_${Date.now()}_${documentID}`;
  const doc = {
    _id: conflictID,
    conflictID,
    table,
    documentID,
    localRev,
    remoteRev,
    localDoc,
    remoteDoc,
    status: 'pending',
    resolution: null,
    winnerData: null,
    timestamp: new Date().toISOString(),
    resolvedAt: null,
  };
  await conflictsDB.put(doc);
  return doc;
}

async function getPendingConflicts() {
  const result = await conflictsDB.allDocs({ include_docs: true });
  return result.rows
    .map((row) => row.doc)
    .filter((doc) => !doc._id.startsWith('_design/') && doc.status === 'pending')
    .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
}

async function upsertFromRemote(table, record) {
  if (table === 'students') {
    const doc = { _id: record.studentID, ...record };
    try {
      const existing = await studentsDB.get(record.studentID);
      doc._rev = existing._rev;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await studentsDB.put(doc);
  } else if (table === 'equipment') {
    const doc = { _id: record.equipmentID, ...record };
    try {
      const existing = await equipmentDB.get(record.equipmentID);
      doc._rev = existing._rev;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    await equipmentDB.put(doc);
  } else if (table === 'loans') {
    const doc = { _id: `loan_${record.loanID}`, ...record, synced: true };
    try {
      const existing = await loansDB.allDocs({ include_docs: true });
      const existingLoan = existing.rows.find(row => row.doc.loanID === record.loanID);
      if (existingLoan) {
        doc._rev = existingLoan.doc._rev;
        doc._id = existingLoan.doc._id;
      }
    } catch (err) {
      // ignore
    }
    await loansDB.put(doc);
  }
}

async function resolveConflict(conflictID, resolution, winnerData) {
  const result = await conflictsDB.allDocs({ include_docs: true });
  const conflictDoc = result.rows.find((row) => row.doc.conflictID === conflictID)?.doc;
  if (!conflictDoc) throw new Error(`Conflict not found: ${conflictID}`);

  if (resolution === 'remote' && conflictDoc.remoteDoc) {
    await upsertFromRemote(conflictDoc.table, conflictDoc.remoteDoc);
  } else if ((resolution === 'local' || resolution === 'merge') && winnerData) {
    await upsertFromRemote(conflictDoc.table, winnerData);
  }

  await conflictsDB.put({
    ...conflictDoc,
    status: 'resolved',
    resolution,
    winnerData: winnerData || null,
    resolvedAt: new Date().toISOString(),
  });

  return { success: true, conflictID, resolution };
}

async function detectConflicts() {
  const sources = [
    { table: 'students',  db: studentsDB  },
    { table: 'equipment', db: equipmentDB },
    { table: 'loans',     db: loansDB     },
  ];
  const detected = [];

  for (const { table, db } of sources) {
    const result = await db.allDocs({ include_docs: true, conflicts: true });
    for (const row of result.rows) {
      const conflicts = row.doc._conflicts;
      if (!conflicts || conflicts.length === 0) continue;

      for (const conflictingRev of conflicts) {
        try {
          const remoteDoc = await db.get(row.doc._id, { rev: conflictingRev });
          const logged = await logConflict({
            table,
            documentID: row.doc._id,
            localRev: row.doc._rev,
            remoteRev: conflictingRev,
            localDoc: row.doc,
            remoteDoc,
          });
          if (logged && !detected.find((d) => d.conflictID === logged.conflictID)) {
            detected.push({ table, documentID: row.doc._id, conflictID: logged.conflictID });
          }
        } catch (err) {
          // Skip revs that can't be fetched
        }
      }
    }
  }
  return detected;
}

// ── Helper: force a real PouchDB conflict ───────────────────────────────

async function forceEquipmentConflict(docId, versionA, versionB) {
  await equipmentDB.put({ _id: docId, equipmentID: docId, name: versionA, category: 'Laptop', available: true });
  const cur = await equipmentDB.get(docId);
  const rev1 = cur._rev;

  await equipmentDB.put({ _id: docId, _rev: rev1, equipmentID: docId, name: 'Dell Latitude 5430', category: 'Laptop', available: true });

  await equipmentDB.bulkDocs(
    [{ _id: docId, _rev: rev1, equipmentID: docId, name: versionB, category: 'Laptop', available: true, _revisions: { start: 2, ids: [rev1.split('-')[1], 'AAAAAAAA'] } }],
    { new_edits: false }
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

test('logConflict writes a pending record', async () => {
  const logged = await logConflict({
    table: 'equipment',
    documentID: 'E001',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc: { _id: 'E001', equipmentID: 'E001', name: 'Dell Latitude 5430', category: 'Laptop', available: true },
    remoteDoc: { _id: 'E001', equipmentID: 'E001', name: 'Dell Latitude 5430', category: 'Laptop', available: false },
  });

  assert.equal(logged.status, 'pending');
  assert.equal(logged.table, 'equipment');
  assert.equal(logged.documentID, 'E001');
  assert.match(logged.conflictID, /^conflict_\d+_E001$/);
  assert.ok(logged.timestamp);
});

test('logConflict de-duplicates on (table, documentID) while pending', async () => {
  const first = await logConflict({
    table: 'loans',
    documentID: 'loan_L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Returned' },
  });
  const second = await logConflict({
    table: 'loans',
    documentID: 'loan_L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Returned' },
  });

  assert.equal(second.conflictID, first.conflictID);
  const pending = await getPendingConflicts();
  const loans = pending.filter(c => c.documentID === 'loan_L0042');
  assert.equal(loans.length, 1, 'only one pending conflict for loan_L0042');
});

test('getPendingConflicts returns only pending, sorted newest-first', async () => {
  await logConflict({
    table: 'students', documentID: 'S0100',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0100', studentID: 'S0100', firstName: 'Ahmed', lastName: 'Ali', email: 'ahmed.ali@swinburne.edu.my' },
    remoteDoc: { _id: 'S0100', studentID: 'S0100', firstName: 'Ahmed', lastName: 'Ali', email: 'ahmed.ali@example.com' },
  });
  await new Promise(r => setTimeout(r, 5));
  await logConflict({
    table: 'students', documentID: 'S0101',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0101', studentID: 'S0101', firstName: 'Priya', lastName: 'Patel', email: 'priya.patel@swinburne.edu.my' },
    remoteDoc: { _id: 'S0101', studentID: 'S0101', firstName: 'Priya', lastName: 'Patel', email: 'priya.patel@example.com' },
  });

  const pending = await getPendingConflicts();
  for (const c of pending) {
    assert.equal(c.status, 'pending');
  }
  const s0100 = pending.findIndex(c => c.documentID === 'S0100');
  const s0101 = pending.findIndex(c => c.documentID === 'S0101');
  assert.ok(s0100 >= 0 && s0101 >= 0, 'both present');
  assert.ok(s0101 < s0100, `S0101 (idx ${s0101}) should be before S0100 (idx ${s0100})`);
});

test('resolveConflict applies the remote revision and marks the record resolved', async () => {
  await equipmentDB.put({ _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: true });

  const logged = await logConflict({
    table: 'equipment',
    documentID: 'E0777',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc:  { _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: true },
    remoteDoc: { _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: false },
  });

  const result = await resolveConflict(logged.conflictID, 'remote');
  assert.equal(result.success, true);
  assert.equal(result.resolution, 'remote');

  const after = await equipmentDB.get('E0777');
  assert.equal(after.name, 'Canon EOS R50');
  assert.equal(after.available, false);

  const pending = await getPendingConflicts();
  assert.equal(
    pending.find(c => c.conflictID === logged.conflictID),
    undefined,
    'resolved conflict should not appear in pending list'
  );
});

test('resolveConflict("merge") writes the caller-supplied winnerData', async () => {
  await equipmentDB.put({ _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller', available: true });
  const logged = await logConflict({
    table: 'equipment',
    documentID: 'E0888',
    localRev: '1-x', remoteRev: '1-y',
    localDoc:  { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller' },
    remoteDoc: { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3 (Rev3)', category: 'Microcontroller' },
  });

  const merged = { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller', available: true };
  await resolveConflict(logged.conflictID, 'merge', merged);

  const after = await equipmentDB.get('E0888');
  assert.equal(after.name, 'Arduino Uno R3');
});

test('resolveConflict throws on unknown conflictID', async () => {
  await assert.rejects(
    () => resolveConflict('conflict_does_not_exist', 'remote'),
    /Conflict not found/
  );
});

test('detectConflicts finds and logs conflicts on the source DBs', async () => {
  await forceEquipmentConflict('E0999', 'Sony WH-1000XM5', 'Sony WH-1000XM4');

  const detected = await detectConflicts();
  const e0999 = detected.find(d => d.documentID === 'E0999' && d.table === 'equipment');
  assert.ok(e0999, `detectConflicts should find E0999 conflict, got: ${JSON.stringify(detected)}`);

  const pending = await getPendingConflicts();
  const e0999Pending = pending.find(c => c.documentID === 'E0999' && c.table === 'equipment');
  assert.ok(e0999Pending, 'E0999 conflict should be in pending list');
  assert.equal(e0999Pending.status, 'pending');
  assert.ok(e0999Pending.localDoc && e0999Pending.remoteDoc, 'both localDoc and remoteDoc should be captured');
});

test('detectConflicts is idempotent: re-running does not create duplicate pending records', async () => {
  await forceEquipmentConflict('E1000', 'Epson Projector X500', 'Epson Projector X400');
  await detectConflicts();
  await detectConflicts();
  await detectConflicts();

  const pending = await getPendingConflicts();
  const e1000Pending = pending.filter(c => c.documentID === 'E1000' && c.table === 'equipment');
  assert.equal(e1000Pending.length, 1, 'only one pending conflict for E1000 even after 3 detect passes');
});

test('cleanup', async () => {
  await studentsDB.destroy();
  await equipmentDB.destroy();
  await loansDB.destroy();
  await conflictsDB.destroy();
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
});
