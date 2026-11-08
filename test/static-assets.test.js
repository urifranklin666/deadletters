const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'deadletters-static-test-'));
process.env.DEADLETTERS_DATA_DIR = path.join(sandbox, 'data');
process.env.DEADLETTERS_UPLOADS_DIR = path.join(sandbox, 'uploads');
process.env.DEADLETTERS_THEMES_DIR = path.join(sandbox, 'themes');
process.env.DEADLETTERS_ADDONS_DIR = path.join(sandbox, 'addons');
process.env.JWT_SECRET = 'static-assets-test-secret';
process.env.NODE_ENV = 'test';

const { app } = require('../src/server');
let server;
let baseUrl;

before(async () => {
  fs.mkdirSync(path.join(sandbox, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'themes', 'example'), { recursive: true });
  fs.writeFileSync(path.join(sandbox, 'uploads', 'safe.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(sandbox, 'uploads', 'unsafe.html'), '<script src="/js/app.js"></script>');
  fs.writeFileSync(path.join(sandbox, 'themes', 'example', 'style.css'), 'body{color:red}');
  fs.writeFileSync(path.join(sandbox, 'themes', 'example', 'unsafe.js'), 'alert(1)');
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('static guards allow passive assets and deny executable same-origin files', async () => {
  assert.equal((await fetch(`${baseUrl}/uploads/safe.png`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/uploads/unsafe.html`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/themes/example/style.css`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/themes/example/unsafe.js`)).status, 404);

  const denied = await fetch(`${baseUrl}/themes/example/unsafe.js`);
  assert.match(denied.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
});
