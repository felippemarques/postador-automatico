const path = require('node:path');
const { execFile } = require('node:child_process');
const { buildFfmpegArgs, writeSrt, buildThumbnailArgs } = require('./compose');

function runFfmpeg(args, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffmpeg failed: ${stderr || error.message}`));
      resolve({ stdout, stderr });
    });
  });
}

async function renderJob(job, outDir, execFileImpl = execFile) {
  const srtPath = path.join(outDir, `${job.jobId}.srt`);
  writeSrt(job.captions, srtPath);
  const results = {};
  for (const formatKey of ['16:9', '9:16']) {
    const outPath = path.join(outDir, `${job.jobId}-${formatKey.replace(':', 'x')}.mp4`);
    const args = buildFfmpegArgs(job, formatKey, srtPath, outPath);
    await runFfmpeg(args, execFileImpl);
    results[formatKey] = outPath;
  }
  return results;
}

async function renderThumbnail(job, outDir, execFileImpl = execFile) {
  const outPath = path.join(outDir, `${job.jobId}-thumb.jpg`);
  const args = buildThumbnailArgs(job.mascotPath, job.text, outPath);
  await runFfmpeg(args, execFileImpl);
  return outPath;
}

module.exports = { runFfmpeg, renderJob, renderThumbnail };
