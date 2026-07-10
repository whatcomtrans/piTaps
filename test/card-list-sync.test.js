'use strict';

// Unit tests for the card-list sync client (run with: npm test / node --test).
// Network is stubbed via the fetchJsonFn constructor hook; persistence goes to
// a per-test temp directory.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listChecksum, CardListSyncClient, CardValidationCache } = require('../index.js');

const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cardsync-test-'));
}

// Builds a client whose fetches are served from `routes`: a map of URL path
// (after the base URL) → response object or function returning one.
// Returns the client, its validation cache, and the list of paths fetched.
function makeClient(routes, dir = tmpDir()) {
  const calls = [];
  const cache = new CardValidationCache();
  const client = new CardListSyncClient({
    baseUrl: 'https://api.example.test',
    apiKey: 'test-key',
    persistDir: dir,
    intervalMs: 60_000,
    cache,
    fetchJsonFn: async (url) => {
      const apiPath = url.replace('https://api.example.test', '');
      calls.push(apiPath);
      const handler = routes[apiPath];
      if (!handler) throw new Error(`no stub route for ${apiPath}`);
      return typeof handler === 'function' ? handler() : handler;
    },
  });
  return { client, cache, calls, dir };
}

function fullList(type, token, cards) {
  return {
    list_type: type,
    token,
    checksum: cards.length ? listChecksum(cards) : null,
    card_count: cards.length,
    cards,
  };
}

// --- listChecksum --------------------------------------------------------------

test('listChecksum: empty set matches the reference empty-set digest', () => {
  assert.strictEqual(listChecksum([]), EMPTY_SHA);
  assert.strictEqual(listChecksum(['', '   ']), EMPTY_SHA); // empties dropped
});

test('listChecksum: trims, uppercases, de-duplicates, sorts, joins with LF', () => {
  // Canonical form of these inputs is "04A1B2\n04FFEE" (sorted, no trailing LF)
  const cards = [' 04ffee ', '04a1b2', '04A1B2', ''];
  assert.strictEqual(listChecksum(cards), sha256('04A1B2\n04FFEE'));
  // Order of input never matters
  assert.strictEqual(listChecksum(['B', 'A']), listChecksum(['A', 'B']));
});

// --- Full pull -------------------------------------------------------------------

test('full pull: verifies checksum, commits to cache, persists atomically', async () => {
  const { client, cache, dir } = makeClient({
    '/lists/student': fullList('student', 42, ['04AAAA', '04BBBB']),
  });

  assert.strictEqual(await client._syncType('student'), true);
  assert.strictEqual(cache.checkCard('04AAAA'), 'student');
  assert.strictEqual(cache.checkCard('04ZZZZ'), false);

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'card_list_student.json'), 'utf8'));
  assert.strictEqual(persisted.token, 42);
  assert.strictEqual(persisted.checksum, listChecksum(['04AAAA', '04BBBB']));
  assert.deepStrictEqual(persisted.cards, ['04AAAA', '04BBBB']);
});

test('full pull: never-uploaded list (checksum null) stays in pass-through mode', async () => {
  const { client, cache } = makeClient({
    '/lists/youth': fullList('youth', 0, []),
  });

  assert.strictEqual(await client._syncType('youth'), true);
  // No authoritative list yet → validation not configured → null (pass-through)
  assert.strictEqual(cache.checkCard('04AAAA'), null);
});

test('full pull: checksum mismatch is rejected and prior state kept', async () => {
  const { client, cache } = makeClient({
    '/lists/student': { list_type: 'student', token: 7, checksum: 'f'.repeat(64), cards: ['04AAAA'] },
  });

  assert.strictEqual(await client._syncType('student'), false);
  assert.strictEqual(client._state.get('student'), undefined);
  assert.strictEqual(cache.checkCard('04AAAA'), null);
});

// --- Deltas ----------------------------------------------------------------------

test('delta: applies puts and deletes, including put of an already-present card (net effect)', async () => {
  const finalCards = ['04BBBB', '04CCCC'];
  const { client, cache, calls } = makeClient({
    '/lists/student': fullList('student', 1, ['04AAAA', '04BBBB']),
    '/lists/student/changes?since=1': {
      list_type: 'student',
      status: 'delta',
      token: 2,
      checksum: listChecksum(finalCards),
      // 04BBBB was deleted-then-re-added upstream → collapses to a put of a
      // card the Pi already has; applying it must be a no-op.
      puts: ['04BBBB', '04CCCC'],
      deletes: ['04AAAA'],
    },
  });

  await client._syncType('student'); // seed via full pull
  assert.strictEqual(await client._syncType('student'), true);

  assert.strictEqual(cache.checkCard('04AAAA'), false);
  assert.strictEqual(cache.checkCard('04BBBB'), 'student');
  assert.strictEqual(cache.checkCard('04CCCC'), 'student');
  assert.strictEqual(client._state.get('student').token, 2);
  // Exactly one full pull — the delta did not re-download the list
  assert.deepStrictEqual(calls.filter((c) => c === '/lists/student').length, 1);
});

test('delta: current response leaves token unchanged and fetches nothing else', async () => {
  const { client, calls } = makeClient({
    '/lists/staff': fullList('staff', 10, ['04AAAA']),
    '/lists/staff/changes?since=10': {
      list_type: 'staff', status: 'current', token: 10, checksum: listChecksum(['04AAAA']),
    },
  });

  await client._syncType('staff');
  assert.strictEqual(await client._syncType('staff'), true);
  assert.strictEqual(client._state.get('staff').token, 10);
  assert.strictEqual(calls.filter((c) => c === '/lists/staff').length, 1);
});

test('delta: checksum mismatch after applying falls back to a full pull', async () => {
  const { client, cache, calls } = makeClient({
    '/lists/student': (() => {
      let pulls = 0;
      return () => (++pulls === 1
        ? fullList('student', 1, ['04AAAA'])
        : fullList('student', 5, ['04DDDD']));
    })(),
    '/lists/student/changes?since=1': {
      list_type: 'student',
      status: 'delta',
      token: 5,
      checksum: 'f'.repeat(64), // will not match the applied result
      puts: ['04CCCC'],
      deletes: [],
    },
  });

  await client._syncType('student');
  assert.strictEqual(await client._syncType('student'), true);

  // Recovered via full pull: server truth wins, half-applied delta discarded
  assert.strictEqual(calls.filter((c) => c === '/lists/student').length, 2);
  assert.strictEqual(cache.checkCard('04DDDD'), 'student');
  assert.strictEqual(cache.checkCard('04CCCC'), false);
  assert.strictEqual(client._state.get('student').token, 5);
});

test('delta: resync response triggers a full pull', async () => {
  const { client, cache, calls } = makeClient({
    '/lists/youth': (() => {
      let pulls = 0;
      return () => (++pulls === 1
        ? fullList('youth', 100, ['04AAAA'])
        : fullList('youth', 205, ['04AAAA', '04EEEE']));
    })(),
    '/lists/youth/changes?since=100': {
      list_type: 'youth', status: 'resync', token: 205, checksum: listChecksum(['04AAAA', '04EEEE']),
    },
  });

  await client._syncType('youth');
  assert.strictEqual(await client._syncType('youth'), true);
  assert.strictEqual(calls.filter((c) => c === '/lists/youth').length, 2);
  assert.strictEqual(client._state.get('youth').token, 205);
  assert.strictEqual(cache.checkCard('04EEEE'), 'youth');
});

// --- Failure isolation --------------------------------------------------------------

test('network failure leaves the previous list in effect', async () => {
  let failing = false;
  const { client, cache } = makeClient({
    '/lists/student': fullList('student', 3, ['04AAAA']),
    '/lists/student/changes?since=3': () => {
      if (failing) throw new Error('ECONNREFUSED');
      return { list_type: 'student', status: 'current', token: 3, checksum: listChecksum(['04AAAA']) };
    },
  });

  await client._syncType('student');
  failing = true;
  await assert.rejects(() => client._syncType('student'), /ECONNREFUSED/);
  // Tap checking still works off the last verified list
  assert.strictEqual(cache.checkCard('04AAAA'), 'student');
  assert.strictEqual(client._state.get('student').token, 3);
});

// --- Persistence across restarts ------------------------------------------------------

test('restart: persisted state is recovered without a network fetch', async () => {
  const dir = tmpDir();
  const first = makeClient({ '/lists/student': fullList('student', 42, ['04AAAA']) }, dir);
  await first.client._syncType('student');

  // New process: no routes at all — loadPersisted must not hit the network
  const second = makeClient({}, dir);
  second.client.loadPersisted();
  assert.strictEqual(second.cache.checkCard('04AAAA'), 'student');
  assert.strictEqual(second.client._state.get('student').token, 42);
  assert.deepStrictEqual(second.calls, []);
});

test('restart: persisted state failing its checksum is ignored (forces full pull)', async () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'card_list_student.json'),
    JSON.stringify({ list_type: 'student', token: 9, checksum: 'f'.repeat(64), cards: ['04AAAA'] })
  );

  const { client, cache } = makeClient({}, dir);
  client.loadPersisted();
  assert.strictEqual(client._state.get('student'), undefined);
  assert.strictEqual(cache.checkCard('04AAAA'), null); // pass-through, not a stale accept
});
