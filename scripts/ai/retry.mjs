const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialises model requests so a bulk import cannot burst past the provider's quota.
// Azure starts around 6 requests/min, where the previous unbounded fan-out mostly 429ed.
export function createLimiter(concurrency) {
  const limit = Math.max(1, Number(concurrency) || 1);
  const queue = [];
  let active = 0;

  function next() {
    if (active >= limit) return;
    const entry = queue.shift();
    if (!entry) return;
    active += 1;
    // Promise.resolve().then keeps a synchronously-throwing task from escaping here and
    // permanently leaking the slot.
    Promise.resolve().then(entry.task).then(entry.resolve, entry.reject).finally(() => {
      active -= 1;
      next();
    });
  }

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  };
}

// Retry-After is either delta-seconds or an HTTP date.
function retryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

export async function fetchWithRetry(url, init, options = {}) {
  const { attempts = 4, limiter, baseDelayMs = 1000, maxBackoffMs = MAX_BACKOFF_MS, onRetry } = options;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = limiter ? await limiter(() => fetch(url, init)) : await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), maxBackoffMs));
      continue;
    }
    if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) return response;
    // Clamp Retry-After too: a quota-exhausted Azure deployment can return a very large
    // value, and the analyze call blocks an in-flight browser request.
    const delay = Math.min(retryAfterMs(response) ?? baseDelayMs * 2 ** (attempt - 1), maxBackoffMs);
    onRetry?.({ attempt, status: response.status, delay });
    await sleep(delay);
  }
  throw lastError;
}
