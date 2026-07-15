const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderJob } = require('./render');

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.RENDER_AUTH_TOKEN;
const RENDERS_DIR = process.env.RENDERS_DIR || '/data/renders';

const app = express();
app.use(express.json({ limit: '2mb' }));

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN || req.get('authorization') !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

async function downloadToTmp(url, destDir) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to download ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const destPath = path.join(destDir, `${crypto.randomUUID()}-${path.basename(new URL(url).pathname)}`);
  fs.writeFileSync(destPath, buffer);
  return destPath;
}

app.post('/render', requireAuth, async (req, res) => {
  const { jobId, clips, voiceUrl, musicUrl, captions, musicVolume } = req.body || {};
  if (!jobId || !Array.isArray(clips) || clips.length === 0 || !voiceUrl || !musicUrl || !Array.isArray(captions)) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  const jobDir = path.join(RENDERS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const localClips = [];
    for (const clip of clips) {
      localClips.push({ path: await downloadToTmp(clip.url, jobDir) });
    }
    const voicePath = await downloadToTmp(voiceUrl, jobDir);
    const musicPath = await downloadToTmp(musicUrl, jobDir);
    const files = await renderJob(
      { jobId, clips: localClips, voicePath, musicPath, captions, musicVolume },
      jobDir
    );
    const fileUrls = Object.fromEntries(
      Object.entries(files).map(([format, filePath]) => [format, `/files/${jobId}/${path.basename(filePath)}`])
    );
    res.json({ jobId, files: fileUrls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/files', express.static(RENDERS_DIR));

function start() {
  app.listen(PORT, () => {
    console.log(`render-service listening on ${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
