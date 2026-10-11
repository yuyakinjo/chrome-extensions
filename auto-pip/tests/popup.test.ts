import { expect, test } from 'bun:test';
import { createContext, runInContext } from 'node:vm';

const transpiler = new Bun.Transpiler({ loader: 'ts' });
const source = await Bun.file(new URL('../src/popup.ts', import.meta.url)).text();
const script = transpiler.transformSync(source).replace(/^import .*;$/gm, '');
const actionsSource = await Bun.file(new URL('../src/pip-actions.ts', import.meta.url)).text();
const actions = transpiler.transformSync(actionsSource).replace(/^export /gm, '');
const controllerSource = await Bun.file(new URL('../src/controller.ts', import.meta.url)).text();
const controllerScript = transpiler.transformSync(controllerSource);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup({ savedReport, initialPip = true, closeWorks = true }:
  { savedReport?: object; initialPip?: boolean; closeWorks?: boolean } = {}) {
  const elements = new Map<string, { textContent: string; disabled: boolean; checked: boolean; listeners: Map<string, () => void> }>();
  for (const id of ['version', 'enabled', 'site-enabled', 'site', 'status', 'toggle', 'close', 'diagnostics']) {
    elements.set(`#${id}`, { textContent: '', disabled: true, checked: false, listeners: new Map() });
  }
  let inPip = initialPip;
  let inClick = false;
  let exits = 0;
  let opens = 0;
  const video = {
    paused: false, ended: false, readyState: 4, videoWidth: 640, disablePictureInPicture: false,
    getBoundingClientRect() { return { width: 640, height: 360 }; },
    async requestPictureInPicture() { opens++; inPip = true; },
  };
  const pageDocument = Object.assign(new EventTarget(), {
    hidden: false,
    pictureInPictureEnabled: true,
    querySelectorAll(selector: string) { return selector === 'video' ? [video] : []; },
    exitPictureInPicture() {
      exits++;
      if (closeWorks) inPip = false;
      return new Promise<never>(() => {});
    },
  });
  Object.defineProperty(pageDocument, 'pictureInPictureElement', { get: () => inPip ? video : null });
  const pageWindow = Object.assign(new EventTarget(), {
    top: null as unknown, __chromeAutoPipV1: undefined as any,
  });
  pageWindow.top = pageWindow;
  const main = createContext({ window: pageWindow, document: pageDocument, navigator: {}, setTimeout, Event });
  runInContext(controllerScript, main);
  const isolated = createContext({ window: {}, document: {
    get pictureInPictureElement() { return inPip ? video : null; },
    exitPictureInPicture() { throw new Error('ISOLATED must never close PiP'); },
  } });
  const requests: object[] = [];
  const closeInjections: Array<{ world: string; inClick: boolean; frameIds?: number[] }> = [];
  let respond!: (report: object) => void;
  let lastReport: object | undefined = savedReport;
  const chrome = {
    runtime: {
      getManifest: () => ({ version: '0.1.8' }),
      sendMessage(message: object) {
        requests.push(message);
        return new Promise<object>((resolve) => { respond = resolve; });
      },
    },
    tabs: { query: async () => [{ id: 7, url: 'https://www.youtube.com/watch?v=test' }] },
    storage: { session: {
      get: async () => ({ autoPipLastManualClose: lastReport }),
      async set(values: { autoPipLastManualClose?: object }) { lastReport = values.autoPipLastManualClose; },
    } },
    scripting: {
      async executeScript({ world, func, target }:
        { world: string; func: Function; target: { frameIds?: number[] } }) {
        if (func.name === 'closeFramePip') closeInjections.push({ world, inClick, frameIds: target.frameIds });
        const result = await runInContext(`(${func.toString()})()`, world === 'MAIN' ? main : isolated);
        return [{ frameId: 0, documentId: 'video-document', result }];
      },
    },
  };
  const context = createContext({
    chrome, setTimeout, clearTimeout, URL, navigator: { userAgent: 'Chrome/155' },
    readSettings: async () => ({ enabled: true, disabledOrigins: [] }),
    writeSettings: async () => {},
    document: { querySelector(selector: string) {
      const element = elements.get(selector)!;
      return Object.assign(element, { addEventListener(event: string, listener: () => void) { element.listeners.set(event, listener); } });
    } },
  });
  runInContext(actions, context);
  runInContext(script, context);
  return {
    requests, closeInjections,
    clickClose() {
      inClick = true;
      try { elements.get('#close')!.listeners.get('click')!(); } finally { inClick = false; }
    },
    respond(report: object) { respond(report); },
    closeExternally() { inPip = false; },
    get inPip() { return inPip; },
    get exits() { return exits; },
    get opens() { return opens; },
    get savedReport() { return lastReport; },
    get status() { return elements.get('#status')!.textContent; },
    get diagnostics() { return JSON.parse(elements.get('#diagnostics')!.textContent); },
    get closeDisabled() { return elements.get('#close')!.disabled; },
  };
}

test('manual close injects MAIN synchronously in the click without a worker message or tab scan', async () => {
  const env = setup();
  await flush();
  env.clickClose();
  expect(env.closeInjections).toEqual([{ world: 'MAIN', inClick: true, frameIds: [0] }]);
  expect(env.requests).toEqual([]);
  expect(env.exits).toBe(1);
  expect(env.status).toBe('PiPを解除しています…');
  expect(env.closeDisabled).toBe(true);
  await flush();
  expect(env.inPip).toBe(false);
  expect(env.diagnostics.manualClose.ok).toBe(true);
  expect(env.diagnostics.manualClose.reports[0].frames[0].world).toBe('MAIN');
  expect(env.savedReport).toEqual(env.diagnostics.manualClose);
  expect(env.closeDisabled).toBe(false);
});

test('manual close cannot report success while MAIN leaves the PiP open', async () => {
  const env = setup({ closeWorks: false });
  await flush();
  env.clickClose();
  const deadline = Date.now() + 1800;
  while (env.closeDisabled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(env.inPip).toBe(true);
  expect(env.diagnostics.manualClose.ok).toBe(false);
  expect(env.diagnostics.manualClose.reports[0].remaining).toBe(true);
  expect(env.status).toContain('まだ開いています');
  expect(env.requests).toEqual([]);
  expect(env.closeDisabled).toBe(false);
});

test('a stale popup snapshot cannot reopen a PiP that auto-close already removed', async () => {
  const env = setup();
  await flush();
  env.closeExternally();
  env.clickClose();
  await flush();
  expect(env.inPip).toBe(false);
  expect(env.opens).toBe(0);
  expect(env.exits).toBe(0);
  expect(env.diagnostics.manualClose.ok).toBe(true);
});

test('a popup without local PiP uses the global close and retains progress until it responds', async () => {
  const env = setup({ initialPip: false });
  await flush();
  env.clickClose();
  expect(env.requests).toEqual([{ type: 'auto-pip:close-all', tabId: 7 }]);
  expect(env.closeInjections).toEqual([]);
  expect(env.status).toBe('PiPを解除しています…');
  expect(env.diagnostics.manualClose.state).toBe('解除中');
  env.respond({ ok: false, message: 'PiPがまだ開いています。', errors: ['Frame with ID 0 was removed.'] });
  await flush();
  expect(env.status).toBe('PiPがまだ開いています。');
  expect(env.diagnostics.manualClose.ok).toBe(false);
  expect(env.closeDisabled).toBe(false);
});

test('reopening the popup retains the last manual failure report', async () => {
  const report = { ok: false, message: '解除結果を確認できませんでした。', errors: ['Frame with ID 0 was removed.'] };
  const env = setup({ savedReport: report });
  await flush();
  expect(env.diagnostics.manualClose).toEqual(report);
  expect(env.requests).toEqual([]);
});
