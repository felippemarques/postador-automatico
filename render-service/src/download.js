const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function downloadToTmp(url, destDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const destPath = path.join(destDir, `${crypto.randomUUID()}-${path.basename(new URL(url).pathname)}`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

module.exports = { downloadToTmp };
