/**
 * dist/ に「Chrome へそのまま読み込める拡張機能」を組み立てる。
 *
 *   bun run build   1 回だけビルドする
 *   bun run dev     tsc --watch と静的ファイルの監視を並べて走らせる
 *
 * tsc は src/**\/*.ts を dist/src/**\/*.js に出す（rootDir: "." なので src/ の階層が
 * そのまま残り、manifest.json の "src/background.js" などがそのまま通る）。
 * ここではそれ以外――manifest.json / icons / html / css――を dist へ運ぶ。
 */
import { watch } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

/** そのままコピーするファイルとディレクトリ。 */
const STATIC_FILES = ['manifest.json'];
const STATIC_DIRS = ['icons'];
/** src の中で tsc が触らない拡張子。 */
const STATIC_EXTS = ['.html', '.css'];

const watchMode = process.argv.includes('--watch');

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

/** tsc が出さないものを dist へ運ぶ。運んだ件数を返す。 */
async function copyStatic(): Promise<number> {
  let copied = 0;

  for (const name of [...STATIC_FILES, ...STATIC_DIRS]) {
    await copyInto(join(ROOT, name), join(DIST, name));
    copied++;
  }

  for await (const path of walk(join(ROOT, 'src'))) {
    if (!STATIC_EXTS.includes(extname(path))) continue;
    await copyInto(path, join(DIST, relative(ROOT, path)));
    copied++;
  }

  return copied;
}

// ------------------------------------------------------------------ tsc

function spawnTsc(): ReturnType<typeof Bun.spawn> {
  const args = watchMode ? ['--watch', '--preserveWatchOutput'] : [];
  return Bun.spawn([TSC, '-p', 'tsconfig.json', ...args], {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
}

// ------------------------------------------------------------------ 本体

if (!watchMode) {
  // 消したファイルが dist に残らないよう、毎回まっさらから作る
  await rm(DIST, { recursive: true, force: true });

  const code = await spawnTsc().exited;
  if (code !== 0) process.exit(code);

  const copied = await copyStatic();
  console.log(`✓ dist/ を作りました（静的ファイル ${copied} 件）`);
  console.log('  chrome://extensions で「パッケージ化されていない拡張機能を読み込む」→ dist/');
} else {
  await copyStatic();
  const tsc = spawnTsc();

  // .ts は tsc 側が見ているので、ここでは静的ファイルだけを見る
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (label: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void copyStatic().then(() => console.log(`[assets] ${label} を反映しました`));
    }, 50);
  };

  for (const target of [...STATIC_FILES, ...STATIC_DIRS, 'src']) {
    watch(join(ROOT, target), { recursive: true }, (_event, filename) => {
      const name = filename ?? target;
      // src 配下は html/css だけ。.ts の保存でコピーを走らせても意味がない
      if (target === 'src' && !STATIC_EXTS.includes(extname(name))) return;
      schedule(name);
    });
  }

  console.log('watching… dist/ を読み込んだまま編集できます（拡張機能の再読み込みは必要です）');
  process.exit(await tsc.exited);
}
