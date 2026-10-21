# このリポジトリで AI が守ること

このリポジトリは EmDash（Astro で動く CMS）のサイトです。見た目と機能はテーマ（親）`@yulab/emdash-theme` が持ち、ビルドのときに `node_modules` に入ります。このリポジトリにあるのは、持ち主のカスタマイズ `custom/` と設定だけです。

## 直してよい場所は `custom/` だけ

- 書く・直す・消すのは `custom/` の中だけ。
- `node_modules/` の中は直さない。ビルドのたびに入れ直されて消える。親のファイルは読んで参考にするだけ。
- `package.json` の `"@yulab/emdash-theme"` の行は手で触らない。管理画面の「サイトの更新」ボタンが書き換える（更新・戻す）。
- `astro.config.mjs`・`wrangler.jsonc`・`src/`・`scripts/`・`seed/` は、持ち主にはっきり頼まれたときだけ。普通のカスタマイズでは触らない。

## 部品（デザイン）を変える: 親のファイルを `custom/` に写して直す

親の部品は `node_modules/@yulab/emdash-theme/theme/` にある。`custom/` に同じ相対パスで置くと、そちらが使われる（WordPress の子テーマと同じ）。

1. 親のファイルを探す: `node_modules/@yulab/emdash-theme/theme/<場所>/<名前>.astro`
2. `custom/<場所>/<名前>.astro` に写す（`theme/` からの相対パスをそろえる）
3. `custom/` 側を直す

例: ヘッダーを変える → `node_modules/@yulab/emdash-theme/theme/components/SiteHeader.astro` を `custom/components/SiteHeader.astro` に写して直す。

- 親の中では部品を `@theme/components/SiteHeader.astro` のように `@theme/` で読んでいる。`@theme/` は `custom/` → 親の順に探される。写したファイルの中の `@theme/...` の import はそのままでよい。
- `custom/` のファイルを消すと親に戻る。
- 差し替えた部品には、その部品の親の更新は届かない（直すか消せば合う）。

## ページを足す・差し替える: `custom/pages/`

- 新しいページ: `custom/pages/` に置く。`src/pages/` と同じ決まりで URL になる（例 `custom/pages/works/index.astro` → `/works`、`custom/pages/works/[slug].astro` → `/works/...`）。
- 親のページを差し替える: 親の `theme/pages/` と同じ相対パスで `custom/pages/` に置く（例 `custom/pages/index.astro` でトップ）。
- 手元の dev（`pnpm dev`）で `custom/pages/` のファイルを足した・消したときは、dev を止めてもう一度動かす（ページの一覧は起動時に決まる）。部品の差し替えと、ファイルの中身の修正はすぐ反映される。

## 記事・固定ページ・設定はコードではない

記事、固定ページ、メニュー、サイト名、コレクション（入れ物）の形は、管理画面（`/_emdash/admin`）か MCP（`/_emdash/api/mcp`）で変える。ファイルは増えない。コードで直すのは「見せ方」だけ。

- 新しい種類のデータ（例 Works）を足すとき: (1) 管理画面か MCP でコレクションを作り、中身を入れる (2) 一覧と1件のページを `custom/pages/works/` に作る。
- 中身の取り方（コレクションの読み方、Portable Text の描き方）は親のページ（`node_modules/@yulab/emdash-theme/theme/pages/`）を見本にする。EmDash の公式の説明は https://docs.emdashcms.com/ 。

## 動かし方

```bash
pnpm install
pnpm dev          # http://localhost:4321 （管理画面は /_emdash/admin）
pnpm build        # ビルドが通るか確かめる
```

- 手元で動かすには `.dev.vars`（`.dev.vars.example` を写して値を入れる）が要る。`.dev.vars` は Git に入れない。
- Cloudflare への反映は GitHub に push すれば自動（ビルド → データベースの準備 → デプロイ）。`wrangler deploy` を手で動かさない。

## 困ったとき

- `custom/` で何をしても、崩れるのはこのサイトのその部分だけ。ファイルを消すか、Git の履歴で戻せば親に戻る。
- 親のコードを直したくなったら、それはテーマ側の仕事。`custom/` で差し替えるか、持ち主に伝える。
