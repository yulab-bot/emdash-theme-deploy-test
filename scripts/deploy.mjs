#!/usr/bin/env node
// Deploy のコマンド（package.json の "deploy" から呼ぶ。Cloudflare の自動ビルドも、手元の `npm run deploy` も同じ）。
//
//   1. データベースの準備（EmDash の migration）を、`emdash migrate` でリモートの D1 に当てる
//   2. `wrangler deploy` でサイトを出す
//
// テーマの鍵（YULAB_KEY）: ビルドの変数（環境変数）から来たときは、`wrangler deploy --var YULAB_KEY:<値>` で
// 動いているサイトにも渡す（サイトが置き場に新しい版を聞くときに使う）。wrangler.jsonc の vars から来たときは
// 何もしない（そのまま入る）。鍵の置き場を1か所にするため、Worker の秘密の値には入れない。値はログに出さない。
//
// なぜ 1 を先にやるか: サイトが動き出してから最初のアクセスで準備する形（実行時の auto）だと、
// 途中で止まったときに「準備中の札（_emdash_migrations_lock）」が残り、サイトが 503 のまま
// 動かなくなることがあった（段階1の4番）。デプロイのときに済ませておけば、実行時はやることが無い。
// 実行時の auto はそのまま残してある（ここで準備できなかったときの保険）。
//
// `emdash migrate` に要るもの:
//   - `.emdash/migrations.json`（`astro build` が作る。先にビルドが要る）
//   - 環境変数 CLOUDFLARE_API_TOKEN（D1 を書き換えられる権限）
//   - アカウントの ID（環境変数 CLOUDFLARE_ACCOUNT_ID か wrangler.jsonc の account_id）
//   - D1 の指定: wrangler.jsonc の binding "DB" の database_id（あれば）か database_name
//     （Deploy ボタンが作った直後は ID が無いことがあるので、無ければ名前で探す）
//
// 足りないものがあるときは、理由を出して準備を飛ばし、デプロイだけ進める（実行時の auto に任せる）。
// 準備そのものが失敗したときは止める（途中までの状態で出さない）。
// 環境変数 EMDASH_DEPLOY_MIGRATE=skip で、準備を丸ごと飛ばせる。
//
// 秘密の値（トークンなど）はログに出さない。「ある・ない」だけ出す。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D1_BINDING = "DB";
const WRANGLER_CONFIG = "wrangler.jsonc";
const MANIFEST = ".emdash/migrations.json";
// 準備中の札がこれより古ければ、止まったまま残っていると見て引き取る（実行中の準備は1分もかからない）
const STUCK_LOCK_MS = 10 * 60 * 1000;

const log = (msg) => console.log(`[deploy] ${msg}`);
const warn = (msg) => console.warn(`[deploy] 注意: ${msg}`);

function bin(name) {
	const local = resolve(ROOT, "node_modules/.bin", name);
	return existsSync(local) ? local : name;
}

function run(name, args, { capture = false } = {}) {
	const result = spawnSync(bin(name), args, {
		cwd: ROOT,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		encoding: "utf8",
		env: process.env,
	});
	if (result.error) throw result.error;
	return result;
}

/** wrangler.jsonc を wrangler 自身の読み方で読む（コメントや環境の扱いを合わせるため） */
async function readWranglerConfig() {
	const require = createRequire(resolve(ROOT, "package.json"));
	const wrangler = await import(pathToFileURL(require.resolve("wrangler")).href);
	if (typeof wrangler.unstable_readConfig !== "function") {
		throw new Error("wrangler の設定の読み込み（unstable_readConfig）が使えません");
	}
	return wrangler.unstable_readConfig({ config: resolve(ROOT, WRANGLER_CONFIG) }, { hideWarnings: true });
}

/** 準備（migrate）の対象を決める。足りなければ理由（文字列）を返す */
async function resolveMigrateTarget() {
	if (!existsSync(resolve(ROOT, MANIFEST))) {
		return { skip: `${MANIFEST} がありません。先に \`astro build\` を動かしてください` };
	}
	const config = await readWranglerConfig();
	const bindings = (config.d1_databases ?? []).filter((d) => d.binding === D1_BINDING);
	if (bindings.length !== 1) {
		return { skip: `${WRANGLER_CONFIG} に binding "${D1_BINDING}" の D1 がちょうど1つ必要です（今 ${bindings.length} 個）` };
	}
	const db = bindings[0];
	const selector = db.database_id || db.database_name;
	if (!selector) return { skip: `${WRANGLER_CONFIG} の D1 に database_id も database_name もありません` };
	log(`D1: ${db.database_id ? "ID で指定" : `名前で指定（${db.database_name}）`}`);

	const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
	log(`CLOUDFLARE_API_TOKEN: ${hasToken ? "あり" : "なし"}`);
	if (!hasToken) return { skip: "環境変数 CLOUDFLARE_API_TOKEN がありません（D1 を書き換えられる権限のトークンが要ります）" };

	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || config.account_id;
	log(`アカウント ID: ${process.env.CLOUDFLARE_ACCOUNT_ID ? "環境変数" : config.account_id ? WRANGLER_CONFIG : "なし"}`);
	if (!accountId) return { skip: "アカウントの ID がありません（環境変数 CLOUDFLARE_ACCOUNT_ID か wrangler.jsonc の account_id）" };

	return { args: ["--d1", selector, "--account-id", accountId] };
}

/** `emdash migrate --status --json` で、いまの状態（fingerprint・残り・札）を取る */
function migrateStatus(targetArgs) {
	const r = run("emdash", ["migrate", "--status", "--json", ...targetArgs], { capture: true });
	if (r.status !== 0) {
		const reason = (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() ?? `exit ${r.status}`;
		return { error: reason };
	}
	try {
		return { report: JSON.parse(r.stdout.trim().split("\n").pop()) };
	} catch {
		return { error: "状態の JSON が読めませんでした" };
	}
}

async function migrate() {
	if (process.env.EMDASH_DEPLOY_MIGRATE === "skip") {
		warn("EMDASH_DEPLOY_MIGRATE=skip なので、データベースの準備を飛ばします");
		return;
	}
	const target = await resolveMigrateTarget();
	if (target.skip) {
		warn(`データベースの準備を飛ばします: ${target.skip}`);
		warn("サイトが動き出したあと、最初のアクセスで自動で準備されます（実行時の auto）");
		return;
	}

	log("データベースの状態を確かめています…");
	const status = migrateStatus(target.args);
	if (status.error) {
		if (/No D1 database named/.test(status.error)) {
			warn(`D1 がまだ無いので、データベースの準備を飛ばします（${status.error}）`);
		} else {
			warn(`データベースの状態を確かめられなかったので、準備を飛ばします: ${status.error}`);
		}
		warn("サイトが動き出したあと、最初のアクセスで自動で準備されます（実行時の auto）");
		return;
	}

	const { report } = status;
	const fingerprint = report.target?.fingerprint;
	if (!fingerprint) throw new Error("対象の fingerprint が取れませんでした");
	log(`対象: ${report.target.label}`);
	log(`済み ${report.knownApplied.length} 件、残り ${report.pending.length} 件、知らないもの ${report.unknownApplied.length} 件`);

	if (report.unknownApplied.length > 0) {
		warn(`このビルドが知らない準備がデータベースに入っています（${report.unknownApplied.join(", ")}）。新しい EmDash で準備されたデータベースに古い版を出そうとしていませんか。ここでは何もしません`);
		return;
	}

	let lockArgs = [];
	if (report.lock) {
		const ageMs = Date.now() - Date.parse(report.lock.heldSince);
		if (ageMs > STUCK_LOCK_MS) {
			warn(`準備中の札が ${Math.round(ageMs / 60000)} 分前から残っています（id ${report.lock.id}）。止まったまま残っていると見て、引き取って準備を進めます`);
			lockArgs = ["--take-over-lock", report.lock.id];
		} else {
			log(`別の準備が動いています（${Math.round(ageMs / 1000)} 秒前から）。終わるのを待ってから進めます`);
		}
	}

	if (report.pending.length === 0 && lockArgs.length === 0) {
		log("データベースの準備はもう済んでいます");
		return;
	}

	log(`データベースの準備を当てます（${report.pending.length} 件）…`);
	const r = run("emdash", ["migrate", "--expected-target-fingerprint", fingerprint, ...lockArgs, ...target.args]);
	if (r.status !== 0) {
		throw new Error(`データベースの準備が失敗しました（exit ${r.status}）。上のメッセージを見てください。直せないときは EMDASH_DEPLOY_MIGRATE=skip で飛ばせます`);
	}
	log("データベースの準備ができました");
}

async function main() {
	// Cloudflare の自動ビルドは、ビルドのコマンド（astro build）のあとにこれを動かすので、ビルドは済んでいる。
	// 手元で `npm run deploy` だけを動かしたときのために、ビルドの結果が無ければここでビルドする
	if (!existsSync(resolve(ROOT, "dist/server/wrangler.json")) || !existsSync(resolve(ROOT, MANIFEST))) {
		log("ビルドの結果が無いので、先にビルドします…");
		// テーマ（親）を受け取ってから（package.json の "build" と同じ順）
		const p = spawnSync(process.execPath, [resolve(ROOT, "scripts/yulab-parent.mjs")], { cwd: ROOT, stdio: "inherit", env: process.env });
		if (p.status !== 0) throw new Error(`テーマを受け取れませんでした（exit ${p.status}）`);
		const b = run("astro", ["build"]);
		if (b.status !== 0) throw new Error(`ビルドが失敗しました（exit ${b.status}）`);
	}
	await migrate();
	const keyArgs = [];
	const envKey = (process.env.YULAB_KEY ?? "").trim();
	if (envKey) {
		keyArgs.push("--var", `YULAB_KEY:${envKey}`);
		log("鍵: 環境変数（動いているサイトにも --var で渡します）");
	} else {
		const config = await readWranglerConfig().catch(() => null);
		log(`鍵: ${typeof config?.vars?.YULAB_KEY === "string" && config.vars.YULAB_KEY.trim() ? "wrangler.jsonc（そのまま入ります）" : "なし"}`);
	}
	log("wrangler deploy を動かします…");
	const r = run("wrangler", ["deploy", ...keyArgs, ...process.argv.slice(2)]);
	process.exit(r.status ?? 1);
}

main().catch((error) => {
	console.error(`[deploy] NG: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
