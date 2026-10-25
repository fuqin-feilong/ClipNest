import fs from 'node:fs';

const port = process.argv[2] || '9223';
const output = process.argv[3] || 'ui-capture.png';
const evaluationExpression = process.argv[4] || '';

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
console.log(targets.map((target) => ({ type: target.type, title: target.title, url: target.url })));
const target = targets.find((entry) => entry.type === 'page');
if (!target) throw new Error('No page target found');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

function call(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await call('Page.enable');
await call('Runtime.enable');
if (evaluationExpression) {
  const action = await call('Runtime.evaluate', {
    expression: evaluationExpression,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('action', action.result?.value ?? action.result?.description ?? '');
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const evaluation = await call('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    url: location.href,
    inner: [innerWidth, innerHeight],
    theme: document.documentElement.dataset.theme,
    text: document.body.innerText.slice(0, 800),
    rootChildren: document.getElementById('root')?.children.length || 0,
    qs: document.querySelector('.shell') ? 'shell-present' : 'no-shell'
  })`,
  returnByValue: true,
});
console.log(evaluation.result.value);

const screenshot = await call('Page.captureScreenshot', {
  format: 'png',
  fromSurface: true,
  captureBeyondViewport: false,
});
fs.writeFileSync(output, Buffer.from(screenshot.data, 'base64'));
console.log(`Saved ${output}`);
ws.close();
