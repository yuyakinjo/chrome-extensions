# chrome-extensions

TypeScript で書いた Chrome 拡張機能を置いておくリポジトリです。
拡張機能ごとにディレクトリを分け、ビルド・型チェック・アイコン生成のしくみはルートで共通化しています。

## 入っている拡張機能

| ディレクトリ | 内容 |
| --- | --- |
| [pr-tab-grouper/](pr-tab-grouper/) | GitHub の自分の Pull Request タブを、Chrome のタブグループに自動でまとめる |

## 使い方

[Bun](https://bun.sh) が必要です。コマンドはすべてこのルートで実行します。

```sh
bun install

bun run build pr-tab-grouper   # pr-tab-grouper/dist/ を作り直す
bun run dev   pr-tab-grouper   # tsc --watch + html/css/icons の監視
bun run typecheck              # 出力せずに型だけ見る（全拡張機能 + tools）
bun run clean                  # 全拡張機能の dist/ を消す
bun run icons                  # pr-tab-grouper のアイコンを作り直す
```

`build` と `dev` は拡張機能名を省略すると全部が対象になります。名前は
**`manifest.json` を持つルート直下のディレクトリ名**で、`tools/build.ts` が起動時に探します。
登録リストのようなものはありません。

出来上がった `<ext>/dist/` を `chrome://extensions` の
「パッケージ化されていない拡張機能を読み込む」で選んでください。

## 構成

```
package.json           依存関係とコマンド。拡張機能をまたいで 1 つ（node_modules もルートだけ）
tsconfig.base.json     Chrome 拡張機能に共通のコンパイラ設定
tsconfig.tools.json    tools/ と */tools/ の型チェック（実行は Bun が直接 .ts を読む）
tools/
  build.ts             <ext>/dist の組み立て。拡張機能の探索・watch・--check もここ
  icon.ts              PNG の生成（依存なし）。SDF を渡すと 16/32/48/128 を書き出す

<ext>/
  manifest.json        これがあるディレクトリが「拡張機能」として扱われる
  tsconfig.json        tsconfig.base.json を extends する。src/ → dist/src/
  src/                 拡張機能のソース（.ts / .html / .css）
  icons/               生成済み PNG
  tools/               その拡張機能だけのスクリプト（アイコンの図柄など）
  dist/                ビルド成果物。Chrome に読み込ませるのはここ（git 管理外）
```

### ビルドの流れ

`<ext>/tsconfig.json` は `rootDir: "."` / `outDir: "dist"` なので、`tsc` の出力は `<ext>/dist/src/**`
になります。`manifest.json` に書いた `src/background.js` のようなパスを、ビルド後も書き換えずに
そのまま使えるようにするためです。`tsc` が扱わないもの（`manifest.json` / `icons/` /
`src/**/*.html` / `src/**/*.css`）は `tools/build.ts` が `dist/` へコピーします。

バンドラは挟んでいません。`moduleResolution: "bundler"` と `verbatimModuleSyntax` の組み合わせで、
`import './lib/settings.js'` と書くとコンパイル時は `.ts` に解決され、出力にはその `.js` のまま残るので、
ブラウザがそれを読みます。

## 拡張機能を追加する

1. ルートにディレクトリを作り、`manifest.json` と `src/` を置く
2. `tsconfig.json` を置く（これだけで足ります）

   ```json
   {
     "extends": "../tsconfig.base.json",
     "compilerOptions": {
       "types": ["chrome"],
       "rootDir": ".",
       "outDir": "dist"
     },
     "include": ["src"]
   }
   ```

3. `bun run build <ディレクトリ名>`

`package.json` への登録は要りません。アイコンを同じやり方で作るなら、
[pr-tab-grouper/tools/make-icons.ts](pr-tab-grouper/tools/make-icons.ts) を真似て
`tools/icon.ts` の `writeIcons()` に図形を渡してください。
