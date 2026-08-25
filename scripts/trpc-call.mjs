/**
 * Call a cyboflow tRPC procedure from OUTSIDE the app, over the renderer's
 * `window.electronTRPC` bridge (the same transport the React app uses), driven
 * through CDP. Args: <path> <type: query|mutation> <inputJson>
 */
const port = process.env.CDP_PORT ?? '9223';
const [path, type = 'query', inputJson = 'null'] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener('open', r, {once:true}); ws.addEventListener('error', j, {once:true}); });
const send = (method, params) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9);
  const on = (e) => { const m = JSON.parse(String(e.data)); if (m.id !== id) return; ws.removeEventListener('message', on);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});

// superjson is what the app's tRPC link uses, so inputs must be wrapped the
// same way ({ json: <value> }) and outputs unwrapped from the same envelope.
// The listener and the timeout are BOTH torn down on settle. They live in the
// renderer, not in this process, so leaking them would accumulate listeners and
// 2-minute timers inside the very app being profiled — measurement contaminating
// the measurement.
const expr = `(() => new Promise((resolve) => {
  const id = Math.floor(Math.random() * 1e9);
  let timer = null;
  let off = null;
  const settle = (value) => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (typeof off === 'function') { off(); off = null; }
    resolve(value);
  };
  off = window.electronTRPC.onMessage((msg) => {
    if (msg?.id !== id) return;
    settle(JSON.parse(JSON.stringify(msg)));
  });
  window.electronTRPC.sendMessage({
    id,
    method: 'request',
    operation: {
      id,
      type: ${JSON.stringify(type)},
      path: ${JSON.stringify(path)},
      input: { json: ${inputJson} },
      context: {},
    },
  });
  timer = setTimeout(() => settle({ timeout: true }), 120000);
}))()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails ?? res, null, 2));
ws.close();
