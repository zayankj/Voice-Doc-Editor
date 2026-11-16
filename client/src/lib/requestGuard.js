// Requests to the AI (typed instructions, voice commands, files): time limit, cancelling, and the progress text.
//
//   - REQUEST_TIMEOUT_MS: the browser stops waiting after this long (the gateway gives up at 100 s and the AI
//     service at 90 s, so normally their own message arrives first)
//   - a request that timed out or was cancelled can NEVER change the document: its answer is not read any more
//   - a request whose document was closed / switched while it was waiting is ignored (its block ids belong to
//     the other document)
// Nothing here logs or stores content.

export const REQUEST_TIMEOUT_MS = 105000;

export const TIMEOUT_MESSAGE = 'Request timed out. Your document has not been changed. Please try again.';
export const NETWORK_MESSAGE = 'Unable to reach the server. Your document has not been changed. Please check the connection and try again.';
export const NOT_CHANGED = 'Your document has not been changed.';

// An error of the request itself: kind = 'timeout' | 'cancelled' | 'network'
export class RequestError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'RequestError';
    this.kind = kind;
  }
}
export const isTimeout = (e) => e?.kind === 'timeout';
export const isCancelled = (e) => e?.kind === 'cancelled';

// What the person sees while waiting. Only true statements: the browser cannot see which model the server uses,
// so a long wait says that the AI MAY be trying another model.
const LATER = [
  { afterMs: 20000, text: 'Taking longer than expected… The AI may be trying an alternative model.' },
  { afterMs: 60000, text: 'Still working… It stops automatically after about 1½ minutes. Your document has not been changed yet.' },
];
export function progressSteps(kind = 'typed') {
  const first = {
    typed: 'Sending your instruction…',
    voice: 'Sending your voice command…',
    file: 'Sending your file…',
  }[kind] || 'Sending your instruction…';
  const second = kind === 'file' ? 'AI is reading your file…' : 'AI is processing your request…';
  return [{ afterMs: 0, text: first }, { afterMs: 1500, text: second }, ...LATER];
}

// Shows the progress texts one after another; returns stop(), which clears the text and every timer.
// (the default timers call setTimeout / clearTimeout plainly: browsers refuse them when called as an object's method)
export function startProgress(kind, show, timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }) {
  const ids = progressSteps(kind).map((s) => (s.afterMs ? timers.set(() => show(s.text), s.afterMs) : (show(s.text), null)));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    ids.forEach((id) => id != null && timers.clear(id));
    show('');
  };
}

// Keeps track of the requests that are waiting for an answer.
//   start(docKey) -> ticket { signal, isStale(docKeyNow), done() }
//   cancelAll()   -> every waiting request is cancelled (e.g. another document is opened)
export function createRequestTracker() {
  const active = new Set();
  return {
    start(docKey) {
      const ctl = new AbortController();
      const ticket = {
        signal: ctl.signal,
        docKey,
        cancel: () => ctl.abort(),
        // the answer must not be used: cancelled, or the document it was made for is no longer open
        isStale: (docKeyNow) => ctl.signal.aborted || docKeyNow !== docKey,
        done: () => active.delete(ticket),
      };
      active.add(ticket);
      return ticket;
    },
    cancelAll() {
      for (const t of active) t.cancel();
      active.clear();
    },
    get waiting() { return active.size; },
  };
}

// Waits for the request with a time limit and an optional cancel signal. run(signal) does the fetch with that
// signal and reads the answer. A time-out or cancel ends the wait AT ONCE and throws a RequestError; a late
// answer is never returned.
export async function withTimeout(run, { signal = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  let why = null;
  // ready BEFORE anything can stop the wait (also when the signal is already aborted)
  const stopped = new Promise((_, reject) => ctl.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
  stopped.catch(() => {});
  const stop = (reason) => { if (!why) { why = reason; ctl.abort(); } };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onCancel = () => stop('cancelled');
  if (signal) {
    if (signal.aborted) stop('cancelled');
    else signal.addEventListener('abort', onCancel, { once: true });
  }
  try {
    const work = run(ctl.signal);
    Promise.resolve(work).catch(() => {}); // a late failure after a stop is ignored
    const result = await Promise.race([work, stopped]);
    if (why) throw new Error('stopped');
    return result;
  } catch (e) {
    if (why === 'timeout') throw new RequestError('timeout', TIMEOUT_MESSAGE);
    if (why === 'cancelled') throw new RequestError('cancelled', 'Cancelled. Your document has not been changed.');
    if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) throw new RequestError('network', NETWORK_MESSAGE); // could not connect
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onCancel);
  }
}
