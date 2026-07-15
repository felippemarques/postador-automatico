process.env.RENDER_AUTH_TOKEN = 'secret';
process.env.RENDERS_DIR = require('node:os').tmpdir();

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

function listen(appInstance) {
  return new Promise((resolve) => {
    const server = appInstance.listen(0, () => resolve(server));
  });
}

test('GET /health returns ok', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { status: 'ok' });
  server.close();
});

test('POST /render without auth returns 401', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
  server.close();
});

test('POST /render with auth but missing fields returns 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /render with path-traversal jobId returns 400', async () => {
  const server = await listen(app);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({
      jobId: '../../etc/passwd',
      clips: [{ url: 'http://example.com/a.mp4' }],
      voiceUrl: 'http://example.com/voice.mp3',
      musicUrl: 'http://example.com/music.mp3',
      captions: [],
    }),
  });
  assert.equal(res.status, 400);
  server.close();
});

test('POST /render returns a generic error and does not leak internal details on failure', async () => {
  const originalFetch = global.fetch;
  // Delegate requests to the local test server through, but simulate a
  // downstream failure (e.g. a failed download) for any other URL so we can
  // exercise the /render catch block without a real network call.
  global.fetch = async (url, ...args) => {
    if (typeof url === 'string' && url.includes('127.0.0.1')) {
      return originalFetch(url, ...args);
    }
    throw new Error("ENOENT: no such file or directory, open '/data/renders/secret-internal-path'");
  };

  try {
    const server = await listen(app);
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({
        jobId: 'job-500-test',
        clips: [{ url: 'http://example.com/a.mp4' }],
        voiceUrl: 'http://example.com/voice.mp3',
        musicUrl: 'http://example.com/music.mp3',
        captions: [],
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.deepEqual(body, { error: 'render failed' });
    server.close();
  } finally {
    global.fetch = originalFetch;
  }
});
