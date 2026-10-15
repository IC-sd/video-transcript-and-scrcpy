const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '../extension');
let count = 0;
for (const file of fs.readdirSync(root, { recursive: true })) {
  const full = path.join(root, file);
  if (file.endsWith('.js')) { new vm.Script(fs.readFileSync(full, 'utf8'), { filename: file }); count++; }
  if (file.endsWith('.html')) {
    for (const [, source] of fs.readFileSync(full, 'utf8').matchAll(/<script src="([^"]+)"/g)) {
      assert(fs.existsSync(path.join(root, source)), 'Missing script: ' + source);
    }
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
for (const script of manifest.content_scripts.flatMap((c) => c.js)) assert(fs.existsSync(path.join(root, script)));
assert.equal(manifest.version, require('../package.json').version);
console.log(`Validated ${count} JavaScript files, manifest and HTML script references.`);
