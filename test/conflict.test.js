/**
 * test/conflict.test.js
 *
 * Unit tests for the conflict-tracking pipeline in electron/db.js:
 *   - logConflict()
 *   - getPendingConflicts()
 *   - resolveConflict()
 *   - detectConflicts()
 *
 * Uses Node's built-in `node:test` runner (no extra dependencies).
 * Run with: `npm test`
 *
 * These tests run outside Electron: they set POUCHDB_DIR_OVERRIDE to
 * a fresh temp dir, so db.js never imports the `electron` package.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

// Fresh, empty working dir per test file run
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cos20015-conflict-test-'));
process.env.POUCHDB_DIR_OVERRIDE = TMP_DIR;

// Clean up the PouchDB instances the module creates on require
function cleanup(done) {
  try {
    const db = require('../electron/db');
    Promise.all([
      db.studentsDB  && db.studentsDB.destroy(),
      db.equipmentDB && db.equipmentDB.destroy(),
      db.loansDB     && db.loansDB.destroy(),
      db.conflictsDB && db.conflictsDB.destroy(),
    ]).catch(() => {}).finally(() => {
      try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
      done && done();
    });
  } catch (e) {
    done && done();
  }
}

// Require AFTER setting the env var so the module picks up the temp dir
const db = require('../electron/db');

// Helper: create a real PouchDB conflict on the equipmentDB by writing
// a divergent edit at an old revision via bulkDocs({ new_edits: false }).
async function forceEquipmentConflict(docId, versionA, versionB) {
  // First write: rev 1
  await db.equipmentDB.put({ _id: docId, equipmentID: docId, name: versionA, category: 'Laptop', available: true });
  // Get the rev
  const cur = await db.equipmentDB.get(docId);
  const rev1 = cur._rev;

  // Update: rev 2 (legitimate)
  await db.equipmentDB.put({ _id: docId, _rev: rev1, equipmentID: docId, name: 'Dell Latitude 5430', category: 'Laptop', available: true });

  // Now write a divergent edit at rev1 with new_edits: false
  // This creates a conflict branch
  await db.equipmentDB.bulkDocs(
    [{ _id: docId, _rev: rev1, equipmentID: docId, name: versionB, category: 'Laptop', available: true, _revisions: { start: 2, ids: [rev1.split('-')[1], 'AAAAAAAA'] } }],
    { new_edits: false }
  );
}

test('logConflict writes a pending record', async () => {
  const logged = await db.logConflict({
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
  const first = await db.logConflict({
    table: 'loans',
    documentID: 'loan_L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Returned' },
  });
  const second = await db.logConflict({
    table: 'loans',
    documentID: 'loan_L0042',
    localRev: '2-aaa',
    remoteRev: '2-bbb',
    localDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Borrowed' },
    remoteDoc: { _id: 'loan_L0042', loanID: 'L0042', studentID: 'S001', equipmentID: 'E001', status: 'Returned' },
  });

  // Second call returns the existing record (same _id), does not create a new one
  assert.equal(second.conflictID, first.conflictID);
  const pending = await db.getPendingConflicts();
  const loans = pending.filter(c => c.documentID === 'loan_L0042');
  assert.equal(loans.length, 1, 'only one pending conflict for loan_L0042');
});

test('getPendingConflicts returns only pending, sorted newest-first', async () => {
  // Two new pending conflicts with slightly different timestamps
  await db.logConflict({
    table: 'students', documentID: 'S0100',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0100', studentID: 'S0100', firstName: 'Ahmed', lastName: 'Ali', email: 'ahmed.ali@swinburne.edu.my' },
    remoteDoc: { _id: 'S0100', studentID: 'S0100', firstName: 'Ahmed', lastName: 'Ali', email: 'ahmed.ali@example.com' },
  });
  // ensure timestamp ordering
  await new Promise(r => setTimeout(r, 5));
  await db.logConflict({
    table: 'students', documentID: 'S0101',
    localRev: '1-x', remoteRev: '1-y',
    localDoc: { _id: 'S0101', studentID: 'S0101', firstName: 'Priya', lastName: 'Patel', email: 'priya.patel@swinburne.edu.my' },
    remoteDoc: { _id: 'S0101', studentID: 'S0101', firstName: 'Priya', lastName: 'Patel', email: 'priya.patel@example.com' },
  });

  const pending = await db.getPendingConflicts();
  // All returned must be pending
  for (const c of pending) {
    assert.equal(c.status, 'pending');
  }
  // Newest-first ordering: S0101 should appear before S0100
  const s0100 = pending.findIndex(c => c.documentID === 'S0100');
  const s0101 = pending.findIndex(c => c.documentID === 'S0101');
  assert.ok(s0100 >= 0 && s0101 >= 0, 'both present');
  assert.ok(s0101 < s0100, `S0101 (idx ${s0101}) should be before S0100 (idx ${s0100})`);
});

test('resolveConflict applies the remote revision and marks the record resolved', async () => {
  // Seed source doc
  await db.equipmentDB.put({ _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: true });

  // Log a conflict whose remoteDoc is what we want to apply.
  // The remoteDoc must include the equipmentID field — upsertFromRemote
  // uses it as the PouchDB _id.
  const logged = await db.logConflict({
    table: 'equipment',
    documentID: 'E0777',
    localRev: '1-aaa',
    remoteRev: '1-bbb',
    localDoc:  { _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: true },
    remoteDoc: { _id: 'E0777', equipmentID: 'E0777', name: 'Canon EOS R50', category: 'Camera', available: false },
  });

  // Resolve as "remote" — should overwrite the local doc with the remote one
  const result = await db.resolveConflict(logged.conflictID, 'remote');
  assert.equal(result.success, true);
  assert.equal(result.resolution, 'remote');

  // The source record should now reflect the remote revision
  const after = await db.equipmentDB.get('E0777');
  assert.equal(after.name, 'Canon EOS R50');
  assert.equal(after.available, false);

  // The conflict record should be marked resolved
  const pending = await db.getPendingConflicts();
  assert.equal(
    pending.find(c => c.conflictID === logged.conflictID),
    undefined,
    'resolved conflict should not appear in pending list'
  );
});

test('resolveConflict("merge") writes the caller-supplied winnerData', async () => {
  await db.equipmentDB.put({ _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller', available: true });
  const logged = await db.logConflict({
    table: 'equipment',
    documentID: 'E0888',
    localRev: '1-x', remoteRev: '1-y',
    localDoc:  { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller' },
    remoteDoc: { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3 (Rev3)', category: 'Microcontroller' },
  });

  const merged = { _id: 'E0888', equipmentID: 'E0888', name: 'Arduino Uno R3', category: 'Microcontroller', available: true };
  await db.resolveConflict(logged.conflictID, 'merge', merged);

  const after = await db.equipmentDB.get('E0888');
  assert.equal(after.name, 'Arduino Uno R3');
});

test('resolveConflict throws on unknown conflictID', async () => {
  await assert.rejects(
    () => db.resolveConflict('conflict_does_not_exist', 'remote'),
    /Conflict not found/
  );
});

test('detectConflicts finds and logs conflicts on the source DBs', async () => {
  // Force a conflict on equipmentDB
  await forceEquipmentConflict('E0999', 'Sony WH-1000XM5', 'Sony WH-1000XM4');

  // detectConflicts should now log this conflict (and any others)
  const detected = await db.detectConflicts();
  const e0999 = detected.find(d => d.documentID === 'E0999' && d.table === 'equipment');
  assert.ok(e0999, `detectConflicts should find E0999 conflict, got: ${JSON.stringify(detected)}`);

  // The conflict should be retrievable via getPendingConflicts
  const pending = await db.getPendingConflicts();
  const e0999Pending = pending.find(c => c.documentID === 'E0999' && c.table === 'equipment');
  assert.ok(e0999Pending, 'E0999 conflict should be in pending list');
  assert.equal(e0999Pending.status, 'pending');
  assert.ok(e0999Pending.localDoc && e0999Pending.remoteDoc, 'both localDoc and remoteDoc should be captured');
});

test('detectConflicts is idempotent: re-running does not create duplicate pending records', async () => {
  // Use a fresh doc ID — E0999 already has a conflict logged from the
  // previous test. Idempotency is about NOT creating duplicates when
  // the same conflict is detected multiple times.
  await forceEquipmentConflict('E1000', 'Epson Projector X500', 'Epson Projector X400');
  // The de-dup logic in logConflict should keep pending count stable
  await db.detectConflicts();
  await db.detectConflicts();
  await db.detectConflicts();

  const pending = await db.getPendingConflicts();
  const e1000Pending = pending.filter(c => c.documentID === 'E1000' && c.table === 'equipment');
  assert.equal(e1000Pending.length, 1, 'only one pending conflict for E1000 even after 3 detect passes');
});

test('cleanup', async (t) => {
  await new Promise((resolve) => cleanup(resolve));
});
