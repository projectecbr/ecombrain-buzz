import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const dist = path.resolve("dist-web");
const htmlPath = path.join(dist, "index.html");
const html = readFileSync(htmlPath, "utf8");
const files = readdirSync(path.join(dist, "assets")).map((name) =>
  path.join(dist, "assets", name),
);
const textFiles = files.filter((file) => /\.(?:css|html|js|map)$/.test(file));
const forbidden = [
  /\bBuzz\b/,
  /buzz:\/\//,
  /__TAURI_INTERNALS__/,
  /plugin:(?:notification|opener|process|updater|websocket)/,
  /ecombrain-teams-dev-identity/,
];

const errors = [];
if (statSync(path.join(dist, "index.web.html"), { throwIfNoEntry: false })) {
  errors.push("index.web.html must be renamed to index.html");
}
if (/\b(?:src|href)="\/assets\//.test(html)) {
  errors.push("index.html contains root-scoped asset paths");
}
for (const file of textFiles) {
  const text = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text))
      errors.push(`${path.basename(file)} matches ${pattern}`);
  }
}
for (const name of ["buzz.svg", "app-icon@2x.png", "app-icon@3x.png"]) {
  if (statSync(path.join(dist, name), { throwIfNoEntry: false })) {
    errors.push(`${name} must not ship in the web build`);
  }
}

const entryMatch = html.match(/src="([^"]+\.js)"/);
if (!entryMatch) errors.push("index.html has no JavaScript entry");
const entry = entryMatch
  ? path.join(dist, entryMatch[1].replace(/^\/teams\//, ""))
  : null;
const entryGzip = entry ? gzipSync(readFileSync(entry)).byteLength : 0;
if (entryGzip > 1.5 * 1024 * 1024) {
  errors.push(
    `initial JavaScript is ${(entryGzip / 1024 / 1024).toFixed(2)} MiB gzip`,
  );
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const js = files.filter((file) => file.endsWith(".js"));
console.log(
  `web bundle gate passed: ${(entryGzip / 1024 / 1024).toFixed(2)} MiB initial gzip, ${(js.reduce((sum, file) => sum + statSync(file).size, 0) / 1024 / 1024).toFixed(2)} MiB total JavaScript`,
);
