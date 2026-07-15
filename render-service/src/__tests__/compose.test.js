const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFfmpegArgs, srtTimestamp, buildSrt } = require('../compose');

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

test('buildFfmpegArgs builds 9:16 with correct dimensions', () => {
  const job = { clips: [{ path: 'a.mp4' }], voicePath: 'v.mp3', musicPath: 'm.mp3' };
  const args = buildFfmpegArgs(job, '9:16', 'out.srt', 'out.mp4');
  const filter = args[args.indexOf('-filter_complex') + 1];
  assert.match(filter, /scale=1080:1920/);
});

test('buildFfmpegArgs throws on unknown format', () => {
  assert.throws(() => buildFfmpegArgs({ clips: [] }, '1:1', 'a.srt', 'a.mp4'), /unknown format/);
});
