// Standalone solc compiler with import resolution from node_modules.
// Produces artifacts/<Name>.json with abi + bytecode for each contract.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = __dirname;
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "out");

function walk(dir) {
  let files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files = files.concat(walk(p));
    else if (e.name.endsWith(".sol")) files.push(p);
  }
  return files;
}

const sources = {};
for (const f of walk(SRC)) {
  const rel = path.relative(ROOT, f).split(path.sep).join("/");
  sources[rel] = { content: fs.readFileSync(f, "utf8") };
}

function findImport(importPath) {
  // OZ and other node_modules imports
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(ROOT, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { contents: fs.readFileSync(c, "utf8") };
  }
  return { error: "File not found: " + importPath };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "shanghai",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));

let hasError = false;
if (output.errors) {
  for (const e of output.errors) {
    if (e.severity === "error") { hasError = true; console.error(e.formattedMessage); }
    else console.warn(e.formattedMessage);
  }
}
if (hasError) { console.error("COMPILATION FAILED"); process.exit(1); }

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const file of Object.keys(output.contracts || {})) {
  for (const name of Object.keys(output.contracts[file])) {
    const c = output.contracts[file][name];
    fs.writeFileSync(
      path.join(OUT, `${name}.json`),
      JSON.stringify({ contractName: name, sourceName: file, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    count++;
  }
}
console.log(`OK - compiled ${count} contract artifacts to out/`);
