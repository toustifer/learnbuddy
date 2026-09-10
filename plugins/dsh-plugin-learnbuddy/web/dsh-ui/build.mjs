import { readFile, mkdir, writeFile } from "node:fs/promises";
import { Script } from "node:vm";

const source = await readFile(new URL("client.cjs", import.meta.url), "utf8");
new Script(source, { filename: "learnbuddy-dsh-ui.cjs" });
const output = `window.__ModuleLoader__.load({id: "@learnbuddy/dsh-ui", factory: (require) => {
const module = { exports: {} };
const exports = module.exports;
${source}
return module.exports;
}});\n`;
await mkdir(new URL("dist/", import.meta.url), { recursive: true });
await writeFile(new URL("dist/client.js", import.meta.url), output);
console.log(`LearnBuddy DSH UI: ${Buffer.byteLength(output)} bytes`);
