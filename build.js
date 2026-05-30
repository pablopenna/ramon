const fs = require('fs');
const path = require('path');

// Files needed to run the app in a browser, copied verbatim into dist/.
const files = [
  'index.html',
  'vendor/keystone.min.js', // shipped for the commented asm.js-Keystone alternative in index.html
  'vendor/unicorn-aarch64.min.js',
  'vendor-wasm/keystone-core.js',
  'vendor-wasm/keystone-core.wasm',
];

const dist = path.join(__dirname, 'dist');

fs.rmSync(dist, { recursive: true, force: true });

for (const file of files) {
  const src = path.join(__dirname, file);
  const dest = path.join(dist, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${file}`);
}

console.log(`\nBuilt ${files.length} files into dist/`);
