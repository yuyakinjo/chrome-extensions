// 実際の Chrome エンジンで PiP の開閉・動画の復元を検証する。
// MediaSession アクションをテスト側から呼ぶため、Chrome の自動表示の対象判定は別途確認が必要。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const controller = await Bun.file(new URL('../dist/src/controller.js', import.meta.url)).text();
const profile = await mkdtemp(join(tmpdir(), 'autopip-chrome-test-'));
await writeFile(join(profile, 'test.html'), '<!doctype html><title>Auto PiP integration test</title>');
const proc = Bun.spawn([
  process.env.AUTOPIP_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-sync', '--disable-component-update', '--disable-default-apps',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank',
], { stdout: 'ignore', stderr: 'pipe' });
let socket: WebSocket | undefined;
let stderr = '';
const errorsRead = (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of proc.stderr) stderr = (stderr + decoder.decode(chunk)).slice(-3000);
})();
try {
  let portInfo = '';
  for (let attempt = 0; attempt < 120; attempt++) {
    try { portInfo = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); break; } catch {}
    if (proc.exitCode !== null) throw new Error(`Chrome exited: ${proc.exitCode}; ${stderr}`);
    await Bun.sleep(100);
  }
  if (!portInfo) throw new Error(`Chrome did not start; ${stderr}`);
  const [port, path] = portInfo.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = () => reject(new Error('Could not connect to test Chrome'));
  });
  let sequence = 0;
  type Reply = Record<string, any>;
  const pending = new Map<number, { resolve: (result: Reply) => void; reject: (error: Error) => void }>();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  };
  async function command(method: string, params: object = {}, sessionId?: string): Promise<Reply> {
    const id = ++sequence;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
        pending.set(id, { resolve, reject });
        socket!.send(JSON.stringify({ id, method, params, sessionId }));
      });
    } finally { clearTimeout(timeout); }
  }
  console.log((await command('Browser.getVersion')).product);
  const testUrl = `file://${join(profile, 'test.html')}`;
  const { targetId } = await command('Target.createTarget', { url: testUrl });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  async function evaluate(expression: string, userGesture = false): Promise<any> {
    const result = await command('Runtime.evaluate', { expression, userGesture, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await command('Target.activateTarget', { targetId });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await evaluate(`location.href === ${JSON.stringify(testUrl)} && document.readyState === 'complete' && Boolean(document.body)`)) break;
    await Bun.sleep(50);
  }
  assert.equal(await evaluate(`location.href === ${JSON.stringify(testUrl)} && document.readyState === 'complete' && Boolean(document.body)`), true);
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    setInterval(() => { ctx.fillStyle = 'green'; ctx.fillRect(0, 0, 640, 360); }, 33);
    const parent = document.createElement('section');
    const before = document.createElement('span'); const after = document.createElement('span');
    const video = document.createElement('video'); video.muted = true;
    video.style.cssText = 'width:640px;height:360px';
    video.srcObject = canvas.captureStream(30);
    parent.append(before, video, after); document.body.append(parent); await video.play();
    globalThis.testVideo = video; globalThis.originalParent = parent;
    globalThis.originalNext = after; globalThis.originalStyle = video.getAttribute('style');
    const register = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      if (action === 'enterpictureinpicture') globalThis.testPipAction = handler;
      return register(action, handler);
    };
  })()`);
  await evaluate(controller);
  await evaluate('window.__chromeAutoPipV1.configure(true)');
  const other = await command('Target.createTarget', { url: 'about:blank', background: false });
  async function away(): Promise<void> {
    await command('Target.activateTarget', { targetId: other.targetId });
    assert.equal(await evaluate('document.hidden'), true);
    await evaluate("testPipAction({ action: 'enterpictureinpicture', reason: 'contentoccluded' })", true);
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await evaluate('Boolean(documentPictureInPicture.window && testVideo.ownerDocument === documentPictureInPicture.window.document && !testVideo.paused)')) return;
      await Bun.sleep(50);
    }
    throw new Error('Automatic Document PiP did not open with the playing video');
  }
  async function restored(paused = false): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await evaluate(`({
        closed: !documentPictureInPicture.window || documentPictureInPicture.window.closed,
        restored: testVideo.parentNode === originalParent && testVideo.nextSibling === originalNext,
        sameDocument: testVideo.ownerDocument === document,
        sameStyle: testVideo.getAttribute('style') === originalStyle,
        controls: testVideo.controls, paused: testVideo.paused,
      })`);
      if (state.closed && state.restored && state.paused === paused) {
        assert.equal(state.sameDocument, true); assert.equal(state.sameStyle, true); assert.equal(state.controls, false);
        return;
      }
      await Bun.sleep(50);
    }
    throw new Error('PiP did not close and restore the video with its playback state');
  }
  // 通常の動画 PiP を手動で開いて閉じる経路。
  await command('Target.activateTarget', { targetId });
  assert.equal((await evaluate('window.__chromeAutoPipV1.open()', true)).ok, true);
  assert.equal(await evaluate('Boolean(document.pictureInPictureElement)'), true);
  assert.equal((await evaluate('window.__chromeAutoPipV1.close()', true)).ok, true);
  assert.equal(await evaluate('Boolean(document.pictureInPictureElement)'), false);
  console.log('PASS: manual video PiP');
  // 自動表示後、元のタブに戻ると実ウィンドウが閉じて動画が戻る。
  await away();
  await command('Target.activateTarget', { targetId });
  await restored();
  console.log('PASS: automatic Document PiP closes on tab return and restores playback');
  // 自動表示したウィンドウを手動ボタンの処理で閉じる。
  await away();
  assert.equal((await evaluate('window.__chromeAutoPipV1.close()', true)).ok, true);
  await restored();
  console.log('PASS: manual close of automatic Document PiP');
  // 動画 PiP の exit API が応答しなくても、Document PiP の解除はその API を使わない。
  await evaluate("globalThis.videoExitCalls = 0; document.exitPictureInPicture = () => { videoExitCalls++; return new Promise(() => {}); }");
  await away();
  await command('Target.activateTarget', { targetId });
  await restored();
  assert.equal(await evaluate('videoExitCalls'), 0);
  console.log('PASS: automatic close avoids the stalled video exit API');
  // ネイティブ側からウィンドウを閉じても、停止状態を保って元の位置に戻す。
  const existing = new Set((await command('Target.getTargets')).targetInfos.map((target: Reply) => target.targetId));
  await away();
  await evaluate('testVideo.pause()');
  const opened = (await command('Target.getTargets')).targetInfos.find((target: Reply) => target.type === 'page' && !existing.has(target.targetId));
  assert.ok(opened, 'Document PiP target must exist');
  await command('Target.closeTarget', { targetId: opened.targetId });
  await restored(true);
  console.log('PASS: native window close restores video and preserves pause');
  await command('Browser.close');
} finally {
  socket?.close();
  if (proc.exitCode === null) proc.kill();
  await proc.exited;
  await errorsRead;
  await rm(profile, { recursive: true, force: true });
}
