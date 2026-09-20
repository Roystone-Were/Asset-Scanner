// Syntax gate for everything CI could not see until now: the inline <script>
// blocks of the five pages (about 200 KB of JS that ships untested) and the
// standalone scripts under js/, summary/ and scanner-app/. The existing
// workflow only `node --check`ed the two api/*.js functions, so a typo in
// assets/index.html reached production with a green check.
//
// Usage: node scripts/check-syntax.mjs   (exit 1 on the first broken file)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const PAGES = ["index.html", "login/index.html", "assets/index.html", "admin/index.html", "summary/index.html"];
const SCRIPTS = ["js/supabase-client.js", "js/ui.js", "summary/app.js", "scanner-app/logic.js", "scanner-app/photo.js"];

let failures = 0;
const fail = (what, err) => { failures++; console.log(`  FAIL  ${what}\n        ${String(err && err.message || err).split("\n")[0]}`); };
const ok = (what) => console.log(`  PASS  ${what}`);

for (const file of SCRIPTS) {
  if (!fs.existsSync(file)) continue;   // photo.js is optional/unshipped
  try {
    // classic scripts: parse without executing, which is all --check does
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    ok(file);
  } catch (e) {
    fail(file, e.stderr ? String(e.stderr) : e);
  }
}

for (const page of PAGES) {
  if (!fs.existsSync(page)) { fail(page, "missing"); continue; }
  const html = fs.readFileSync(page, "utf8");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;         // external file, checked above
    const code = m[2];
    if (!code.trim()) continue;
    n++;
    const line = html.slice(0, m.index).split("\n").length;
    try {
      new vm.Script(code, { filename: `${page}:${line}` });
    } catch (e) {
      fail(`${page} inline script at line ${line}`, e);
    }
  }
  if (n) ok(`${page} (${n} inline script block${n === 1 ? "" : "s"})`);
}

console.log(failures ? `\n${failures} file(s) failed to parse` : "\nall files parse");
process.exit(failures ? 1 : 0);
