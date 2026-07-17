const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderJob, runFfmpeg, renderThumbnail, getMediaDuration } = require('../render');

test('renderJob probes voice duration via ffprobe once, then calls ffmpeg twice (16:9 and 9:16)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'ffprobe') return cb(null, '1\n', '');
    cb(null, '', '');
  };
  const job = {
    jobId: 'job1',
    clips: [{ path: 'a.mp4' }],
    voicePath: 'voice.mp3',
    musicPath: 'music.mp3',
    captions: [{ start: 0, end: 1, text: 'oi' }],
  };
  const files = await renderJob(job, outDir, fakeExecFile);
  // 1 ffprobe call (voice duration probe) + 2 ffmpeg calls (16:9 and 9:16)
  assert.equal(calls.length, 3);
  assert.equal(calls[0].cmd, 'ffprobe');
  assert.equal(calls[1].cmd, 'ffmpeg');
  assert.equal(calls[2].cmd, 'ffmpeg');
  assert.ok(fs.existsSync(path.join(outDir, 'job1.srt')));
  assert.equal(files['16:9'], path.join(outDir, 'job1-16x9.mp4'));
  assert.equal(files['9:16'], path.join(outDir, 'job1-9x16.mp4'));
});

test('getMediaDuration resolves to the parsed float duration from ffprobe stdout', async () => {
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push({ cmd, args });
    cb(null, '39.94\n', '');
  };
  const duration = await getMediaDuration('voice.wav', fakeExecFile);
  assert.equal(duration, 39.94);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'ffprobe');
  assert.ok(calls[0].args.includes('voice.wav'));
});

test('getMediaDuration rejects with stderr message on failure', async () => {
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error('boom'), '', 'ffprobe error output');
  await assert.rejects(() => getMediaDuration('voice.wav', fakeExecFile), /ffprobe error output/);
});

test('runFfmpeg rejects with stderr message on failure', async () => {
  const fakeExecFile = (cmd, args, opts, cb) => cb(new Error('boom'), '', 'ffmpeg error output');
  await assert.rejects(() => runFfmpeg(['-i', 'x'], fakeExecFile), /ffmpeg error output/);
});

test('renderThumbnail calls ffmpeg once and returns the output path', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push(args);
    cb(null, '', '');
  };
  const outPath = await renderThumbnail({ jobId: 'job1', mascotPath: 'mascot.png', text: 'Missão Teste' }, outDir, fakeExecFile);
  assert.equal(calls.length, 1);
  assert.equal(outPath, path.join(outDir, 'job1-thumb.jpg'));
});
