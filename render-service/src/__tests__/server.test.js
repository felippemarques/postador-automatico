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
