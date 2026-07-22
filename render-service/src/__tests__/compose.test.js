const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFfmpegArgs, srtTimestamp, buildSrt, escapeDrawtext, buildThumbnailArgs, wrapTextToWidth, fitThumbnailText } = require('../compose');

test('srtTimestamp formats seconds as SRT timestamp', () => {
  assert.equal(srtTimestamp(0), '00:00:00,000');
  assert.equal(srtTimestamp(65.25), '00:01:05,250');
});

test('buildSrt renders numbered cue blocks', () => {
  const srt = buildSrt([{ start: 0, end: 1.5, text: 'Ola' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nOla\n');
});

test('buildFfmpegArgs builds filter_complex for 16:9 with 2 clips', () => {
  const job = {
    clips: [{ path: 'a.mp4' }, { path: 'b.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
    musicVolume: 0.3,
  };
  const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
  assert.deepEqual(args.slice(0, 6), ['-i', 'a.mp4', '-i', 'b.mp4', '-i', 'voice.mp3']);
  const filterIndex = args.indexOf('-filter_complex');
  assert.ok(filterIndex !== -1);
  const filter = args[filterIndex + 1];
  assert.match(filter, /scale=1920:1080/);
  assert.match(filter, /concat=n=2:v=1:a=0\[vcat\]/);
  assert.match(filter, /volume=0\.3\[music\]/);
  assert.equal(args.at(-1), 'out.mp4');
});

test('buildFfmpegArgs normalizes fps on every clip before concat (mixed source frame rates would otherwise blow up the concat timebase)', () => {
  const job = {
    clips: [{ path: 'a.mp4' }, { path: 'b.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
  };
  const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  const perClipChains = filter.split(';').filter((chain) => /\[v\d+\]$/.test(chain));
  assert.equal(perClipChains.length, 2);
  perClipChains.forEach((chain) => assert.match(chain, /,fps=25\[v\d+\]$/));
});

test('buildFfmpegArgs builds 9:16 with correct dimensions', () => {
  const job = { clips: [{ path: 'a.mp4' }], voicePath: 'v.mp3', musicPath: 'm.mp3' };
  const args = buildFfmpegArgs(job, '9:16', 'out.srt', 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=1080:1920/);
});

test('buildFfmpegArgs throws on unknown format', () => {
  assert.throws(() => buildFfmpegArgs({ clips: [] }, '1:1', 'a.srt', 'a.mp4'), /unknown format/);
});

test('buildFfmpegArgs throws on empty clips array', () => {
  assert.throws(() => buildFfmpegArgs({ clips: [] }, '16:9', 'a.srt', 'a.mp4'), /at least one clip/);
});

test('buildFfmpegArgs escapes Windows-style srt paths for the subtitles filter', () => {
  const job = { clips: [{ path: 'a.mp4' }], voicePath: 'v.mp3', musicPath: 'm.mp3' };
  const args = buildFfmpegArgs(job, '16:9', 'C:\\data\\renders\\job1.srt', 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /subtitles=C\\:\/data\/renders\/job1\.srt/);
  assert.doesNotMatch(filter, /\\[a-zA-Z]/);
});

test('buildFfmpegArgs trims each clip input with -t sized to voiceDurationSec / clipCount when present', () => {
  const job = {
    clips: Array.from({ length: 8 }, (_, i) => ({ path: `clip${i}.mp4` })),
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
    voiceDurationSec: 40,
  };
  const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
  job.clips.forEach((clip) => {
    const iIndex = args.indexOf(clip.path) - 1;
    assert.equal(args[iIndex], '-i');
    assert.equal(args[iIndex - 2], '-t');
    assert.equal(args[iIndex - 1], '5');
  });
  // voice/music inputs must NOT be preceded by -t
  const voiceIIndex = args.indexOf('voice.mp3') - 1;
  assert.equal(args[voiceIIndex], '-i');
  assert.notEqual(args[voiceIIndex - 2], '-t');
  const musicIIndex = args.indexOf('music.mp3') - 1;
  assert.equal(args[musicIIndex], '-i');
  assert.notEqual(args[musicIIndex - 2], '-t');
});

test('buildFfmpegArgs does not add -t before clip inputs when voiceDurationSec is absent (pre-fix behavior preserved)', () => {
  const job = {
    clips: [{ path: 'a.mp4' }, { path: 'b.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
  };
  const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
  assert.deepEqual(args.slice(0, 6), ['-i', 'a.mp4', '-i', 'b.mp4', '-i', 'voice.mp3']);
  assert.ok(!args.includes('-t'));
});

test('buildFfmpegArgs does not add -t when voiceDurationSec is non-finite (0, negative, NaN, Infinity)', () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    const job = {
      clips: [{ path: 'a.mp4' }],
      voicePath: 'voice.mp3',
      musicPath: 'music.mp3',
      voiceDurationSec: bad,
    };
    const args = buildFfmpegArgs(job, '16:9', 'out.srt', 'out.mp4');
    assert.ok(!args.includes('-t'), `expected no -t for voiceDurationSec=${bad}`);
  }
});

test('escapeDrawtext escapes colon, backslash and replaces apostrophe', () => {
  assert.equal(escapeDrawtext(`It's 10:30\\done`), 'It’s 10\\:30\\\\done');
});

test('escapeDrawtext escapes percent signs', () => {
  assert.equal(escapeDrawtext('100% done'), '100\\% done');
});

test('buildThumbnailArgs builds a single-frame ffmpeg overlay command for a short title (fits on one line)', () => {
  const args = buildThumbnailArgs('mascot.png', 'Oi Herói', 'out.jpg');
  assert.deepEqual(args.slice(0, 2), ['-i', 'mascot.png']);
  const filterIndex = args.indexOf('-vf');
  assert.ok(filterIndex !== -1);
  assert.match(args[filterIndex + 1], /drawtext=text='Oi Heró.*':fontsize=64/);
  assert.deepEqual(args.slice(-6), ['-frames:v', '1', '-q:v', '2', '-y', 'out.jpg']);
});

test('wrapTextToWidth wraps words into lines that fit maxCharsPerLine for the given fontsize/canvasWidth', () => {
  const lines = wrapTextToWidth('Missão Super Ouvidos Encantados', 64, 500);
  assert.ok(lines.length >= 2);
  const maxCharsPerLine = Math.floor((500 * 0.9) / (64 * 0.6));
  lines.forEach((line) => assert.ok(line.length <= maxCharsPerLine || !line.includes(' ')));
});

test('fitThumbnailText shrinks fontsize until the wrapped text fits within THUMBNAIL_MAX_LINES', () => {
  const { lines, fontsize } = fitThumbnailText('Missão Super Ouvidos', 500);
  assert.ok(fontsize < 64);
  assert.ok(lines.length <= 2);
});

test('fitThumbnailText never returns more lines for a longer canvasWidth than a shorter one', () => {
  const narrow = fitThumbnailText('Missão Guarda Brinquedos Encantados', 300);
  const wide = fitThumbnailText('Missão Guarda Brinquedos Encantados', 900);
  assert.ok(wide.fontsize >= narrow.fontsize);
});

test('buildThumbnailArgs wraps a long title into 2+ lines and/or shrinks fontsize so no line overflows canvasWidth', () => {
  const canvasWidth = 500;
  const args = buildThumbnailArgs('mascot.png', 'Missão Guarda Brinquedos Encantados', 'out.jpg', canvasWidth);
  const filter = args[args.indexOf('-vf') + 1];
  const fontsizeMatch = filter.match(/fontsize=(\d+)/);
  const fontsize = Number(fontsizeMatch[1]);
  const textMatch = filter.match(/text='([\s\S]*?)':fontsize=/);
  const lines = textMatch[1].split('\n');
  assert.ok(lines.length >= 2 || fontsize < 64);
  const maxCharsPerLine = Math.floor((canvasWidth * 0.9) / (fontsize * 0.6));
  lines.forEach((line) => assert.ok(line.length <= maxCharsPerLine + 1, `line "${line}" (${line.length} chars) exceeds estimated width at fontsize ${fontsize}`));
});

test('buildThumbnailArgs falls back to THUMBNAIL_DEFAULT_CANVAS_WIDTH when canvasWidth is omitted', () => {
  const withDefault = buildThumbnailArgs('mascot.png', 'Missão Super Ouvidos', 'out.jpg');
  const withExplicit500 = buildThumbnailArgs('mascot.png', 'Missão Super Ouvidos', 'out.jpg', 500);
  assert.equal(withDefault[withDefault.indexOf('-vf') + 1], withExplicit500[withExplicit500.indexOf('-vf') + 1]);
});
