import { describe, expect, test } from 'bun:test';
import { createContext, runInContext } from 'node:vm';

const source = await Bun.file(new URL('../src/controller.ts', import.meta.url)).text();
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup({ subframe = false, supported = true } = {}) {
  const handlers = new Map<string, ((details: object) => void) | null>();
  let registrations = 0;
  let exits = 0;
  class FakeDocument extends EventTarget {
    hidden = false;
    pictureInPictureEnabled = true;
    pictureInPictureElement: FakeVideo | null = null;
    list: FakeVideo[] = [];
    querySelectorAll(selector: string) { return selector === 'video' ? this.list : []; }
    async exitPictureInPicture() {
      exits++;
      const video = this.pictureInPictureElement;
      this.pictureInPictureElement = null;
      video?.dispatchEvent(new Event('leavepictureinpicture'));
    }
  }
  const document = new FakeDocument();
  class FakeVideo extends EventTarget {
    paused = false;
    ended = false;
    readyState = 4;
    videoWidth = 640;
    disablePictureInPicture = false;
    area = 640 * 360;
    requests = 0;
    error: Error | null = null;
    gate: Promise<void> | null = null;
    getBoundingClientRect() { return { width: this.area, height: 1 }; }
    async requestPictureInPicture() {
      this.requests++;
      if (this.gate) await this.gate;
      if (this.error) throw this.error;
      document.pictureInPictureElement = this;
    }
  }
  const window = Object.assign(new EventTarget(), {
    top: null as unknown,
    __chromeAutoPipV1: undefined as any,
    documentPictureInPicture: undefined as undefined | {
      window: { closed: boolean; close(): void } | null;
    },
  });
  window.top = subframe ? {} : window;
  const session = {
    setActionHandler(action: string, handler: ((details: object) => void) | null) {
      if (!supported && action === 'enterpictureinpicture') throw new Error('Unsupported');
      registrations++;
      handlers.set(action, handler);
    },
  };
  const context = createContext({ window, document, navigator: { mediaSession: session }, Event, CustomEvent, Error, setTimeout });
  runInContext(script, context);
  const controller = window.__chromeAutoPipV1;
  function addVideo(options: Partial<FakeVideo> = {}) {
    const video = Object.assign(new FakeVideo(), options);
    document.list.push(video);
    return video;
  }
  function visibility(hidden: boolean) {
    document.hidden = hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  }
  async function nativeAction(reason = 'contentoccluded') {
    handlers.get('enterpictureinpicture')?.({ action: 'enterpictureinpicture', reason });
    await flush();
  }
  return { window, document, controller, context, session, handlers, addVideo, visibility, nativeAction,
    get exits() { return exits; }, get registrations() { return registrations; } };
}

describe('native automatic PiP controller', () => {
  test('automatic Document PiP permission errors do not fall back to the stalled video path', async () => {
    const env = setup();
    const video = env.addVideo();
    let requests = 0;
    env.window.documentPictureInPicture = {
      window: null,
      async requestWindow() { requests++; throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }); },
    } as any;
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(requests).toBe(1);
    expect(video.requests).toBe(0);
    expect(env.controller.getStatus().automaticMode).toBe('document');
    expect(env.controller.getStatus().lastError).toContain('許可');
  });

  test('automatic Document PiP takes priority over a site handler that opens video PiP', async () => {
    const env = setup();
    const video = env.addVideo();
    let siteRequests = 0;
    let documentRequests = 0;
    env.window.documentPictureInPicture = {
      window: null,
      async requestWindow() { documentRequests++; throw new Error('Test window unavailable'); },
    } as any;
    env.session.setActionHandler('enterpictureinpicture', () => { siteRequests++; });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(documentRequests).toBe(1);
    expect(siteRequests).toBe(0);
    expect(video.requests).toBe(0);
  });

  test('the manual open button keeps the working video PiP path when Document PiP is supported', async () => {
    const env = setup();
    const video = env.addVideo();
    let documentRequests = 0;
    env.window.documentPictureInPicture = {
      window: null,
      async requestWindow() { documentRequests++; throw new Error('Must not be called'); },
    } as any;
    expect((await env.controller.open()).ok).toBe(true);
    expect(video.requests).toBe(1);
    expect(documentRequests).toBe(0);
    expect((await env.controller.close()).ok).toBe(true);
  });

  test('close calls the page API immediately without asking an isolated agent', async () => {
    const env = setup();
    const video = env.addVideo();
    env.document.pictureInPictureElement = video;
    let delegated = 0;
    env.window.addEventListener('chrome-auto-pip:close-native-v1', () => { delegated++; });
    env.window.dispatchEvent(new Event('chrome-auto-pip:native-ready-v1'));
    const closing = env.controller.close();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
    expect(delegated).toBe(0);
    expect((await closing).ok).toBe(true);
    expect(env.controller.getStatus().lastError).toBe('');
  });

  test('a nonclosing activation notification does not issue a second native exit', async () => {
    const env = setup();
    const video = env.addVideo();
    env.document.pictureInPictureElement = video;
    await env.controller.onTabActivated(false);
    expect(env.document.pictureInPictureElement).toBe(video);
    expect(env.exits).toBe(0);
  });

  test('a pending native Promise cannot keep a completed controller close waiting forever', async () => {
    const env = setup();
    const video = env.addVideo();
    env.document.pictureInPictureElement = video;
    env.document.exitPictureInPicture = () => {
      env.document.pictureInPictureElement = null;
      return new Promise<never>(() => {});
    };
    const result = await env.controller.close();
    expect(result.ok).toBe(true);
    expect(env.document.pictureInPictureElement).toBeNull();
  });

  test('visibility alone cannot open PiP; the native action selects the largest playing video', async () => {
    const env = setup();
    const paused = env.addVideo({ paused: true, area: 2_000_000 });
    const small = env.addVideo({ area: 500 });
    const big = env.addVideo({ area: 10_000 });
    const prohibited = env.addVideo({ area: 100_000, disablePictureInPicture: true });
    env.controller.configure(true);
    env.visibility(true);
    await flush();
    expect(big.requests).toBe(0);
    await env.nativeAction();
    expect(env.document.pictureInPictureElement).toBe(big);
    expect([paused.requests, small.requests, prohibited.requests]).toEqual([0, 0, 0]);
  });

  test('automatic PiP repeatedly opens when leaving and closes when returning', async () => {
    const env = setup();
    const video = env.addVideo();
    env.controller.configure(true);
    for (let i = 0; i < 3; i++) {
      env.visibility(true);
      await env.nativeAction();
      expect(env.document.pictureInPictureElement).toBe(video);
      env.visibility(false);
      await flush();
      expect(env.document.pictureInPictureElement).toBeNull();
    }
    expect(video.requests).toBe(3);
    expect(env.exits).toBe(3);
  });

  test('Chrome activation closes PiP when the page return event is absent', async () => {
    const env = setup();
    const video = env.addVideo();
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(env.document.pictureInPictureElement).toBe(video);
    await env.controller.onTabActivated();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('Chrome activation cancels a late automatic request without a page visibility update', async () => {
    const env = setup();
    let resolve!: () => void;
    env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    await env.controller.onTabActivated();
    resolve();
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('Chrome activation also cancels a late delegated site request', async () => {
    const env = setup();
    let resolve!: () => void;
    const video = env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    env.session.setActionHandler('enterpictureinpicture', async () => {
      await video.requestPictureInPicture();
    });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    await env.controller.onTabActivated();
    resolve();
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
  });

  test('manual PiP stays open initially, then closes on return even with automation disabled', async () => {
    const env = setup();
    const video = env.addVideo({ paused: true });
    env.controller.configure(false);
    expect((await env.controller.toggle()).ok).toBe(true);
    expect(env.document.pictureInPictureElement).toBe(video);
    expect(env.exits).toBe(0);
    env.visibility(true);
    env.visibility(false);
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('an explicit close never reopens a PiP that the background already closed', async () => {
    const env = setup();
    const video = env.addVideo();
    await env.controller.open();
    expect(env.controller.getStatus().inPictureInPicture).toBe(true);
    await env.controller.onTabActivated();
    expect((await env.controller.close()).ok).toBe(true);
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(video.requests).toBe(1);
  });

  test('an unavailable Document PiP getter does not prevent closing ordinary video PiP', async () => {
    const env = setup();
    const video = env.addVideo();
    env.document.pictureInPictureElement = video;
    Object.defineProperty(env.window, 'documentPictureInPicture', {
      get() { throw new Error('Document PiP unavailable in this frame'); },
    });
    expect(env.controller.getStatus().inPictureInPicture).toBe(true);
    expect((await env.controller.close()).ok).toBe(true);
    expect(env.document.pictureInPictureElement).toBeNull();
  });

  test('a no-op exit API cannot produce a successful close message', async () => {
    const env = setup();
    env.document.pictureInPictureElement = env.addVideo();
    env.document.exitPictureInPicture = async () => {};
    const result = await env.controller.close();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('解除に失敗');
    expect(env.controller.getStatus().inPictureInPicture).toBe(true);
  });

  test('paused, ended, unloaded and disabled videos do not open automatically', async () => {
    const env = setup();
    const videos = [env.addVideo({ paused: true }), env.addVideo({ ended: true }),
      env.addVideo({ readyState: 0 }), env.addVideo({ disablePictureInPicture: true })];
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(videos.map((video) => video.requests)).toEqual([0, 0, 0, 0]);
  });

  test('preserves a site handler registered later and unrelated media actions', async () => {
    const env = setup();
    const video = env.addVideo();
    let siteCalls = 0;
    const siteHandler = () => { siteCalls++; };
    const playHandler = () => {};
    env.controller.configure(true);
    env.session.setActionHandler('enterpictureinpicture', siteHandler);
    env.session.setActionHandler('play', playHandler);
    env.visibility(true);
    await env.nativeAction();
    expect(siteCalls).toBe(1);
    expect(video.requests).toBe(0);
    expect(env.handlers.get('play')).toBe(playHandler);
    env.controller.configure(false);
    expect(env.handlers.get('enterpictureinpicture')).toBe(siteHandler);
    env.session.setActionHandler('enterpictureinpicture', null);
    env.controller.configure(true);
    await env.nativeAction();
    expect(video.requests).toBe(1);
  });

  test('does not replace existing PiP, but closes it when the video tab returns', async () => {
    const env = setup();
    const video = env.addVideo();
    env.document.pictureInPictureElement = video;
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    env.visibility(false);
    await flush();
    expect(video.requests).toBe(0);
    expect(env.exits).toBe(1);
    expect(env.document.pictureInPictureElement).toBeNull();
  });

  test('closes video PiP opened through a delegated site handler', async () => {
    const env = setup();
    const video = env.addVideo();
    env.session.setActionHandler('enterpictureinpicture', async () => {
      await video.requestPictureInPicture();
    });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(env.document.pictureInPictureElement).toBe(video);
    env.visibility(false);
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('closes Document PiP opened through a delegated site handler', async () => {
    const env = setup();
    let closes = 0;
    const pipWindow = { closed: false, close() { this.closed = true; closes++; } };
    env.window.documentPictureInPicture = { window: null };
    env.session.setActionHandler('enterpictureinpicture', () => {
      env.window.documentPictureInPicture!.window = pipWindow;
    });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(env.controller.getStatus().inPictureInPicture).toBe(true);
    env.visibility(false);
    await flush();
    expect(closes).toBe(1);
    expect(env.controller.getStatus().inPictureInPicture).toBe(false);
    expect(env.exits).toBe(0);
  });

  test('the toolbar button can close a site Document PiP window', async () => {
    const env = setup();
    const pipWindow = { closed: false, close() { this.closed = true; } };
    env.window.documentPictureInPicture = { window: pipWindow };
    expect((await env.controller.toggle()).ok).toBe(true);
    expect(pipWindow.closed).toBe(true);
    expect(env.exits).toBe(0);
  });

  test('a site request resolving after return closes its late PiP', async () => {
    const env = setup();
    let resolve!: () => void;
    const video = env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    env.session.setActionHandler('enterpictureinpicture', async () => {
      await video.requestPictureInPicture();
    });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    env.visibility(false);
    resolve();
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('a manual request resolving after a tab leave and return also closes', async () => {
    const env = setup();
    let resolve!: () => void;
    env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    const request = env.controller.toggle();
    env.visibility(true);
    env.visibility(false);
    resolve();
    await request;
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('returning during an outstanding request closes the late window', async () => {
    const env = setup();
    let resolve!: () => void;
    const video = env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    await env.nativeAction();
    expect(video.requests).toBe(1);
    env.visibility(false);
    resolve();
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.exits).toBe(1);
  });

  test('disabling automation closes a pending automatic window', async () => {
    const env = setup();
    let resolve!: () => void;
    env.addVideo({ gate: new Promise<void>((done) => { resolve = done; }) });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    env.controller.configure(false);
    resolve();
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
    expect(env.handlers.get('enterpictureinpicture')).toBeNull();
  });

  test('a denied request is reported and does not block the next attempt', async () => {
    const env = setup();
    const error = new Error('Gesture required');
    error.name = 'NotAllowedError';
    const video = env.addVideo({ error });
    env.controller.configure(true);
    env.visibility(true);
    await env.nativeAction();
    expect(env.controller.getStatus().lastError).toContain('許可');
    video.error = null;
    await env.nativeAction();
    expect(env.document.pictureInPictureElement).toBe(video);
    expect(env.controller.getStatus().lastError).toBe('');
  });

  test('subframes can open manually without registering automatic handlers', async () => {
    const env = setup({ subframe: true });
    const video = env.addVideo();
    env.controller.configure(true);
    expect(env.registrations).toBe(0);
    expect(env.controller.getStatus().enabled).toBe(false);
    await env.controller.toggle();
    expect(env.document.pictureInPictureElement).toBe(video);
    env.visibility(true);
    env.visibility(false);
    await flush();
    expect(env.document.pictureInPictureElement).toBeNull();
  });

  test('unsupported automatic action still permits manual PiP', async () => {
    const env = setup({ supported: false });
    env.addVideo();
    env.controller.configure(true);
    expect(env.controller.getStatus().automaticSupported).toBe(false);
    expect((await env.controller.toggle()).ok).toBe(true);
  });

  test('reinjection does not duplicate controller or media handler hooks', () => {
    const env = setup();
    const hook = env.session.setActionHandler;
    runInContext(script, env.context);
    expect(env.window.__chromeAutoPipV1).toBe(env.controller);
    expect(env.session.setActionHandler).toBe(hook);
  });
});
