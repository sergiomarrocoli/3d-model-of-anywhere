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

const STAGES = { waiting: 'waiting its turn', starting: 'starting', terrain: 'fetching terrain', buildings: 'fetching buildings', imagery: 'fetching imagery', registering: 'fitting the photo to the map',
  cars: 'removing parked cars', 'land cover': 'working out land cover', bundle: 'writing the bundle', done: 'done', failed: 'failed' };
export const LOG_LINES_SHOWN = 6, QUIET_AFTER_S = 15;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Text for a job update. Pure, so it can be tested. */
export function describeJob(job) {
  if (job.status === 'queued') return job.queue_position ? `Waiting in the queue (${job.queue_position} ahead)…` : 'Starting…';
  if (job.status === 'ready') return 'Ready';
  if (job.status === 'error') return job.error ?? 'The build failed';
  return `Building: ${STAGES[job.stage] ?? job.stage}…`;
}

/** The latest thing the build said it is doing, without its time ("Downloading SO1292_DTM_1m.tif: 12 MB of 35 MB (34%)"), or ''. */
export function activityOf(job) {
  const last = [...(job?.log ?? [])].reverse().find((l) => String(l).trim());
  return last ? String(last).replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').trim() : '';
}

/** 65000 -> '1:05', 3725000 -> '1:02:05'. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/** "Running for 1:05 · last update 3 s ago", and a hint when it has been quiet a while (some steps, like fitting the photo, say nothing until they finish). */
export function timingText(elapsedMs, sinceNewsMs) {
  const quiet = Math.floor(sinceNewsMs / 1000);
  return `Running for ${formatElapsed(elapsedMs)} · last update ${quiet < 2 ? 'just now' : `${quiet} s ago`}${quiet >= QUIET_AFTER_S ? ' (this step takes a while without news, it is still working)' : ''}`;
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
      root.innerHTML = `<h2>Building your area</h2><div class="build-bar working" data-track><div data-bar></div></div><div data-msg class="build-msg">Starting…</div>
        <div data-now class="build-now"></div><div data-time class="build-time"></div><pre data-log class="build-log"></pre>`;
      const $ = (s) => root.querySelector(s), bar = $('[data-bar]'), msg = $('[data-msg]'), now = $('[data-now]'), time = $('[data-time]'), log = $('[data-log]'), track = $('[data-track]');
      const started = Date.now(); let lastNews = started, lastKey = '';
      const tick = () => { time.textContent = timingText(Date.now() - started, Date.now() - lastNews); };
      tick(); const timer = setInterval(tick, 1000);
      try {
        const out = await buildArea(ctx.bbox, { onProgress: (job) => {
          bar.style.width = `${job.percent ?? 0}%`; msg.textContent = describeJob(job);
          const key = `${job.percent}|${job.stage}|${(job.log ?? []).length}|${(job.log ?? []).at(-1) ?? ''}`;
          if (key !== lastKey) { lastKey = key; lastNews = Date.now(); }                   // anything new in the log or the bar counts as news
          now.textContent = activityOf(job);
          log.textContent = (job.log ?? []).slice(-LOG_LINES_SHOWN).join('\n');
          track.classList.toggle('working', job.status === 'building' || job.status === 'queued');
          tick();
        }, signal: host.signal });
        clearInterval(timer);
        return { ...ctx, area: out.id, bundleUrl: out.bundleUrl, bbox: out.bbox };
      } catch (e) {
        clearInterval(timer);
        if (e.name === 'AbortError') throw e;
        root.innerHTML = `<h2>The build did not work</h2><div class="build-msg build-error">${esc(e.message)}</div><button data-retry>Try again</button>`;
        await new Promise((resolve) => { root.querySelector('[data-retry]').onclick = resolve; });
      }
    }
  },
};
