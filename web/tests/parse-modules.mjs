/* Eagerly compile every deep-sea ES module.
 *
 * `node --check` is not enough here: V8 pre-parses function bodies lazily, so a
 * malformed literal inside a method (a stray character in a hex number, say)
 * sails through the check and then fails in the browser as a bare
 * "SyntaxError: Invalid or unexpected token" with no file and no line. A
 * SourceTextModule compiles the whole thing eagerly and names the file.
 *
 * Run with: node --experimental-vm-modules web/tests/parse-modules.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const dirs = [join(root, "web", "deep", "src")];

if (typeof vm.SourceTextModule !== "function") {
  console.error("parse-modules needs --experimental-vm-modules");
  process.exit(2);
}

let checked = 0;
const failures = [];

for (const dir of dirs) {
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    const file = join(dir, name);
    const source = readFileSync(file, "utf8");
    checked += 1;
    try {
      new vm.SourceTextModule(source, { identifier: file });
    } catch (err) {
      // Locate it: strip the module syntax and re-parse as a script, which
      // reports a line number the module compiler does not.
      let where = "";
      try {
        const stripped = source
          .replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "")
          .replace(/^import "[^"]+";$/gm, "")
          .replace(/^export /gm, "");
        new vm.Script(stripped, { filename: name });
      } catch (inner) {
        where = `\n${(inner.stack || "").split("\n").slice(0, 4).join("\n")}`;
      }
      failures.push(`${relative(root, file)}: ${err.message}${where}`);
    }
  }
}

if (failures.length) {
  console.error(`\n${failures.length} of ${checked} modules failed to compile:\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(`all ${checked} deep modules compile clean`);
