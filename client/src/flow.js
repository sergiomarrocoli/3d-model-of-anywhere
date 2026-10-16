// The flow: a list of steps run in order, each handing a context to the next. This is how the modules chain, and why
// another module can be slotted in between without the others knowing.
//
//   step = { name, run(ctx, host) -> Promise<ctx> }
//     ctx   a plain object. Steps read what they need and return { ...ctx, ...theirOutput }, keeping everything else.
//     host  { root: an element to render into (cleared between steps), signal: AbortSignal }
//
// Context fields in use (see modules/README.md):
//   bbox     [minE, minN, maxE, maxN] grid metres         set by pick
//   area     id of a built area                            set by build
//   bundleUrl                                              set by build
//   overlay  anything a game should draw/use on the map    set by e.g. a track drawer, read by a game

export class FlowError extends Error {}

export const DEFAULT_FLOW = ['play'];
export const PICK_FLOW = ['pick', 'build', 'play'];

/** Which steps to run, from the page URL: ?flow=pick,track,build,play  or the shortcut ?pick  or just play. */
export function parseFlow(params, known) {
  const list = params.get('flow') ? params.get('flow').split(',').map((s) => s.trim()).filter(Boolean) : params.has('pick') ? PICK_FLOW : DEFAULT_FLOW;
  const unknown = list.filter((n) => !known.includes(n));
  if (unknown.length) throw new FlowError(`unknown step ${unknown.map((n) => `"${n}"`).join(', ')} (available: ${known.join(', ')})`);
  if (!list.length) throw new FlowError('the flow has no steps');
  return list;
}

/** Run the steps in order. `registry` maps names to steps; `makeHost(name)` gives each step its host. Returns the final ctx. */
export async function runFlow(names, registry, ctx = {}, makeHost = () => ({})) {
  for (const name of names) {
    const step = registry[name];
    if (!step) throw new FlowError(`unknown step "${name}"`);
    const out = await step.run(ctx, makeHost(name));
    if (out === null || typeof out !== 'object' || Array.isArray(out)) throw new FlowError(`step "${name}" must return the context object`);
    ctx = out;
  }
  return ctx;
}

/** The page URL once an area has been built: plays that area on refresh, keeps other params (?fly, ?room, ?name), drops the flow. */
export function urlAfterBuild(href, areaId) {
  const u = new URL(href);
  u.searchParams.set('area', areaId); u.searchParams.delete('pick'); u.searchParams.delete('flow');
  return u.href;
}
