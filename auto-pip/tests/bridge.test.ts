import { expect, test } from 'bun:test';
import { createContext, runInContext } from 'node:vm';

const source = await Bun.file(new URL('../src/bridge.ts', import.meta.url)).text();
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  const window = new EventTarget();
  const updates: boolean[] = [];
  window.addEventListener('chrome-auto-pip:configure-v1', (event) => {
    updates.push((event as CustomEvent).detail);
  });
  let resolve!: (value: object) => void;
  let changed!: (changes: object, area: string) => void;
  const chrome = { storage: {
    local: { get: () => new Promise<object>((done) => { resolve = done; }) },
    onChanged: { addListener: (listener: typeof changed) => { changed = listener; } },
  } };
  runInContext(script, createContext({ window, chrome, location: { origin: 'https://video.example' }, CustomEvent }));
  return { window, updates, resolve, change: (settings: object, area = 'local') =>
    changed({ autoPipSettings: { newValue: settings } }, area) };
}

test('default enabled setting is resent when MAIN world becomes ready', async () => {
  const env = setup();
  env.resolve({});
  await flush();
  env.window.dispatchEvent(new Event('chrome-auto-pip:ready-v1'));
  expect(env.updates).toEqual([true, true]);
});

test('global and site opt-outs are applied without sending storage contents to the page', async () => {
  const env = setup();
  env.resolve({ autoPipSettings: { enabled: true, disabledOrigins: ['https://video.example'] } });
  await flush();
  expect(env.updates).toEqual([false]);
  env.change({ enabled: true, disabledOrigins: [] });
  env.change({ enabled: false, disabledOrigins: [] });
  env.change({ enabled: true }, 'sync');
  expect(env.updates).toEqual([false, true, false]);
});

test('a stale initial read cannot overwrite a newer change notification', async () => {
  const env = setup();
  env.change({ enabled: false, disabledOrigins: [] });
  env.resolve({ autoPipSettings: { enabled: true, disabledOrigins: [] } });
  await flush();
  expect(env.updates).toEqual([false]);
});
