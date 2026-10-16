// Builder module, client side: ask the build service for an area and wait for it. Knows nothing about the picker or the
// game: it takes a bounding box in grid metres and gives back a bundle URL.
//   buildArea(bbox, opts)  the plain API (a promise, progress callback)
//   buildStep              the same as a flow step: shows progress, fills ctx.area / ctx.bundleUrl
import './build.css';

export const POLL_MS = 1000;

export class BuildFailed extends Error {}

const jsonOrError = async (res) => {
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new BuildFailed(body?.error ?? `the build service answered ${res.status}`);
  return body;
};

/**
 * Request a build and poll until it is ready.
 * @param {number[]} bbox  [minE, minN, maxE, maxN] in OS grid metres
 * @param {object} [o]
 * @param {(job:object)=>void} [o.onProgress]  called with every job update (status, percent, stage, queue_position...)
 * @param {AbortSignal} [o.signal]             stop waiting (the build itself carries on and is cached)
 * @returns {Promise<{id:string, bundleUrl:string, bbox:number[], cached:boolean}>}
 */
export async function buildArea(bbox, { onProgress = () => {}, signal, fetchImpl = globalThis.fetch, pollMs = POLL_MS, base = '/api' } = {}) {
  let job;
  try {
    job = await jsonOrError(await fetchImpl(`${base}/builds`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bbox }), signal }));
  } catch (e) {
    if (e instanceof BuildFailed || e.name === 'AbortError') throw e;
    throw new BuildFailed('could not reach the build service (is it running?)');
  }
  const cached = job.status === 'ready';
  onProgress(job);
  while (job.status === 'queued' || job.status === 'building') {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, pollMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
    try {
      job = await jsonOrError(await fetchImpl(`${base}/builds/${job.id}`, { signal }));
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e instanceof BuildFailed) throw e;
      continue; // a dropped poll is not a failed build: try again
    }
    onProgress(job);
  }
  if (job.status !== 'ready') throw new BuildFailed(job.error ?? 'the build failed');
  return { id: job.id, bundleUrl: job.bundle, bbox: job.bbox, cached };
}

const STAGES = { waiting: 'waiting its turn', starting: 'starting', terrain: 'fetching terrain', buildings: 'fetching buildings', imagery: 'fetching imagery', done: 'done', failed: 'failed' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Text for a job update. Pure, so it can be tested. */
export function describeJob(job) {
  if (job.status === 'queued') return job.queue_position ? `Waiting in the queue (${job.queue_position} ahead)…` : 'Starting…';
  if (job.status === 'ready') return 'Ready';
  if (job.status === 'error') return job.error ?? 'The build failed';
  return `Building: ${STAGES[job.stage] ?? job.stage}…`;
}

/**
 * Flow step: needs ctx.bbox, adds ctx.area (build id) and ctx.bundleUrl. Renders into host.root: a progress bar, and
 * on failure the reason with Try again.
 */
export const buildStep = {
  name: 'build',
  async run(ctx, host) {
    if (!Array.isArray(ctx.bbox)) throw new BuildFailed('the build step needs ctx.bbox (the picker step sets it)');
    const root = host.root;
    root.className = 'build-card';
    for (;;) {
      root.innerHTML = '<h2>Building your area</h2><div class="build-bar"><div data-bar></div></div><div data-msg class="build-msg">Starting…</div>';
      const bar = root.querySelector('[data-bar]'), msg = root.querySelector('[data-msg]');
      try {
        const out = await buildArea(ctx.bbox, { onProgress: (job) => { bar.style.width = `${job.percent ?? 0}%`; msg.textContent = describeJob(job); }, signal: host.signal });
        return { ...ctx, area: out.id, bundleUrl: out.bundleUrl, bbox: out.bbox };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        root.innerHTML = `<h2>The build did not work</h2><div class="build-msg build-error">${esc(e.message)}</div><button data-retry>Try again</button>`;
        await new Promise((resolve) => { root.querySelector('[data-retry]').onclick = resolve; });
      }
    }
  },
};
