#!/usr/bin/env node
// テーマ（親）を置き場から鍵を付けて受け取り、インストーラーで入れる。
// package.json の "build" と "dev" の最初に動く（`node scripts/yulab-parent.mjs && astro build`）。
//
// このファイルはサイトのリポジトリに残り、「サイトの更新」では新しくならない。
// だから変わりうるもの（置き場の URL・版）はここに書かず、package.json の "yulab" の欄から読む:
//   "yulab": { "@yulab/emdash-theme": "<置き場>/parent/yulab-emdash-theme-<版>.tgz" }
// （「サイトの更新」はこの1行の版の番号だけを書き換える）
//
// 鍵（YULAB_KEY）の読み先（先にあるほう）:
//   1. 環境変数 YULAB_KEY（Cloudflare のビルドの変数）
//   2. wrangler.jsonc の vars.YULAB_KEY（Deploy ボタンの画面の欄。wrangler 自身の読み方で読む）
// 鍵の値はログに出さない。出すのは「どこから来たか」だけ。
//
// 入れ方: 受け取った .tgz を、いま動いているインストーラー（bun・pnpm・npm）に渡す。
// node_modules に手で広げないのは、親が頼る依存（zod など）もインストーラーに解決させるため。
// package.json と lock は書き換えない（書き換えると「サイトの更新」の書き換えとぶつかる）。
// --no-save の無いインストーラー（pnpm）もあるので、前の中身を覚えておき、変わっていたら元に戻す。

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "@yulab/emdash-theme";
const TGZ_DIR = resolve(ROOT, ".yulab");
const MARK = resolve(ROOT, "node_modules/.yulab-parent.json");
// インストーラーが書き換えることがあるファイル（変わっていたら元に戻す）
const KEEP = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock"];

const log = (m) => console.log(`[yulab] ${m}`);
function stop(reason, hint) {
	console.error(`[yulab] 止めました: ${reason}`);
	if (hint) console.error(`[yulab] ${hint}`);
	process.exit(1);
}

/** 鍵を探す。値は返すが、ログには出さない */
async function findKey() {
	const fromEnv = (process.env.YULAB_KEY ?? "").trim();
	if (fromEnv) return { key: fromEnv, from: "環境変数" };
	try {
		const require = createRequire(resolve(ROOT, "package.json"));
		const wrangler = await import(pathToFileURL(require.resolve("wrangler")).href);
		const config = wrangler.unstable_readConfig({ config: resolve(ROOT, "wrangler.jsonc") }, { hideWarnings: true });
		const v = config.vars?.YULAB_KEY;
		if (typeof v === "string" && v.trim()) return { key: v.trim(), from: "wrangler.jsonc" };
	} catch (e) {
		log(`wrangler.jsonc を読めませんでした（${e instanceof Error ? e.message.split("\n")[0] : e}）`);
	}
	return { key: null, from: "なし" };
}

/** いま動いているインストーラー（bun・pnpm・npm）を見分ける */
function detectInstaller() {
	const ua = process.env.npm_config_user_agent ?? "";
	for (const pm of ["bun", "pnpm", "npm"]) if (ua.startsWith(`${pm}/`)) return { pm, by: "実行中のコマンド" };
	const has = (f) => existsSync(resolve(ROOT, f));
	if (has("bun.lock") || has("bun.lockb")) return { pm: "bun", by: "lock" };
	if (has("pnpm-lock.yaml") || has("node_modules/.modules.yaml")) return { pm: "pnpm", by: "lock" };
	if (has("package-lock.json") || has("node_modules/.package-lock.json")) return { pm: "npm", by: "lock" };
	return { pm: "npm", by: "既定" };
}

const INSTALL_ARGS = {
	bun: (tgz) => ["add", "--no-save", tgz],
	// pnpm には --no-save が無い。書き換えたファイルは下で元に戻す
	pnpm: (tgz) => ["add", tgz],
	npm: (tgz) => ["install", "--no-save", "--no-audit", "--no-fund", tgz],
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const snapshot = () => Object.fromEntries(KEEP.map((f) => [f, existsSync(resolve(ROOT, f)) ? readFileSync(resolve(ROOT, f)) : null]));
const readJson = (p) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch {
		return null;
	}
};

async function main() {
	const pkg = readJson(resolve(ROOT, "package.json"));
	const spec = pkg?.yulab?.[NAME];
	if (typeof spec !== "string" || !spec) stop(`package.json の "yulab" の欄に "${NAME}" の行がありません`);
	const file = spec.split("/").pop();
	const version = file.match(/^yulab-emdash-theme-([0-9][A-Za-z0-9.+-]*)\.tgz$/)?.[1];
	if (!version) stop(`親の指定から版の番号が読めません（${file}）`);

	// 1. 受け取る（手元のファイル file: のときは鍵を使わない。正本で作るとき用）
	let body;
	if (spec.startsWith("file:")) {
		log("鍵: 使わない（手元のファイル）");
		const p = resolve(ROOT, spec.slice(5));
		if (!existsSync(p)) stop(`親のファイルがありません（${spec}）`);
		body = readFileSync(p);
	} else {
		const { key, from } = await findKey();
		log(`鍵: ${from}`);
		if (!key) {
			stop(
				"テーマを受け取るための鍵（YULAB_KEY）がありません。",
				"Cloudflare の画面で YULAB_KEY に、受け取った鍵を1行だけ貼ってから、もう一度デプロイしてください。",
			);
		}
		if (!/^[\x21-\x7e]{8,512}$/.test(key)) stop("鍵の形が違います。", "空白や改行が入らないように、鍵を1行だけ貼り直してください。");
		let res;
		try {
			res = await fetch(spec, { headers: { authorization: `Bearer ${key}`, "user-agent": `yulab-parent/${version}` } });
		} catch (e) {
			stop(`テーマの置き場につながりませんでした（${e instanceof Error ? e.message : e}）。`, "しばらくしてからもう一度デプロイしてください。");
		}
		if (res.status === 401 || res.status === 403) {
			stop(`テーマの置き場が鍵を受け付けませんでした（${res.status}）。`, "鍵が正しいか（1文字も欠けていないか）、止められていないかを確かめてください。");
		}
		if (res.status === 404) stop(`テーマの版 ${version} が置き場にありません（404）。`);
		if (!res.ok) stop(`テーマを受け取れませんでした（${res.status}）。`, "しばらくしてからもう一度デプロイしてください。");
		body = Buffer.from(await res.arrayBuffer());
	}
	const hash = sha256(body);

	// 2. もう同じものが入っていれば、入れ直さない（手元の dev で毎回入れないように）
	const mark = readJson(MARK);
	const installed = readJson(resolve(ROOT, "node_modules", NAME, "package.json"));
	if (mark?.sha256 === hash && installed?.version === version) {
		log(`親 ${version} はもう入っています`);
		return;
	}

	// 3. インストーラーに渡す
	mkdirSync(TGZ_DIR, { recursive: true });
	const tgz = resolve(TGZ_DIR, file);
	writeFileSync(tgz, body);
	const { pm, by } = detectInstaller();
	log(`親 ${version} を入れます（${pm}。${by}で判断）`);
	const before = snapshot();
	const r = spawnSync(pm, INSTALL_ARGS[pm](`./.yulab/${file}`), { cwd: ROOT, stdio: "inherit", env: process.env });
	// package.json と lock は書き換えない（変わっていたら元に戻す）
	const after = snapshot();
	for (const f of KEEP) {
		const a = before[f];
		const b = after[f];
		if (a && (!b || !a.equals(b))) {
			writeFileSync(resolve(ROOT, f), a);
			log(`${f} を元に戻しました`);
		} else if (!a && b) {
			// 前は無かったファイル（インストーラーが作った lock）は残さない
			rmSync(resolve(ROOT, f));
			log(`${f}（インストーラーが作ったもの）を消しました`);
		}
	}
	if (r.error) stop(`インストーラー ${pm} を動かせませんでした（${r.error.message}）。`);
	if (r.status !== 0) stop(`インストーラー ${pm} が失敗しました（exit ${r.status}）。上のメッセージを見てください。`);

	// 4. 入ったかを確かめる（親と、親が頼る依存）
	const got = readJson(resolve(ROOT, "node_modules", NAME, "package.json"));
	if (got?.version !== version) stop(`親 ${version} が入っていません（${got?.version ?? "無し"}）。`);
	// pnpm では親は .pnpm の中への link なので、実体の場所から探す（依存はその隣にある）
	const req = createRequire(realpathSync(resolve(ROOT, "node_modules", NAME, "package.json")));
	for (const dep of Object.keys(got.dependencies ?? {})) {
		try {
			req.resolve(`${dep}/package.json`);
		} catch {
			stop(`親が頼る ${dep} が入っていません。`);
		}
	}
	writeFileSync(MARK, JSON.stringify({ version, sha256: hash }) + "\n");
	log(`親 ${version} を入れました`);
}

main().catch((e) => stop(e instanceof Error ? e.message : String(e)));
