/**
 * 拡張機能を <ext>/dist に組み立てる。
 *
 *   bun run build                 manifest.json を持つディレクトリを全部
 *   bun run build pr-tab-grouper  1 つだけ
 *   bun run dev   pr-tab-grouper  tsc --watch + 静的ファイルの監視
 *   bun run typecheck             出力せずに型だけ見る（拡張機能 + tools）
 *
 * <ext>/tsconfig.json は rootDir: "." なので tsc の出力は <ext>/dist/src/**。
 * manifest.json の "src/background.js" をそのまま使えるようにするためで、
 * ここではそれ以外――manifest.json / icons / html / css――を dist へ運ぶ。
 */
import { watch } from 'node:fs';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';

/** Bun.file().exists() はディレクトリに false を返すので、こちらを使う。 */
const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const REPO = resolve(import.meta.dir, '..');
const TSC = join(REPO, 'node_modules', '.bin', 'tsc');

/** 拡張機能のディレクトリ直下から、そのままコピーするもの。 */
const STATIC_FILES = ['manifest.json'];
const STATIC_DIRS = ['icons'];
/** src の中で tsc が触らない拡張子。 */
const STATIC_EXTS = ['.html', '.css'];

// ------------------------------------------------------------------ 対象の決定

/** manifest.json を持つディレクトリ = 拡張機能。 */
async function findExtensions(): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(REPO, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }
    if (await exists(join(REPO, entry.name, 'manifest.json'))) found.push(entry.name);
  }
  return found.sort();
}

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const checkOnly = args.includes('--check');
const requested = args.filter((a) => !a.startsWith('--'));

const available = await findExtensions();
if (!available.length) {
  console.error('manifest.json を持つディレクトリが見つかりません。');
  process.exit(1);
}

const targets = requested.length ? requested : available;
const unknown = targets.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`知らない拡張機能です: ${unknown.join(', ')}`);
  console.error(`使えるのは: ${available.join(', ')}`);
  process.exit(1);
}

/** 複数を相手にしているときだけログに名前を付ける。 */
const tag = (name: string): string => (targets.length > 1 ? `[${name}] ` : '');

// ------------------------------------------------------------------ コピー

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function copyInto(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

/** tsc が出さないものを <ext>/dist へ運ぶ。運んだ件数を返す。 */
async function copyStatic(name: string): Promise<number> {
  const ext = join(REPO, name);
  const dist = join(ext, 'dist');
  let copied = 0;

  for (const entry of [...STATIC_FILES, ...STATIC_DIRS]) {
    // icons を持たない拡張機能もありうる
    if (!(await exists(join(ext, entry)))) continue;
    await copyInto(join(ext, entry), join(dist, entry));
    copied++;
  }

  for await (const path of walk(join(ext, 'src'))) {
    if (!STATIC_EXTS.includes(extname(path))) continue;
    await copyInto(path, join(dist, relative(ext, path)));
    copied++;
  }

  return copied;
}

// ------------------------------------------------------------------ tsc

function spawnTsc(project: string, extra: string[] = []): ReturnType<typeof Bun.spawn> {
  return Bun.spawn([TSC, '-p', project, ...extra], {
    cwd: REPO,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
}

const projectOf = (name: string): string => join(REPO, name, 'tsconfig.json');

// ------------------------------------------------------------------ 本体

if (checkOnly) {
  let failed = 0;
  for (const name of targets) {
    console.log(`[${name}] typecheck…`);
    failed += (await spawnTsc(projectOf(name), ['--noEmit']).exited) === 0 ? 0 : 1;
  }
  console.log('[tools] typecheck…');
  failed += (await spawnTsc(join(REPO, 'tsconfig.tools.json')).exited) === 0 ? 0 : 1;
  if (failed) process.exit(1);
  console.log('✓ 型エラーはありません');
} else if (!watchMode) {
  for (const name of targets) {
    // 消したファイルが dist に残らないよう、毎回まっさらから作る
    await rm(join(REPO, name, 'dist'), { recursive: true, force: true });

    const code = await spawnTsc(projectOf(name)).exited;
    if (code !== 0) process.exit(code);

    const copied = await copyStatic(name);
    console.log(`✓ ${name}/dist を作りました（静的ファイル ${copied} 件）`);
  }
  console.log('  chrome://extensions で「パッケージ化されていない拡張機能を読み込む」→ <ext>/dist');
} else {
  const running: Array<ReturnType<typeof Bun.spawn>> = [];

  for (const name of targets) {
    await copyStatic(name);
    running.push(spawnTsc(projectOf(name), ['--watch', '--preserveWatchOutput']));

    // .ts は tsc 側が見ているので、ここでは静的ファイルだけを見る
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (label: string): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void copyStatic(name).then(() => console.log(`${tag(name)}[assets] ${label} を反映しました`));
      }, 50);
    };

    for (const entry of [...STATIC_FILES, ...STATIC_DIRS, 'src']) {
      const path = join(REPO, name, entry);
      if (!(await exists(path))) continue;
      watch(path, { recursive: true }, (_event, filename) => {
        const changed = filename ?? entry;
        // src 配下は html/css だけ。.ts の保存でコピーを走らせても意味がない
        if (entry === 'src' && !STATIC_EXTS.includes(extname(changed))) return;
        schedule(changed);
      });
    }
  }

  console.log('watching… dist/ を読み込んだまま編集できます（拡張機能の再読み込みは必要です）');
  const codes = await Promise.all(running.map((proc) => proc.exited));
  process.exit(codes.find((c) => c !== 0) ?? 0);
}
