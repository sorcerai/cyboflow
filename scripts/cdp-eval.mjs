#!/usr/bin/env node
/**
 * Smoke helper: evaluate an expression in the running dev renderer over CDP.
 *
 * Lives inside the repo root deliberately — Electron's CDP endpoint refuses a
 * WebSocket whose driver resolves outside it. Usage:
 *   node scripts/cdp-eval.mjs <cdpPort> '<js expression>'
 * The expression is awaited and its result JSON-stringified.
 */
// Node 22's global WebSocket — no dependency, so this runs from the repo root
// whatever the workspace install state is.
const port = process.argv[2];
const expression = process.argv[3];

const targets = await (await fetch(`http://localhost:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://localhost'));
if (!page) {
  console.error('no renderer page target found');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const result = await new Promise((resolve, reject) => {
  const id = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data.toString());
    if (msg.id !== id) return;
    if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
    const r = msg.result?.result;
    if (msg.result?.exceptionDetails) {
      return reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
    }
    resolve(r?.value ?? r);
  });
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  setTimeout(() => reject(new Error('CDP evaluate timed out')), 20000);
});

console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
ws.close();
