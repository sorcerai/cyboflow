// Evaluate an expression in the Cyboflow renderer over CDP and print the result.
const port = process.env.CDP_PORT ?? '9223';
const expr = process.argv[2];
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
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
console.log(JSON.stringify(res.result?.value ?? res.exceptionDetails ?? res, null, 2));
ws.close();
