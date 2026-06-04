// scripts/check-inline-scripts.mjs
// CI guard (#10): parse every inline <script> in the built HTML with the JS
// engine. Astro passes is:inline scripts through verbatim — the build does NOT
// syntax-check them — so a stray smart quote / typo silently ships and only
// explodes in the browser (killing the whole page IIFE). This catches that
// class of bug at build time.
//
// Usage: node scripts/check-inline-scripts.mjs   (run after `npm run build`)
// Exit 0 if all inline scripts parse, 1 otherwise.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';

function walkHtml(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkHtml(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

let files;
try {
  files = walkHtml(DIST);
} catch {
  console.error(`[check-inline-scripts] no ${DIST}/ — run \`npm run build\` first.`);
  process.exit(1);
}

const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
let checked = 0;
let failed = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const body = m[1];
    // Skip empty + JSON/ld + module-src (external) scripts.
    if (!body.trim()) continue;
    if (/type\s*=\s*["']application\/(ld\+)?json["']/.test(m[0])) continue;
    checked++;
    try {
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch (e) {
      failed++;
      console.error(`✗ ${file}\n    ${e.message}`);
    }
  }
}

if (failed > 0) {
  console.error(`\n[check-inline-scripts] ${failed} inline script(s) failed to parse (of ${checked}).`);
  process.exit(1);
}
console.log(`[check-inline-scripts] OK — ${checked} inline scripts parse across ${files.length} HTML files.`);
