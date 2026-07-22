const fs = require('node:fs');

const FORMATS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

// Source clips arrive at whatever frame rate the stock provider shipped
// (Pexels/Pixabay mix 25fps and 30fps). Without normalizing to one fps before
// `concat`, its output timebase becomes the LCM of the inputs' timebases,
// which explodes and makes libx264 duplicate frames trying to fill it
// (observed: ~40000 frames encoded for 70ms of real output).
const OUTPUT_FPS = 25;

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

function srtTimestamp(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

function buildSrt(captions) {
  return captions
    .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

function writeSrt(captions, filePath) {
  fs.writeFileSync(filePath, buildSrt(captions), 'utf8');
  return filePath;
}

function buildFfmpegArgs(job, formatKey, srtPath, outPath) {
  const format = FORMATS[formatKey];
  if (!format) throw new Error(`unknown format: ${formatKey}`);
  if (!Array.isArray(job.clips) || job.clips.length === 0) {
    throw new Error('at least one clip is required');
  }
  const { width, height } = format;
  const clipCount = job.clips.length;
  const voiceIndex = clipCount;
  const musicIndex = clipCount + 1;

  // Trim each clip to roughly voiceDurationSec / clipCount before concat so the
  // concatenated video doesn't run far longer than the narration (and ffmpeg
  // doesn't decode more of each source clip than it needs). Only applied when
  // a usable (finite, positive) duration is available; otherwise falls back to
  // the original untrimmed behavior.
  const perClipDurationSec = job.voiceDurationSec / clipCount;
  const canTrim = Number.isFinite(perClipDurationSec) && perClipDurationSec > 0;

  const inputs = [];
  job.clips.forEach((clip) => {
    if (canTrim) inputs.push('-t', String(perClipDurationSec));
    inputs.push('-i', clip.path);
  });
  inputs.push('-i', job.voicePath);
  inputs.push('-i', job.musicPath);

  const scaleLabels = job.clips
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${OUTPUT_FPS}[v${i}]`)
    .join(';');
  const concatInputs = job.clips.map((_, i) => `[v${i}]`).join('');
  const concat = `${concatInputs}concat=n=${clipCount}:v=1:a=0[vcat]`;
  const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const subtitles = `[vcat]subtitles=${escapedSrtPath}[vout]`;
  const musicVolume = job.musicVolume ?? 0.25;
  const audioMix = `[${voiceIndex}:a]volume=1.0[voice];[${musicIndex}:a]volume=${musicVolume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`;

  const filterComplex = [scaleLabels, concat, subtitles, audioMix].join(';');

  return [
    ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    '-y',
    outPath,
  ];
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')
    .replace(/%/g, '\\%');
}

const THUMBNAIL_MAX_FONTSIZE = 64;
const THUMBNAIL_MIN_FONTSIZE = 32;
const THUMBNAIL_MAX_LINES = 2;
const THUMBNAIL_CHAR_WIDTH_RATIO = 0.6;
const THUMBNAIL_MARGIN_RATIO = 0.9;
const THUMBNAIL_DEFAULT_CANVAS_WIDTH = 500;

// Estimates how many characters fit per line at a given fontsize/canvasWidth
// (no real font metrics available at this layer — a fixed average-glyph-width
// ratio is close enough for the default ffmpeg drawtext font) and greedily
// word-wraps the text to that width.
function wrapTextToWidth(text, fontsize, canvasWidth) {
  const maxCharsPerLine = Math.max(1, Math.floor((canvasWidth * THUMBNAIL_MARGIN_RATIO) / (fontsize * THUMBNAIL_CHAR_WIDTH_RATIO)));
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Shrinks fontsize (in steps of 8, down to THUMBNAIL_MIN_FONTSIZE) until the
// wrapped text fits within THUMBNAIL_MAX_LINES for the given canvasWidth.
function fitThumbnailText(text, canvasWidth) {
  for (let fontsize = THUMBNAIL_MAX_FONTSIZE; fontsize > THUMBNAIL_MIN_FONTSIZE; fontsize -= 8) {
    const lines = wrapTextToWidth(text, fontsize, canvasWidth);
    if (lines.length <= THUMBNAIL_MAX_LINES) return { lines, fontsize };
  }
  return { lines: wrapTextToWidth(text, THUMBNAIL_MIN_FONTSIZE, canvasWidth), fontsize: THUMBNAIL_MIN_FONTSIZE };
}

function buildThumbnailArgs(mascotPath, text, outPath, canvasWidth = THUMBNAIL_DEFAULT_CANVAS_WIDTH) {
  const { lines, fontsize } = fitThumbnailText(text, canvasWidth);
  const drawtextLines = lines.map(escapeDrawtext).join('\n');
  const drawtext = `drawtext=text='${drawtextLines}':fontsize=${fontsize}:fontcolor=white:borderw=4:bordercolor=black:x=(w-text_w)/2:y=h-160:line_spacing=10:box=1:boxcolor=black@0.5:boxborderw=20`;
  return ['-i', mascotPath, '-vf', drawtext, '-frames:v', '1', '-q:v', '2', '-y', outPath];
}

module.exports = { buildFfmpegArgs, buildSrt, writeSrt, srtTimestamp, FORMATS, escapeDrawtext, buildThumbnailArgs, wrapTextToWidth, fitThumbnailText };
