const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renderJob, runFfmpeg, renderThumbnail } = require('../render');

test('renderJob writes srt and calls ffmpeg twice (16:9 and 9:16)', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
  const calls = [];
  const fakeExecFile = (cmd, args, opts, cb) => {
    calls.push(args);
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
  assert.equal(calls.length, 2);
  assert.ok(fs.existsSync(path.join(outDir, 'job1.srt')));
  assert.equal(files['16:9'], path.join(outDir, 'job1-16x9.mp4'));
  assert.equal(files['9:16'], path.join(outDir, 'job1-9x16.mp4'));
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
