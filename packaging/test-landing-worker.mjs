import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const workerPath = process.argv[2] || 'build/worker.mjs';
const { default: worker } = await import(pathToFileURL(`${process.cwd()}/${workerPath}`));
let checks = 0;
const request = (path, method = 'GET', host = 'notesci.com') =>
  worker.fetch(new Request(`https://${host}${path}`, { method }));

for (const [path, file, type] of [
  ['/', 'index.html', 'text/html'],
  ['/index.html', 'index.html', 'text/html'],
  ['/styles.css?v=uncached', 'styles.css', 'text/css'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ['/apple-touch-icon.svg', 'apple-touch-icon.svg', 'image/svg+xml'],
  ['/brand-mark.svg', 'brand-mark.svg', 'image/svg+xml'],
]) {
  const response = await request(path);
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('content-type').startsWith(type));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = await response.text();
  const source = await readFile(`landing/${file}`, 'utf8');
  if (type === 'text/html') {
    assert.equal(body.replace(/\/styles.css\?v=[a-f0-9]{10}/g, '/styles.css'), source);
    assert.ok(response.headers.get('cache-control').includes('max-age=0'));
  } else assert.equal(body, source);
  const head = await request(path, 'HEAD');
  assert.equal(head.status, response.status);
  assert.equal(head.headers.get('content-type'), response.headers.get('content-type'));
  assert.equal(await head.text(), '');
  checks += 2;
}

for (const path of ['/api/search', '/mcp', '/.env.prod', '/backend/', '/missing', '/toString', '/constructor', '/__proto__']) {
  const response = await request(path);
  assert.equal(response.status, 404, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Page not found. Visit https://notesci.com/');
  checks++;
}
const missingHead = await request('/missing', 'HEAD');
assert.equal(missingHead.status, 404);
assert.equal(await missingHead.text(), '');
checks++;

for (const method of ['GET', 'HEAD']) {
  const response = await request('/favicon.ico', method);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/favicon.svg');
  assert.equal(await response.text(), '');
  checks++;
}

for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
  const response = await request('/', method);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  checks++;
}
for (const method of ['GET', 'HEAD']) {
  const response = await request('/?q=materials#collection', method, 'www.notesci.com');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://notesci.com/?q=materials#collection');
  assert.equal(await response.text(), '');
  checks++;
}
console.log(`PASS: ${checks} Worker route/method checks; exact source content, private paths, redirect and cache behavior verified`);
