// The model chain: tries the configured Gemini models in order until one answers, within time and request limits.
// (Moved here from index.js so it can be tested without the network; index.js calls it exactly as before.)
//
//   - first chunk: a streaming try that sends NOTHING within FIRST_TOKEN_MS is given up (the model is hanging)
//   - per try:     a try may take at most PER_TRY_MS in total
//   - budget:      the whole request (including the Live attempt for voice) stops at its deadline
//   - a second try of the SAME model only after a server error or a broken stream (never after a time-out,
//     a quota error or a configuration error); a short pause first
//   - 429:         that model is paused (its quota is used up) and the next model is tried
//   - 404:         the model does not exist for this API: it is not tried again until the server restarts
//   - 400 "thinking level not supported": tried again at once without that setting, and remembered
//   - any other 400 / 401 / 403: a real error of the request or the setup, never retried
//   - cancel:      when the browser / gateway gives up (signal), no further model is tried
// Logs only model names, times and fixed reasons - never content.

export const FIRST_TOKEN_MS = 40000; // some valid answers took ~38 s to the first chunk
export const PER_TRY_MS = 45000; // the longest valid answer seen took ~38.6 s in total
export const TOTAL_BUDGET_MS = 90000; // the gateway waits 100 s, the browser 105 s
export const MAX_CALLS = 6; // most requests sent to Google for ONE command
export const RETRY_PAUSE_MS = 1000;
const MIN_TRY_MS = 5000; // less time than this left: do not start another try

export const isTimeout = (e) =>
  e?.name === 'AbortError' ||
  e?.name === 'TimeoutError' ||
  e?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
  /timeout|timed out|aborted/i.test(String(e?.message));

// Busy, server errors, timeouts, and connections that break halfway are all worth retrying
export const isRetryable = (e) =>
  [429, 500, 502, 503, 504].includes(e?.status) ||
  isTimeout(e) ||
  /fetch failed|Incomplete JSON|ECONNRESET|socket|terminated|Empty answer/i.test(String(e?.message));

// The request was cancelled by the client (browser closed, gateway gave up): stop, answer nothing
export class CancelledError extends Error {
  constructor() { super('Cancelled by the client'); this.name = 'CancelledError'; this.cancelled = true; }
}
// The whole time budget is used up
const budgetError = () => Object.assign(new Error('Timed out'), { name: 'TimeoutError', budget: true });

// Reads the details of a 429 error. Google's message can contain JSON inside JSON,
// so this searches the plain text instead of parsing it.
export function quotaInfo(e) {
  const raw = String(e?.message || '');
  const retry = raw.match(/retryDelay[^\d]{0,16}(\d+(?:\.\d+)?)s/i);
  const retrySeconds = retry ? parseFloat(retry[1]) : null;
  return {
    retrySeconds,
    daily: /PerDay|per day/i.test(raw) || (retrySeconds ?? 0) > 3600,
    free: /free[_ ]?tier/i.test(raw),
  };
}

// How long to leave a model alone after it answered 429
export function pauseMs(q) {
  if (q.retrySeconds) return Math.min(q.retrySeconds, 86400) * 1000 + 1000;
  return (q.daily ? 3600 : 60) * 1000; // no details from Google: 1 hour if daily, otherwise 1 minute
}

const isThinkingError = (e) => e?.status === 400 && /thinking/i.test(String(e?.message));

// models: names in order. ai: the @google/genai client (or a test double with models.generateContent(Stream)).
// log / warn: (text) => void, for model names, times and fixed reasons only.
export function createModelChain({
  models, ai, useVertex = false,
  firstTokenMs = FIRST_TOKEN_MS, perTryMs = PER_TRY_MS, totalBudgetMs = TOTAL_BUDGET_MS, maxCalls = MAX_CALLS,
  retryPauseMs = RETRY_PAUSE_MS, minTryMs = MIN_TRY_MS,
  log = console.log, warn = console.warn,
}) {
  const pausedUntil = new Map(); // model -> time (ms) before which it is not asked again (quota used up)
  const noThinking = new Set(); // models that rejected the "low thinking" setting
  const disabled = new Set(); // models that do not exist for this API (404): skipped until the server restarts
  let sawFreeTier = false;

  const isPaused = (model) => (pausedUntil.get(model) || 0) > Date.now();
  const usable = () => models.filter((m) => !disabled.has(m));
  const allPaused = () => usable().length > 0 && usable().every(isPaused);

  // Text for the page, based on when the first used-up model is available again
  function quotaMessage() {
    const times = models.map((m) => pausedUntil.get(m) || 0).filter((t) => t > Date.now());
    const soonest = times.length ? Math.min(...times) : Date.now() + 30000;
    const waitMs = Math.max(0, soonest - Date.now());
    const hint = [
      sawFreeTier ? 'This API key is on the free tier, which allows only a small number of requests per day.' : '',
      !useVertex ? 'The company Vertex AI project (Mumbai) avoids this limit.' : '',
    ].filter(Boolean).join(' ');
    if (waitMs > 30 * 60 * 1000) {
      const hours = Math.round(waitMs / 3600000);
      const clock = new Date(soonest).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      return `The request limit is used up for the configured models. It resets in about ${hours} hours (around ${clock} India time). ${hint}`.trim();
    }
    const secs = Math.max(15, Math.ceil(waitMs / 1000));
    return `Rate limit reached. Try again in about ${secs} seconds. ${hint}`.trim();
  }

  // ONE request to ONE model. Ends with the answer text, or throws. Every timer is cleared and the request to
  // Google is aborted when the try ends early (time-out, cancel), so no answer can arrive for it later.
  async function tryOnce(model, request, { timeoutMs, stream, signal, thinking }) {
    const ctl = new AbortController();
    let why = null; // 'first' | 'total' | 'cancel'
    // the try ends at once when it is stopped, also if the library keeps waiting for a chunk
    // (ready BEFORE anything can stop it)
    const stopped = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    stopped.catch(() => {});
    const stop = (reason) => { if (!why) { why = reason; ctl.abort(); } };
    const total = setTimeout(() => stop('total'), timeoutMs);
    const first = stream ? setTimeout(() => stop('first'), Math.min(firstTokenMs, timeoutMs)) : null;
    const onCancel = () => stop('cancel');
    if (signal?.aborted) stop('cancel');
    else if (signal) signal.addEventListener('abort', onCancel, { once: true });

    const config = { ...request.config, abortSignal: ctl.signal };
    if (thinking) config.thinkingConfig = { thinkingLevel: 'LOW' }; // less thinking = faster
    try {
      let text = '';
      const work = (async () => {
        if (stream) {
          const s = await ai.models.generateContentStream({ ...request, model, config });
          for await (const chunk of s) {
            if (first) clearTimeout(first);
            if (why) break;
            text += chunk.text || '';
          }
        } else {
          const r = await ai.models.generateContent({ ...request, model, config });
          text = r.text || '';
        }
      })();
      work.catch(() => {}); // a late failure after a stop must never crash the server
      await Promise.race([work, stopped]);
      if (why) throw new Error('stopped');
      if (!text.trim()) throw Object.assign(new Error('Empty answer from model'), { status: 503 });
      return text;
    } catch (e) {
      if (why === 'cancel') throw new CancelledError();
      if (why === 'first') throw Object.assign(new Error('No first chunk in time'), { name: 'TimeoutError', first: true });
      if (why === 'total') throw Object.assign(new Error('Try timed out'), { name: 'TimeoutError' });
      throw e;
    } finally {
      clearTimeout(total);
      if (first) clearTimeout(first);
      if (signal) signal.removeEventListener('abort', onCancel);
    }
  }

  // Tries each model in order. Returns the answer text.
  //   deadline: when the whole request must stop (default: now + the total budget)
  //   signal:   aborted when the client has gone (nothing is sent to Google after that)
  async function generate(request, { deadline = Date.now() + totalBudgetMs, signal } = {}) {
    let lastErr;
    let quotaSeen = false;
    let calls = 0;
    const finalError = () => {
      // no model could be asked at all (every one missing for this API): a configuration error
      if (!lastErr && !calls && !quotaSeen) return Object.assign(new Error('No usable model'), { status: 404 });
      if (quotaSeen && !lastErr?.budget) return Object.assign(new Error('Quota or rate limit reached'), { status: 429 });
      return lastErr || budgetError();
    };
    const sleep = (ms) => new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });

    for (const model of models) {
      if (disabled.has(model)) continue;
      if (isPaused(model)) { quotaSeen = true; continue; }
      for (let attempt = 1; attempt <= 2; attempt++) {
        if (signal?.aborted) throw new CancelledError();
        const remaining = deadline - Date.now();
        if (remaining < minTryMs) { lastErr = budgetError(); throw finalError(); }
        if (calls >= maxCalls) throw finalError();
        calls++;
        // decided for THIS try: a reply about the setting belongs to the request that actually sent it
        const thinking = !noThinking.has(model);
        const tryFrom = Date.now();
        try {
          const text = await tryOnce(model, request, { timeoutMs: Math.min(perTryMs, remaining), stream: attempt === 1, signal, thinking });
          log(`AI: answered by ${model} in ${Date.now() - tryFrom} ms`);
          return text;
        } catch (e) {
          if (e?.cancelled) throw e;
          lastErr = e;
          if (isThinkingError(e) && thinking) {
            // also safe when several requests hit this at the same time: each one sent the setting itself
            if (!noThinking.has(model)) warn(`${model}: thinking setting not accepted, retrying without it`);
            noThinking.add(model);
            attempt--; // the same try again, without the setting
            continue;
          }
          if (e?.status === 404) {
            disabled.add(model);
            warn(`${model} not found -> not used again until the server restarts; next model`);
            break;
          }
          if (e?.status === 429) {
            const q = quotaInfo(e);
            sawFreeTier = sawFreeTier || q.free;
            pausedUntil.set(model, Date.now() + pauseMs(q));
            quotaSeen = true;
            warn(`${model}: ${q.daily ? 'daily' : 'per-minute'} limit reached${q.free ? ' (free tier)' : ''} -> paused for about ${Math.round(pauseMs(q) / 60000)} min, trying next model`);
            break;
          }
          if (isTimeout(e)) {
            warn(`${model} was too slow (${e.first ? 'no first answer' : 'no full answer'} in time) -> next model`);
            break;
          }
          if (!isRetryable(e)) throw e; // a real error of the request or the setup: never retried
          warn(`${model} failed (${e?.status || String(e?.message).slice(0, 50)}) - attempt ${attempt}/2`);
          if (attempt < 2) await sleep(retryPauseMs);
        }
      }
    }
    throw finalError();
  }

  return { generate, allPaused, quotaMessage, isPaused, state: { pausedUntil, noThinking, disabled } };
}

// An AbortSignal that is aborted ONLY when the client really went away before the answer was sent.
// (req 'close' also fires after a normal request body has been read, so it is NOT used. res 'close' fires when the
// connection closes; writableFinished tells a finished answer apart from a client that disconnected.)
export function clientGoneSignal(req, res) {
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ctl.abort();
  });
  return ctl.signal;
}
