// scripts/build_ai_index.mjs
// Builds repo-wide indices (ai-index.*), browsable lists, targeted inline packs,
// sharded "everything" packs, and a combined "all" pack with HTML/TXT mirrors.
// Safer defaults for large data, plus JSON shape hints for very large files.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------------- git + repo meta ----------------
function safeExec(cmd, def = "") {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore","pipe","ignore"] }).trim(); }
  catch { return def; }
}

const repo = process.env.GITHUB_REPOSITORY
  || safeExec("git config --get remote.origin.url")
      .replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
const commit = process.env.GITHUB_SHA || safeExec("git rev-parse HEAD");
const branch = process.env.GITHUB_REF_NAME || safeExec("git rev-parse --abbrev-ref HEAD") || "main";
const updatedUtc = new Date().toISOString();

if (!repo) {
  console.warn("[build_ai_index] Could not determine repo; continuing with minimal metadata.");
}

// ---------------- helpers ----------------
function enc(p){ return p.split("/").map(encodeURIComponent).join("/"); }
function mediaTypeFor(p){
  const ext = p.toLowerCase().split(".").pop();
  const map = {
    json:"application/json", schema:"application/json",
    js:"application/javascript", mjs:"application/javascript",
    css:"text/css", html:"text/html", md:"text/markdown", mdx:"text/markdown", txt:"text/plain",
    svg:"image/svg+xml", png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", ico:"image/x-icon",
    pdf:"application/pdf", xml:"application/xml", yml:"text/yaml", yaml:"text/yaml"
  };
  return map[ext] || "application/octet-stream";
}
function sha256(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); }
function ensureDocs(){ fs.mkdirSync("docs", { recursive: true }); }

// ---------------- gather all tracked files at this commit ----------------
function filesFromGitTree(gitCommit) {
  const raw = safeExec(`git ls-tree -r --long ${gitCommit}`);
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\d+\s+\w+\s+([0-9a-f]{40})\s+(\d+)\t(.+)$/);
    if (!m) continue;
    const [, blobSha, sizeStr, filePath] = m;
    if (filePath.startsWith(".git/")) continue;
    const raw_url  = `https://raw.githubusercontent.com/${repo}/${commit}/${enc(filePath)}`;
    const html_url = `https://github.com/${repo}/blob/${commit}/${enc(filePath)}`;
    out.push({ path:filePath, size:Number(sizeStr), git_blob_sha:blobSha, media_type:mediaTypeFor(filePath), raw_url, html_url });
  }
  return out;
}
// Fallback (rare): walk working dir if git tree fails
function walk(dir){
  const ents = fs.readdirSync(dir, { withFileTypes:true });
  const list = [];
  for (const e of ents){
    const p = path.join(dir, e.name);
    if (p.startsWith(".git")) continue;
    if (e.isDirectory()) list.push(...walk(p));
    else {
      const stat = fs.statSync(p);
      list.push({
        path: p.replace(/^[.][/\\]*/,""),
        size: stat.size,
        git_blob_sha: "", // unknown outside git
        media_type: mediaTypeFor(p),
        raw_url: `https://raw.githubusercontent.com/${repo}/${commit}/${enc(p)}`,
        html_url:`https://github.com/${repo}/blob/${commit}/${enc(p)}`
      });
    }
  }
  return list;
}

let files = filesFromGitTree(commit);
if (!files.length) {
  console.warn("[build_ai_index] git ls-tree returned no files; falling back to FS walk.");
  files = walk(".");
}

// ---------------- master index ----------------
ensureDocs();
const index = {
  schema: "barkday.ai-index.v1",
  repo, default_branch: branch, commit, updated_utc: updatedUtc,
  files_count: files.length,
  total_bytes: files.reduce((a,f)=>a+f.size, 0),
  files
};
fs.writeFileSync("docs/ai-index.json", JSON.stringify(index, null, 2));
fs.writeFileSync("docs/ai-index.min.json", JSON.stringify(index));
console.log(`Wrote docs/ai-index.(json|min.json) with ${files.length} entries`);

// ---------------- simple list writer (json + min.json + html) ----------------
function writeList({title, outBase, predicate}) {
  const subset = files.filter(predicate);
  const list = {
    schema: `barkday.${outBase}.v1`,
    repo, commit, updated_utc: updatedUtc,
    count: subset.length,
    files: subset.map(({path: p, size, git_blob_sha, raw_url, html_url}) => ({
      path: p, size, sha: git_blob_sha, raw_url, html_url
    }))
  };
  fs.writeFileSync(`docs/${outBase}.json`, JSON.stringify(list, null, 2));
  fs.writeFileSync(`docs/${outBase}.min.json`, JSON.stringify(list));

  const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const rows = subset.map(f =>
    `<tr><td class="mono">${esc(f.path)}</td><td>${f.size}</td><td><a href="${f.raw_url}" target="_blank" rel="noopener">raw</a></td><td><a href="${f.html_url}" target="_blank" rel="noopener">view</a></td></tr>`
  ).join("\n") || `<tr><td colspan="4">No matching files.</td></tr>`;

  const html = `<!doctype html><meta charset="utf-8"><title>Barkday • ${esc(title)}</title>
<style>
  body{font:14px system-ui;margin:24px;max-width:1100px}
  table{width:100%;border-collapse:collapse}
  th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}
  .mono{font-family:ui-monospace,Consolas,monospace}
</style>
<h1>${esc(title)} (${subset.length})</h1>
<p><small>Commit <code>${commit.slice(0,7)}</code> • ${updatedUtc}</small></p>
<table><thead><tr><th>Path</th><th>Size</th><th>Raw</th><th>HTML</th></tr></thead><tbody>
${rows}
</tbody></table>`;
  fs.writeFileSync(`docs/${outBase}.html`, html);

  console.log(`Wrote docs/${outBase}.(html|json|min.json) with ${subset.length} entries`);
}

writeList({
  title: "docs/*.md Markdown files",
  outBase: "ai-docs-list",
  predicate: f => f.path.startsWith("docs/") && /\.mdx?$/i.test(f.path)
});
writeList({
  title: "data/*.md Markdown files",
  outBase: "ai-data-list",
  predicate: f => f.path.startsWith("data/") && /\.mdx?$/i.test(f.path)
});
writeList({
  title: "data/*.json, *.yaml, *.yml files",
  outBase: "ai-data-config-list",
  predicate: f => f.path.toLowerCase().startsWith("data/") && /\.(json|ya?ml)$/i.test(f.path)
});

// ---------------- inline limits + policy ----------------
const TEXT_EXT = new Set(["md","mdx","json","js","mjs","css","html","yml","yaml","txt","svg"]);
const INLINE_TEXT_BYTES  = 600 * 1024;   // inline full text <= 600 KB
const INLINE_BIN_BYTES   = 200 * 1024;   // inline full binary <= 200 KB (base64)
const PREVIEW_TEXT_BYTES = 64  * 1024;   // if too large for full, include this much preview

// Always inline full for docs/*.md, but NOT every data file by default (keeps packs lean).
const ALWAYS_TEXT_FULL_DIRS = [ /^docs\//i ];
const ALWAYS_TEXT_FULL_PATHS = new Set([
  // explicitly required data/config for automation
  "dog-gifts.json",
  "dog-gifts.schema.json"
]);
function alwaysFullText(p){
  if (ALWAYS_TEXT_FULL_PATHS.has(p)) return true;
  return ALWAYS_TEXT_FULL_DIRS.some(rx => rx.test(p));
}

// low-level git blob read
function execSyncBuffer(cmd){ return execSync(cmd, { encoding: "buffer", stdio: ["ignore","pipe","inherit"]}); }
function gitShow(p){
  try { return execSyncBuffer(`git show ${commit}:${p}`); }
  catch { return fs.readFileSync(p); }
}

// ---------------- optional JSON shape hints for large files ----------------
function jsonShapeHint(buf){
  try {
    const text = buf.toString("utf8");
    const data = JSON.parse(text);
    const hint = { type: Array.isArray(data) ? "array" : (data && typeof data === "object" ? "object" : typeof data) };
    if (Array.isArray(data)) {
      hint.length = data.length;
      hint.sample = data.slice(0, Math.min(3, data.length));
    } else if (data && typeof data === "object") {
      hint.keys = Object.keys(data).slice(0, 12);
    }
    return hint;
  } catch {
    return undefined;
  }
}

// ---------------- generic inline pack writer ----------------
const PACK_CATALOG = []; // collect emitted packs for a small catalog at the end

function writePack({title, outBase, predicate}){
  const subset = files.filter(predicate);
  const items = [];
  for (const f of subset){
    const ext = (f.path.split(".").pop()||"").toLowerCase();
    const isText = TEXT_EXT.has(ext);
    const mustFull = isText && alwaysFullText(f.path);

    let inline_state = "none";   // "full" | "preview" | "none"
    let encoding, content, content_sha, meta;

    try {
      const buf = gitShow(f.path);
      if (isText) {
        if (mustFull || f.size <= INLINE_TEXT_BYTES) {
          inline_state = "full"; encoding = "utf8"; content = buf.toString("utf8");
          content_sha = sha256(buf);
        } else if (PREVIEW_TEXT_BYTES > 0) {
          inline_state = "preview"; encoding = "utf8"; content = buf.slice(0, PREVIEW_TEXT_BYTES).toString("utf8");
          content_sha = sha256(buf); // hash of full file (even if preview)
          if (ext === "json") meta = { json_hint: jsonShapeHint(buf) };
        }
      } else if (f.size <= INLINE_BIN_BYTES) {
        inline_state = "full"; encoding = "base64"; content = buf.toString("base64");
        content_sha = sha256(buf);
      }
    } catch { /* metadata only */ }

    const item = {
      path: f.path,
      size: f.size,
      sha: f.git_blob_sha,
      media_type: f.media_type,
      raw_url: f.raw_url,
      html_url: f.html_url,
      inline_state,
      max_inline_text_bytes: INLINE_TEXT_BYTES,
      max_inline_bin_bytes:  INLINE_BIN_BYTES,
      preview_text_bytes:    PREVIEW_TEXT_BYTES
    };
    if (inline_state !== "none"){
      item.encoding = encoding;
      item.content  = content;
      item.inline_bytes = typeof content === "string" ? content.length : 0;
      item.content_sha256 = content_sha;
      if (meta) Object.assign(item, meta);
    }
    items.push(item);
  }

  const pack = { schema: `barkday.${outBase}.v1`, repo, commit, updated_utc: updatedUtc, count: items.length, items };
  const pretty = JSON.stringify(pack, null, 2);
  const min    = JSON.stringify(pack);

  fs.writeFileSync(`docs/${outBase}.json`, pretty);
  fs.writeFileSync(`docs/${outBase}.min.json`, min);
  fs.writeFileSync(`docs/${outBase}.txt`, min); // TXT mirror for JSON-hostile clients
  console.log(`Wrote docs/${outBase}.(json|min.json|txt) with ${items.length} items`);

  PACK_CATALOG.push({ name: outBase, count: items.length, bytes_min: min.length, files: [
    `docs/${outBase}.json`, `docs/${outBase}.min.json`, `docs/${outBase}.txt`
  ]});
}

// ---------------- targeted packs ----------------
const CORE_SET = new Set([
  "index.html",
  "app.js",
  "app-pdf.js",
  "app-curves-inline.js",
  "app-celebrate.js",
  "service-worker.js",
  "js/runtime-fetch.js",
  "dog-gifts.json",
  "dog-gifts.schema.json",
  // added for UI/Core access in packs
  "style.css",
  "manifest.json"
]);

writePack({
  title: "docs/*.md (inline)",
  outBase: "ai-pack-docs",
  predicate: f => f.path.startsWith("docs/") && /\.mdx?$/i.test(f.path)
});
writePack({
  title: "data/*.json|*.yaml (inline selectively)",
  outBase: "ai-pack-data-config",
  predicate: f => f.path.toLowerCase().startsWith("data/") && /\.(json|ya?ml)$/i.test(f.path)
});
writePack({
  title: "core app/source files (inline)",
  outBase: "ai-pack-core",
  predicate: f => CORE_SET.has(f.path)
});
writePack({
  title: ".github/workflows/*.yml (inline)",
  outBase: "ai-pack-ci",
  predicate: f => f.path.startsWith(".github/workflows/") && /\.ya?ml$/i.test(f.path)
});

// ---------------- SHARDED "EVERYTHING" PACK ----------------
const SHARD_TARGET_BYTES = 4 * 1024 * 1024;  // ~4 MB minified JSON per shard
const SHARD_MAX_ITEMS    = 500;

function isTextPath(p){
  const ext = (p.split('.').pop()||'').toLowerCase();
  return TEXT_EXT.has(ext) || /^text\//.test(mediaTypeFor(p));
}

function writeEverythingSharded(){
  // exclude generated outputs and git internals
  const subset = files.filter(f =>
    !f.path.startsWith('docs/ai-') &&
    !f.path.startsWith('.git/')
  );

  let items = [], bytes = 0, shardIdx = 1;
  const shards = [];

  function flush(){
    if (!items.length) return;
    const name = `ai-pack-everything-${String(shardIdx).padStart(4,'0')}`;
    const pack = {
      schema: "barkday.ai-pack-everything.v1",
      repo, commit, updated_utc: updatedUtc,
      count: items.length,
      items
    };
    const pretty = JSON.stringify(pack, null, 2);
    const min    = JSON.stringify(pack);
    fs.writeFileSync(`docs/${name}.json`, pretty);
    fs.writeFileSync(`docs/${name}.min.json`, min);
    fs.writeFileSync(`docs/${name}.txt`,  min);
    shards.push({ name, count: items.length, approx_bytes: min.length });
    shardIdx++; items = []; bytes = 0;
    console.log(`Wrote docs/${name}.(json|min.json|txt)  items=${pack.count}`);
  }

  for (const f of subset){
    let inline_state = "none", encoding, content, content_sha, meta;

    try {
      const buf = gitShow(f.path);
      if (isTextPath(f.path)) {
        if (alwaysFullText(f.path) || f.size <= INLINE_TEXT_BYTES) {
          inline_state = "full"; encoding = "utf8"; content = buf.toString("utf8");
          content_sha = sha256(buf); bytes += content.length;
        } else if (PREVIEW_TEXT_BYTES > 0) {
          inline_state = "preview"; encoding = "utf8"; content = buf.slice(0, PREVIEW_TEXT_BYTES).toString("utf8");
          content_sha = sha256(buf); bytes += content.length;
          if (/\.(json)$/i.test(f.path)) meta = { json_hint: jsonShapeHint(buf) };
        }
      } else if (f.size <= INLINE_BIN_BYTES) {
        inline_state = "full"; encoding = "base64"; content = buf.toString("base64");
        content_sha = sha256(buf); bytes += content.length;
      }
    } catch { /* metadata only */ }

    const item = {
      path: f.path,
      size: f.size,
      sha:  f.git_blob_sha,
      media_type: f.media_type,
      raw_url:  f.raw_url,
      html_url: f.html_url,
      inline_state,
      max_inline_text_bytes: INLINE_TEXT_BYTES,
      max_inline_bin_bytes:  INLINE_BIN_BYTES,
      preview_text_bytes:    PREVIEW_TEXT_BYTES
    };
    if (inline_state !== "none"){
      item.encoding = encoding;
      item.content  = content;
      item.inline_bytes = typeof content === "string" ? content.length : 0;
      item.content_sha256 = content_sha;
      if (meta) Object.assign(item, meta);
    }

    items.push(item);
    if (bytes >= SHARD_TARGET_BYTES || items.length >= SHARD_MAX_ITEMS) flush();
  }
  flush();

  // Manifest + HTML index
  const manifest = {
    schema: "barkday.ai-pack-everything.manifest.v1",
    repo, commit, updated_utc: updatedUtc,
    shards: shards.map(s => ({
      name: s.name,
      count: s.count,
      approx_bytes: s.approx_bytes,
      url_json: `docs/${s.name}.min.json`,
      url_txt:  `docs/${s.name}.txt`
    }))
  };
  fs.writeFileSync("docs/ai-pack-everything.manifest.json",     JSON.stringify(manifest, null, 2));
  fs.writeFileSync("docs/ai-pack-everything.manifest.min.json", JSON.stringify(manifest));

  const rows = shards.map(s =>
    `<tr><td><code>${s.name}</code></td><td>${s.count}</td><td>${s.approx_bytes}</td><td><a href="${s.name}.txt" target="_blank">txt</a> · <a href="${s.name}.min.json" target="_blank">json</a></td></tr>`
  ).join("\n") || `<tr><td colspan="4">No shards emitted.</td></tr>`;

  const html = `<!doctype html><meta charset="utf-8">
  <title>Barkday • ai-pack-everything</title>
  <style>body{font:14px system-ui;margin:24px;max-width:1100px} table{width:100%;border-collapse:collapse} th,td{border-bottom:1px solid #eee;padding:8px;text-align:left} code{font-family:ui-monospace,Consolas,monospace}</style>
  <h1>ai-pack-everything</h1>
  <p><small>Commit <code>${commit.slice(0,7)}</code> • ${updatedUtc}</small></p>
  <table><thead><tr><th>Shard</th><th>Items</th><th>~Bytes</th><th>Links</th></tr></thead><tbody>
  ${rows}
  </tbody></table>`;
  fs.writeFileSync("docs/ai-pack-everything.html", html);

  console.log(`Wrote docs/ai-pack-everything.(manifest.json|min.json|html) with ${shards.length} shard(s)`);

  PACK_CATALOG.push({ name: "ai-pack-everything (sharded)", count: shards.reduce((a,s)=>a+s.count,0), bytes_min: shards.reduce((a,s)=>a+s.approx_bytes,0), files: [
    "docs/ai-pack-everything.manifest.min.json", "docs/ai-pack-everything.html"
  ]});
}
writeEverythingSharded();

// ---------------- Combined "ALL" pack (docs + data-config + core + ci) ----------------
(function(){
  const names = ["ai-pack-docs","ai-pack-data-config","ai-pack-core","ai-pack-ci"];
  const packs = names.map(name => {
    const p = JSON.parse(fs.readFileSync(`docs/${name}.min.json`, "utf8"));
    return { name, items: p.items || [] };
  });
  const combined = {
    schema: "barkday.ai-pack-all.v1",
    repo, commit, updated_utc: updatedUtc,
    sections: Object.fromEntries(packs.map(p => [p.name, { count: p.items.length, items: p.items }]))
  };
  const prettyPack = JSON.stringify(combined, null, 2);
  const minPack    = JSON.stringify(combined);

  fs.writeFileSync("docs/ai-pack-all.json", prettyPack);
  fs.writeFileSync("docs/ai-pack-all.min.json", minPack);
  fs.writeFileSync("docs/ai-pack-all.txt",  minPack);
  console.log(`Wrote docs/ai-pack-all.(json|min.json|txt)`);

  const escapeHtml = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const packHtml = `<!doctype html><meta charset="utf-8">
<title>Barkday • ai-pack-all</title>
<style>
  body{font:14px system-ui;margin:24px;max-width:1100px}
  pre{white-space:pre-wrap;word-break:break-word}
  code{font-family:ui-monospace,Consolas,monospace}
  ul{line-height:1.6}
  .mono{font-family:ui-monospace,Consolas,monospace}
  .muted{color:#666}
  .chips a{display:inline-block;margin-right:10px}
  .warn{background:#fff4ce;padding:8px 10px;border-radius:8px}
  .ok{background:#e9fff0;padding:8px 10px;border-radius:8px}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#eee}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin:14px 0}
  .card{border:1px solid #eee;border-radius:10px;padding:12px}
  .card h3{margin:0 0 6px 0}
</style>
<h1>ai-pack-all</h1>
<p><small>Commit <code>${commit.slice(0,7)}</code> • ${updatedUtc}</small></p>

<div class="grid">
  <div class="card">
    <h3>Quick links</h3>
    <ul>
      <li><a href="ai-docs-list.html">Docs list (HTML)</a> <span class="muted">• browse & click raw</span></li>
      <li><a href="ai-docs-list.min.json">Docs list (JSON)</a></li>
      <li><a href="ai-pack-docs.txt">Docs pack (.txt)</a></li>
    </ul>
  </div>
  <div class="card">
    <h3>Data/Config</h3>
    <ul>
      <li><a href="ai-data-config-list.min.json">data/*.json|*.yaml (list)</a></li>
      <li><a href="ai-pack-data-config.txt">data-config pack (.txt)</a></li>
    </ul>
  </div>
  <div class="card">
    <h3>Core & CI</h3>
    <ul>
      <li><a href="ai-pack-core.txt">core pack (.txt)</a></li>
      <li><a href="ai-pack-ci.txt">CI workflows pack (.txt)</a></li>
    </ul>
  </div>
  <div class="card">
    <h3>Everything (for deep dives)</h3>
    <ul>
      <li><a href="ai-pack-everything.html">Everything index (HTML)</a></li>
      <li><a href="ai-pack-everything.manifest.min.json">Everything manifest (JSON)</a></li>
    </ul>
  </div>
</div>

<p class="muted">Machine-readable combined pack (below):</p>
<pre id="data">${escapeHtml(prettyPack)}</pre>`;
  fs.writeFileSync("docs/ai-pack-all.html", packHtml);

  PACK_CATALOG.push({ name: "ai-pack-all (combined)", count: names.reduce((a,n)=>a + JSON.parse(fs.readFileSync(`docs/${n}.min.json`,"utf8")).items.length, 0), bytes_min: minPack.length, files: [
    "docs/ai-pack-all.min.json", "docs/ai-pack-all.txt", "docs/ai-pack-all.html"
  ]});
})();

// ---------------- tiny catalog of what we emitted ----------------
(function(){
  const cat = {
    schema: "barkday.ai-pack-catalog.v1",
    repo, commit, updated_utc: updatedUtc,
    packs: PACK_CATALOG
  };
  fs.writeFileSync("docs/ai-pack-catalog.json", JSON.stringify(cat, null, 2));
  fs.writeFileSync("docs/ai-pack-catalog.min.json", JSON.stringify(cat));
  console.log("Wrote docs/ai-pack-catalog.(json|min.json)");
})();
