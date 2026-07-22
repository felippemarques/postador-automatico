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

// Probes a media file's duration (in seconds) via ffprobe, ships alongside ffmpeg
// in the same container/package. Used to size per-clip trimming to the voice track.
function getMediaDuration(filePath, execFileImpl = execFile) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
  return new Promise((resolve, reject) => {
    execFileImpl('ffprobe', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffprobe failed: ${stderr || error.message}`));
      resolve(parseFloat(stdout));
    });
  });
}

async function renderJob(job, outDir, execFileImpl = execFile) {
  const srtPath = path.join(outDir, `${job.jobId}.srt`);
  writeSrt(job.captions, srtPath);
  job.voiceDurationSec = await getMediaDuration(job.voicePath, execFileImpl);
  const results = {};
  for (const formatKey of ['16:9', '9:16']) {
    const outPath = path.join(outDir, `${job.jobId}-${formatKey.replace(':', 'x')}.mp4`);
    const args = buildFfmpegArgs(job, formatKey, srtPath, outPath);
    await runFfmpeg(args, execFileImpl);
    results[formatKey] = outPath;
  }
  return results;
}

// Probes an image's pixel width via ffprobe. Used to size the thumbnail's
// word-wrap/fontsize to the mascot image's real width instead of a hardcoded
// canvasWidth.
function getImageWidth(filePath, execFileImpl = execFile) {
  const args = ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'default=noprint_wrappers=1:nokey=1', filePath];
  return new Promise((resolve, reject) => {
    execFileImpl('ffprobe', args, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`ffprobe failed: ${stderr || error.message}`));
      resolve(parseInt(stdout, 10));
    });
  });
}

async function renderThumbnail(job, outDir, execFileImpl = execFile) {
  const outPath = path.join(outDir, `${job.jobId}-thumb.jpg`);
  const canvasWidth = await getImageWidth(job.mascotPath, execFileImpl);
  const args = buildThumbnailArgs(job.mascotPath, job.text, outPath, canvasWidth);
  await runFfmpeg(args, execFileImpl);
  return outPath;
}

module.exports = { runFfmpeg, getMediaDuration, getImageWidth, renderJob, renderThumbnail };
