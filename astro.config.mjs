import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import theme from "@yulab/emdash-theme";

// ページ・部品・プラグイン・見た目の設定は親（@yulab/emdash-theme）が持つ。ここは親を読み込むだけ。
// 変えたい部品やページは custom/ に同じ相対パスで置く（親のコードは node_modules の中なので直さない）。
export default defineConfig({
	adapter: cloudflare(),
	integrations: [theme()],
});
