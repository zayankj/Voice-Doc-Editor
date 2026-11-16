// Browser request safety (client/src/lib/requestGuard.js + fileExtract.js): the time limit, cancelling, late
// answers, a document closed while waiting, and the progress texts. fetch is a fake (no network); the time limit is
// scaled down. Dummy data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withTimeout, createRequestTracker, startProgress, progressSteps, isTimeout, isCancelled, RequestError,
  REQUEST_TIMEOUT_MS, TIMEOUT_MESSAGE, NOT_CHANGED,
} from '../src/lib/requestGuard.js';
import { extractEdits } from '../src/lib/fileExtract.js';

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
// a fake fetch that answers after ms (and obeys the abort signal like the real one); records every call
function fakeFetch({ ms = 10, status = 200, body = { edits: [], summary: 'ok', heard: '' }, bodyMs = 0, networkError = false } = {}) {
  const calls = [];
  const f = (url, init) => {
    const call = { url, init, finishedLate: false };
    calls.push(call);
    if (networkError) return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        call.finishedLate = init.signal?.aborted || false;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => new Promise((res, rej) => {
            const t2 = setTimeout(() => res(body), bodyMs);
            init.signal?.addEventListener('abort', () => { clearTimeout(t2); rej(abortError()); }, { once: true });
          }),
        });
      }, ms);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
    });
  };
  f.calls = calls;
  return f;
}
const ARGS = { instruction: 'In follow up add: Repeat CBC after 1 week.', outline: '[B0] (P) "FOLLOW UP"', today: '15-11-2026' };

test('the agreed time limits: browser 105 s (gateway 100 s, AI service 90 s)', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 105000);
  assert.match(TIMEOUT_MESSAGE, /timed out/i);
  assert.match(TIMEOUT_MESSAGE, /has not been changed/);
});

test('a normal answer inside the time limit is returned unchanged', async () => {
  globalThis.fetch = fakeFetch({ ms: 20, body: { edits: [{ block_id: 'B0' }], summary: 'Done.', heard: '' } });
  const data = await extractEdits({ ...ARGS, timeoutMs: 500 });
  assert.deepEqual(data.edits, [{ block_id: 'B0' }]);
  assert.equal(globalThis.fetch.calls.length, 1, 'exactly one request per command');
});

test('8. browser time-out: the request is aborted, a time-out error with "not changed" is thrown at the limit', async () => {
  globalThis.fetch = fakeFetch({ ms: 1000 });
  const t0 = Date.now();
  await assert.rejects(extractEdits({ ...ARGS, timeoutMs: 60 }), (e) => isTimeout(e) && e.message === TIMEOUT_MESSAGE);
  assert.ok(Date.now() - t0 < 300);
  assert.equal(globalThis.fetch.calls[0].init.signal.aborted, true, 'the HTTP request itself is cancelled');
});

test('8b. the time limit also covers reading the answer (a stop while the body is still arriving)', async () => {
  globalThis.fetch = fakeFetch({ ms: 10, bodyMs: 1000 });
  await assert.rejects(extractEdits({ ...ARGS, timeoutMs: 60 }), (e) => isTimeout(e));
});

test('9. a late answer after the time-out is never returned (nothing can apply it)', async () => {
  let settled = 0;
  const late = withTimeout(() => new Promise((r) => setTimeout(() => r({ edits: [{ block_id: 'B9' }] }), 120)), { timeoutMs: 40 })
    .then(() => { settled += 1; return 'resolved'; }, (e) => { settled += 1; return e; });
  const outcome = await late;
  await new Promise((r) => setTimeout(r, 150)); // the late answer has arrived by now
  assert.ok(outcome instanceof RequestError && isTimeout(outcome));
  assert.equal(settled, 1, 'settled once, with the time-out; the late answer did not resolve it again');
});

test('8c. cancelled (another document opened): a cancelled error, the HTTP request is aborted', async () => {
  globalThis.fetch = fakeFetch({ ms: 1000 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(extractEdits({ ...ARGS, signal: ctl.signal, timeoutMs: 500 }), (e) => isCancelled(e));
  assert.equal(globalThis.fetch.calls[0].init.signal.aborted, true);
  // already cancelled: rejects at once
  await assert.rejects(withTimeout(() => new Promise(() => {}), { signal: AbortSignal.abort(), timeoutMs: 500 }), (e) => isCancelled(e));
});

test('a server error message is passed through as before; a lost connection gets a clear message', async () => {
  globalThis.fetch = fakeFetch({ status: 503, body: { error: 'The AI did not answer in time. Your document has not been changed. Please try again.' } });
  await assert.rejects(extractEdits({ ...ARGS, timeoutMs: 500 }), (e) => /did not answer in time/.test(e.message) && !(e instanceof RequestError));
  globalThis.fetch = fakeFetch({ networkError: true });
  await assert.rejects(extractEdits({ ...ARGS, timeoutMs: 500 }), (e) => e.kind === 'network' && e.message.includes(NOT_CHANGED));
});

test('other errors inside the request are not hidden as network errors', async () => {
  await assert.rejects(withTimeout(async () => { throw new RangeError('bug'); }, { timeoutMs: 500 }), (e) => e instanceof RangeError);
});

test('request tracker: an answer for a document that was closed / switched is stale; cancelAll cancels every waiting request', () => {
  const tr = createRequestTracker();
  const a = tr.start('summary-1');
  const b = tr.start('summary-1');
  assert.equal(tr.waiting, 2);
  assert.equal(a.isStale('summary-1'), false, 'same document still open: the answer may be used');
  assert.equal(a.isStale('summary-2'), true, 'another document is open now: never applied');
  assert.equal(a.isStale(null), true, 'editor closed: never applied');
  b.done();
  assert.equal(tr.waiting, 1);
  tr.cancelAll();
  assert.equal(a.signal.aborted, true);
  assert.equal(a.isStale('summary-1'), true, 'cancelled: never applied, even in the same document');
  assert.equal(tr.waiting, 0);
  const c = tr.start('summary-1');
  assert.equal(c.isStale('summary-1'), false, 'a new request after cancelAll works normally');
});

test('progress texts: honest steps for typed, voice and files; stop() clears the text and every timer', () => {
  assert.deepEqual(progressSteps('typed').map((s) => s.text.split('…')[0]), ['Sending your instruction', 'AI is processing your request', 'Taking longer than expected', 'Still working']);
  assert.equal(progressSteps('voice')[0].text, 'Sending your voice command…');
  assert.equal(progressSteps('file')[1].text, 'AI is reading your file…');
  assert.ok(progressSteps('typed').every((s) => !/applied|done|success/i.test(s.text)), 'never a success message before the edit');
  // fake timers
  const pending = new Map(); let id = 0;
  const timers = { set: (fn, ms) => { pending.set(++id, { fn, ms }); return id; }, clear: (i) => pending.delete(i) };
  const shown = [];
  const stop = startProgress('typed', (t) => shown.push(t), timers);
  assert.deepEqual(shown, ['Sending your instruction…'], 'the first text at once');
  assert.deepEqual([...pending.values()].map((p) => p.ms), [1500, 20000, 60000]);
  [...pending.values()][0].fn();
  assert.equal(shown.at(-1), 'AI is processing your request…');
  stop();
  assert.equal(shown.at(-1), '', 'cleared when the request ends');
  assert.equal(pending.size, 0, 'no timer left behind');
  stop(); // safe twice
  assert.equal(shown.filter((s) => s === '').length, 1);
});

test('startProgress with the real (default) timers works under the browser rule (setTimeout must not be called as a method)', async () => {
  const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
  // like a browser: "Illegal invocation" when called with another object as "this"
  globalThis.setTimeout = function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realSet(fn, ms); };
  globalThis.clearTimeout = function (id) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realClear(id); };
  try {
    const shown = [];
    const stop = startProgress('voice', (x) => shown.push(x));
    assert.deepEqual(shown, ['Sending your voice command…']);
    stop();
    assert.equal(shown.at(-1), '');
  } finally {
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
  }
});
