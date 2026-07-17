const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { renderJob, renderThumbnail } = require('./render');
const { downloadToTmp } = require('./download');

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

app.post('/render', requireAuth, async (req, res) => {
  const { jobId, clips, voiceUrl, musicUrl, captions, musicVolume } = req.body || {};
  if (
    !jobId ||
    typeof jobId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(jobId) ||
    !Array.isArray(clips) ||
    clips.length === 0 ||
    !voiceUrl ||
    !musicUrl ||
    !Array.isArray(captions)
  ) {
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
    console.error(`render failed for job ${jobId}:`, err);
    res.status(500).json({ error: 'render failed' });
  }
});

app.post('/thumbnail', requireAuth, async (req, res) => {
  const { jobId, mascotImageUrl, text } = req.body || {};
  if (
    !jobId ||
    typeof jobId !== 'string' ||
    !/^[a-zA-Z0-9_-]+$/.test(jobId) ||
    !mascotImageUrl ||
    !text ||
    typeof text !== 'string'
  ) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  const jobDir = path.join(RENDERS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  try {
    const mascotPath = await downloadToTmp(mascotImageUrl, jobDir);
    const outPath = await renderThumbnail({ jobId, mascotPath, text }, jobDir);
    res.json({ jobId, url: `/files/${jobId}/${path.basename(outPath)}` });
  } catch (err) {
    console.error(`thumbnail failed for job ${jobId}:`, err);
    res.status(500).json({ error: 'thumbnail failed' });
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
