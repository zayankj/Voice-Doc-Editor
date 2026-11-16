// The model chain (server/modelChain.js): fallback order, time limits, retries, quota pauses, configuration errors,
// cancelling, and the client-disconnect signal. A FAKE Google client is used (no network, no keys); the time limits
// are scaled down so the tests run fast. Real Gemini timing is NOT measured here.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createModelChain, clientGoneSignal, CancelledError } from '../modelChain.js';

const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(abortError());
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
});

// plan: model -> list of behaviours, one per call to that model (the last one repeats)
//   { text, firstMs }          answers after firstMs        { hang: true }      never answers
//   { status, message }        fails with that HTTP status   { slowMs, text }    first chunk at once, the rest after slowMs
//   { noThinking: true, text } refuses the thinking setting with a 400, answers without it
//   { broken: true }           the stream breaks halfway     { empty: true }     an empty answer
function fakeAi(plan) {
  const calls = [];
  const behaviourFor = (model) => {
    const list = plan[model] || [{ status: 500 }];
    const n = calls.filter((c) => c.model === model).length;
    return list[Math.min(n, list.length - 1)];
  };
  async function* stream(b, signal) {
    if (b.hang) await wait(1e9, signal);
    if (b.status) { await wait(b.delayMs || 1, signal); throw Object.assign(new Error(b.message || `HTTP ${b.status}`), { status: b.status }); }
    await wait(b.firstMs || 1, signal);
    if (b.empty) return;
    if (b.broken) { yield { text: '{"edits":' }; throw new Error('terminated'); }
    if (b.slowMs) { yield { text: '{"edits":[],' }; await wait(b.slowMs, signal); yield { text: '"summary":"late"}' }; return; }
    yield { text: b.text ?? '{"edits":[],"summary":"ok"}' };
  }
  function run({ model, config }, isStream) {
    let b = behaviourFor(model);
    const call = { model, stream: isStream, thinking: Boolean(config.thinkingConfig), signal: config.abortSignal };
    calls.push(call);
    if (b.noThinking) b = config.thinkingConfig ? { status: 400, message: '{"error":{"code":400,"message":"Thinking level is not supported for this model."}}' } : { text: b.text };
    return { b, signal: config.abortSignal };
  }
  const ai = {
    models: {
      generateContentStream: async (req) => { const { b, signal } = run(req, true); return stream(b, signal); },
      generateContent: async (req) => {
        const { b, signal } = run(req, false);
        let text = '';
        for await (const c of stream(b, signal)) text += c.text;
        return { text };
      },
    },
  };
  return { ai, calls };
}

const FAST = { firstTokenMs: 80, perTryMs: 150, totalBudgetMs: 600, retryPauseMs: 10, minTryMs: 20, log: () => {}, warn: () => {} };
const chainOf = (models, plan, opts = {}) => { const f = fakeAi(plan); return { ...f, chain: createModelChain({ models, ai: f.ai, ...FAST, ...opts }) }; };
const REQ = { contents: [], config: { temperature: 0 } };

test('1. the primary model answers: one streaming request, its answer is returned', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ text: 'from A' }] });
  assert.equal(await chain.generate(REQ), 'from A');
  assert.deepEqual(calls.map((c) => [c.model, c.stream, c.thinking]), [['A', true, true]]);
});

test('2. primary sends nothing before the first-chunk limit -> given up (its request aborted), the next model answers', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ hang: true }], B: [{ text: 'from B' }] });
  const t0 = Date.now();
  assert.equal(await chain.generate(REQ), 'from B');
  const ms = Date.now() - t0;
  assert.ok(ms >= 75 && ms < 300, `waited ${ms} ms (first-chunk limit 80 ms)`);
  assert.deepEqual(calls.map((c) => c.model), ['A', 'B'], 'a timed-out model is NOT tried a second time');
  assert.equal(calls[0].signal.aborted, true, 'the request to the slow model is cancelled, so it cannot answer later');
});

test('2b. a valid answer whose first chunk comes before the limit is NOT cancelled', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ text: 'slow but valid', firstMs: 60 }] });
  assert.equal(await chain.generate(REQ), 'slow but valid');
  assert.equal(calls.length, 1);
});

test('2c. first chunk in time but the whole answer too slow -> per-try limit, next model', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ slowMs: 1000 }], B: [{ text: 'from B' }] });
  const t0 = Date.now();
  assert.equal(await chain.generate(REQ), 'from B');
  assert.ok(Date.now() - t0 < 350, 'stopped at the 150 ms per-try limit');
  assert.deepEqual(calls.map((c) => c.model), ['A', 'B']);
});

test('3. primary 503 -> one more try of it (not streaming, after a short pause), then the fallback answers', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ status: 503 }], B: [{ text: 'from B' }] });
  assert.equal(await chain.generate(REQ), 'from B');
  assert.deepEqual(calls.map((c) => [c.model, c.stream]), [['A', true], ['A', false], ['B', true]]);
});

test('3b. primary 503 then fine on its second try: no fallback needed', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ status: 503 }, { text: 'second try' }] });
  assert.equal(await chain.generate(REQ), 'second try');
  assert.deepEqual(calls.map((c) => c.model), ['A', 'A']);
});

test('3c. a stream that breaks halfway and an empty answer are retried like a server error', async () => {
  let { chain, calls } = chainOf(['A', 'B'], { A: [{ broken: true }, { text: 'ok now' }] });
  assert.equal(await chain.generate(REQ), 'ok now');
  assert.equal(calls.length, 2);
  ({ chain, calls } = chainOf(['A', 'B'], { A: [{ empty: true }], B: [{ text: 'from B' }] }));
  assert.equal(await chain.generate(REQ), 'from B');
  assert.deepEqual(calls.map((c) => c.model), ['A', 'A', 'B']);
});

test('4. 429: that model is paused (not asked again by later requests); all paused -> quota error at once', async () => {
  const { chain, calls } = chainOf(['A', 'B'], {
    A: [{ status: 429, message: 'RESOURCE_EXHAUSTED free_tier retryDelay": "30s"' }],
    B: [{ text: 'from B' }, { status: 429, message: 'quota' }],
  });
  assert.equal(await chain.generate(REQ), 'from B');
  assert.equal(chain.isPaused('A'), true);
  await assert.rejects(chain.generate(REQ), (e) => e.status === 429);
  assert.deepEqual(calls.map((c) => c.model), ['A', 'B', 'B'], 'paused A is skipped by the second request');
  assert.equal(chain.allPaused(), true);
  assert.match(chain.quotaMessage(), /Rate limit reached|request limit/);
});

test('5. 404 (model not available for this API): skipped for good, never asked again; only 404s -> configuration error', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ status: 404 }], B: [{ text: 'from B' }] });
  assert.equal(await chain.generate(REQ), 'from B');
  assert.equal(await chain.generate(REQ), 'from B');
  assert.deepEqual(calls.map((c) => c.model), ['A', 'B', 'B'], 'the missing model is asked once only');
  const only = chainOf(['A'], { A: [{ status: 404 }] });
  await assert.rejects(only.chain.generate(REQ), (e) => e.status === 404);
  await assert.rejects(only.chain.generate(REQ), (e) => e.status === 404, 'still a clear configuration error later');
  assert.equal(only.calls.length, 1);
});

test('5b. any other 400 (a real error of the request or setup) is never retried and no other model is asked', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ status: 400, message: 'Invalid argument' }], B: [{ text: 'from B' }] });
  await assert.rejects(chain.generate(REQ), (e) => e.status === 400);
  assert.deepEqual(calls.map((c) => c.model), ['A']);
  const auth = chainOf(['A', 'B'], { A: [{ status: 403, message: 'Permission denied' }] });
  await assert.rejects(auth.chain.generate(REQ), (e) => e.status === 403);
  assert.equal(auth.calls.length, 1);
});

test('5c. "thinking level not supported": the same model at once without that setting; later requests never send it', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ noThinking: true, text: 'no thinking' }] });
  assert.equal(await chain.generate(REQ), 'no thinking');
  assert.equal(await chain.generate(REQ), 'no thinking');
  assert.deepEqual(calls.map((c) => [c.model, c.thinking]), [['A', true], ['A', false], ['A', false]]);
});

test('5d. two requests at the same time both hit the thinking error: BOTH are retried and answered (no raw 400)', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ noThinking: true, text: 'answer' }] });
  const [r1, r2] = await Promise.all([chain.generate(REQ), chain.generate(REQ)]);
  assert.equal(r1, 'answer');
  assert.equal(r2, 'answer');
  assert.equal(calls.filter((c) => c.model === 'B').length, 0, 'never pushed to another model by the setting');
  assert.equal(calls.filter((c) => c.thinking).length, 2, 'only the two first requests sent the setting');
});

test('6. every model fails -> an error, and never more than MAX_CALLS requests to Google', async () => {
  const { chain, calls } = chainOf(['A', 'B', 'C', 'D'], { A: [{ status: 503 }], B: [{ status: 500 }], C: [{ status: 502 }], D: [{ status: 503 }] }, { maxCalls: 6 });
  await assert.rejects(chain.generate(REQ), (e) => [500, 502, 503].includes(e.status));
  assert.equal(calls.length, 6);
});

test('7. the total budget: every model hangs -> stops at the budget with a time-out error', async () => {
  const { chain, calls } = chainOf(['A', 'B', 'C', 'D', 'E', 'F'], { A: [{ hang: true }], B: [{ hang: true }], C: [{ hang: true }], D: [{ hang: true }], E: [{ hang: true }], F: [{ hang: true }] }, { totalBudgetMs: 250 });
  const t0 = Date.now();
  await assert.rejects(chain.generate(REQ), (e) => e.name === 'TimeoutError');
  const ms = Date.now() - t0;
  assert.ok(ms < 400, `stopped after ${ms} ms (budget 250 ms)`);
  assert.ok(calls.every((c) => c.signal.aborted), 'every started request was cancelled');
});

test('7b. a deadline given by the caller (time already used by Live) is respected', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ text: 'x' }] });
  await assert.rejects(chain.generate(REQ, { deadline: Date.now() + 10 }), (e) => e.name === 'TimeoutError');
  assert.equal(calls.length, 0, 'not enough time left: no request started');
});

test('8. cancelled by the client while a model is working: that request is aborted and NO other model is asked', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ hang: true }], B: [{ text: 'must not be used' }] });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(chain.generate(REQ, { signal: ctl.signal }), (e) => e instanceof CancelledError && e.cancelled === true);
  assert.deepEqual(calls.map((c) => c.model), ['A']);
  assert.equal(calls[0].signal.aborted, true);
  // already cancelled before starting: nothing is sent at all
  const later = chainOf(['A'], { A: [{ text: 'x' }] });
  await assert.rejects(later.chain.generate(REQ, { signal: AbortSignal.abort() }), (e) => e.cancelled);
  assert.equal(later.calls.length, 0);
});

test('8b. cancelled during the pause before a second try: stops at once', async () => {
  const { chain, calls } = chainOf(['A', 'B'], { A: [{ status: 503 }], B: [{ text: 'x' }] }, { retryPauseMs: 500 });
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 30);
  const t0 = Date.now();
  await assert.rejects(chain.generate(REQ, { signal: ctl.signal }), (e) => e.cancelled);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(calls.length, 1);
});

test('12. fallback never produces two answers: one call returns exactly one text, the slow model\'s late answer is dropped', async () => {
  const { chain } = chainOf(['A', 'B'], { A: [{ text: 'late A', firstMs: 200 }], B: [{ text: 'from B' }] });
  const results = [];
  results.push(await chain.generate(REQ));
  await new Promise((r) => setTimeout(r, 250)); // A would have answered by now
  assert.deepEqual(results, ['from B']);
});

// ---------- clientGoneSignal: only a REAL disconnect counts ----------
function serverWith(handler) {
  return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

test('clientGoneSignal: a normal request with a JSON body that is answered is NOT treated as cancelled', async () => {
  let signal;
  const s = await serverWith((req, res) => {
    signal = clientGoneSignal(req, res);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => setTimeout(() => res.end(JSON.stringify({ ok: body.length })), 30)); // req 'close' has fired by now
  });
  const r = await fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outline: 'x'.repeat(5000) }) });
  assert.equal(r.status, 200);
  await r.text();
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(signal.aborted, false);
  s.close();
});

test('clientGoneSignal: the client disconnects before the answer -> aborted', async () => {
  let signal;
  const gone = new Promise((resolve) => {
    serverWith((req, res) => {
      signal = clientGoneSignal(req, res);
      signal.addEventListener('abort', () => resolve(true));
      req.resume();
      setTimeout(() => { if (!res.destroyed) res.end('late'); }, 1000);
    }).then((s) => {
      const ctl = new AbortController();
      fetch(`http://127.0.0.1:${s.address().port}/`, { method: 'POST', body: '{}', signal: ctl.signal }).catch(() => {});
      setTimeout(() => ctl.abort(), 50);
      setTimeout(() => s.close(), 1200);
    });
  });
  assert.equal(await gone, true);
  assert.equal(signal.aborted, true);
});

test('index.js uses the chain with the request deadline and the disconnect signal; the old 120 s / 240 s limits are gone', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(src, /createModelChain\(\{ models: MODELS, ai, useVertex \}\)/);
  assert.match(src, /\{ deadline, signal: clientGone \}/);
  assert.match(src, /const deadline = requestFrom \+ TOTAL_BUDGET_MS/);
  assert.doesNotMatch(src, /120000|240000/);
  assert.doesNotMatch(src, /req\.on\('close'/, 'req close fires after a normal body read: never used for cancelling');
  const chain = fs.readFileSync(new URL('../modelChain.js', import.meta.url), 'utf8');
  assert.match(chain, /FIRST_TOKEN_MS = 40000/);
  assert.match(chain, /PER_TRY_MS = 45000/);
  assert.match(chain, /TOTAL_BUDGET_MS = 90000/);
});
