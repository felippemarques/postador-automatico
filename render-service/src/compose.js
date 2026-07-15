const fs = require('node:fs');

const FORMATS = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
};

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
  const { width, height } = format;
  const clipCount = job.clips.length;
  const voiceIndex = clipCount;
  const musicIndex = clipCount + 1;

  const inputs = [];
  job.clips.forEach((clip) => inputs.push('-i', clip.path));
  inputs.push('-i', job.voicePath);
  inputs.push('-i', job.musicPath);

  const scaleLabels = job.clips
    .map((_, i) => `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1[v${i}]`)
    .join(';');
  const concatInputs = job.clips.map((_, i) => `[v${i}]`).join('');
  const concat = `${concatInputs}concat=n=${clipCount}:v=1:a=0[vcat]`;
  const subtitles = `[vcat]subtitles=${srtPath.replace(/:/g, '\\:')}[vout]`;
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

module.exports = { buildFfmpegArgs, buildSrt, writeSrt, srtTimestamp, FORMATS };
