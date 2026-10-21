// wrangler.jsonc の main。中身は親（@yulab/emdash-theme/worker）にあり、ここは再輸出するだけ。
// wrangler の main はサイトのリポジトリの中のファイルを指す必要があるため、この薄い包みは残る。
export { default, PluginBridge } from "@yulab/emdash-theme/worker";
