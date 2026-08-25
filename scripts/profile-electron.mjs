#!/usr/bin/env node
/**
 * Profile the real Cyboflow renderer and main process through their CDP /
 * inspector endpoints.
 *
 * Renderer (needs `--remote-debugging-port`, default 9223 — `pnpm dev` sets it):
 *   node scripts/profile-electron.mjs inspect
 *   node scripts/profile-electron.mjs sample --label baseline-idle --duration-ms 10000
 *   node scripts/profile-electron.mjs sample --label nav --duration-ms 10000 \
 *     --click Backlog --click Reviews --click Home
 *
 * Main process (needs `--inspect`, default 9229 — use `pnpm dev:perf`):
 *   node scripts/profile-electron.mjs cpu --label idle --duration-ms 20000
 *   node scripts/profile-electron.mjs heap --label idle --duration-ms 30000
 *
 * `cpu` records a real V8 sampling profile and prints the self-time leaderboard,
 * which is the only way to attribute main-process CPU to a specific function.
 * `heap` runs V8's sampling allocation profiler, which attributes bytes ALLOCATED
 * over the window to allocation sites — the churn that drives GC cost, distinct
 * from retained heap.
 *
 * The script is dependency-free so it remains usable before Playwright has
 * been built.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const command = argv.shift() ?? 'sample';

function option(name, fallback) {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
}

function options(name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) values.push(argv[i + 1]);
  }
  return values;
}

const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '9223'));
const inspectPort = Number(option('--inspect-port', '9229'));
const topN = Number(option('--top', '30'));
const durationMs = Number(option('--duration-ms', '10000'));
const label = option('--label', 'sample');
const outputPath = option('--output', null);
const clickLabels = options('--click');

if (!Number.isFinite(port) || !Number.isFinite(durationMs) || durationMs < 250) {
  throw new Error('Invalid --port or --duration-ms value');
}

const endpoint = `http://${host}:${port}`;

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== 'number') return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.socket.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function targets() {
  const list = await readJson(`${endpoint}/json/list`);
  const page = list.find((target) => target.type === 'page' && /^https?:\/\//.test(target.url));
  if (!page) throw new Error(`No Electron renderer target found at ${endpoint}`);
  return { list, page };
}

function metricsMap(result) {
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mb(bytes) {
  return round(bytes / 1024 / 1024, 1);
}

function metricDelta(before, after, name, scale = 1) {
  return round(((after[name] ?? 0) - (before[name] ?? 0)) * scale, 2);
}

function processSnapshot(result) {
  return Object.fromEntries(result.processInfo.map((entry) => [String(entry.id), entry]));
}

function processDeltas(before, after) {
  const rows = [];
  for (const [pid, current] of Object.entries(after)) {
    const previous = before[pid];
    if (!previous) continue;
    rows.push({
      pid: Number(pid),
      type: current.type,
      cpuSeconds: round(current.cpuTime - previous.cpuTime, 3),
    });
  }
  return rows.sort((a, b) => b.cpuSeconds - a.cpuSeconds);
}

async function inspect() {
  const { list, page } = await targets();
  const client = new CdpClient(page.webSocketDebuggerUrl);
  try {
    const { result } = await client.send('Runtime.evaluate', {
      expression: `({
        title: document.title,
        url: location.href,
        text: document.body.innerText.slice(0, 12000),
        controls: [...document.querySelectorAll('button, a, [role="button"]')]
          .map((node) => ({
            tag: node.tagName,
            text: (node.innerText || node.getAttribute('aria-label') || '').trim(),
            ariaLabel: node.getAttribute('aria-label'),
            title: node.getAttribute('title')
          }))
          .filter((item) => item.text || item.ariaLabel || item.title)
          .slice(0, 300)
      })`,
      returnByValue: true,
    });
    console.log(JSON.stringify({ targets: list.map(({ id, title, type, url }) => ({ id, title, type, url })), page: result.value }, null, 2));
  } finally {
    client.close();
  }
}

async function clickByLabel(client, text) {
  const expression = `(() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const nodes = [...document.querySelectorAll('button, a, [role="button"]')];
    const node = nodes.find((candidate) => {
      const label = (candidate.innerText || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '').trim().toLowerCase();
      return label === wanted || label.includes(wanted);
    });
    if (!node) return { clicked: false, available: nodes.map((item) => (item.innerText || item.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 100) };
    node.click();
    return { clicked: true, label: (node.innerText || node.getAttribute('aria-label') || '').trim() };
  })()`;
  const { result } = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  if (!result.value?.clicked) throw new Error(`Could not click ${JSON.stringify(text)}: ${JSON.stringify(result.value?.available)}`);
  return result.value.label;
}

async function sample() {
  const [{ page }, browserVersion] = await Promise.all([
    targets(),
    readJson(`${endpoint}/json/version`),
  ]);
  const pageClient = new CdpClient(page.webSocketDebuggerUrl);
  const browserClient = new CdpClient(browserVersion.webSocketDebuggerUrl);

  try {
    await Promise.all([
      pageClient.send('Performance.enable'),
      pageClient.send('Runtime.enable'),
    ]);

    const [beforeMetricsResult, beforeDom, beforeProcessesResult] = await Promise.all([
      pageClient.send('Performance.getMetrics'),
      pageClient.send('Memory.getDOMCounters'),
      browserClient.send('SystemInfo.getProcessInfo'),
    ]);
    const beforeMetrics = metricsMap(beforeMetricsResult);
    const beforeProcesses = processSnapshot(beforeProcessesResult);

    const clicked = [];
    const startedAt = Date.now();
    let clickIndex = 0;
    while (Date.now() - startedAt < durationMs) {
      if (clickLabels.length > 0) {
        clicked.push(await clickByLabel(pageClient, clickLabels[clickIndex % clickLabels.length]));
        clickIndex += 1;
      }
      await sleep(Math.min(1000, Math.max(0, durationMs - (Date.now() - startedAt))));
    }

    const [afterMetricsResult, afterDom, afterProcessesResult] = await Promise.all([
      pageClient.send('Performance.getMetrics'),
      pageClient.send('Memory.getDOMCounters'),
      browserClient.send('SystemInfo.getProcessInfo'),
    ]);
    const afterMetrics = metricsMap(afterMetricsResult);
    const afterProcesses = processSnapshot(afterProcessesResult);
    const actualDurationMs = Date.now() - startedAt;

    const report = {
      label,
      capturedAt: new Date().toISOString(),
      endpoint,
      page: { title: page.title, url: page.url },
      durationMs: actualDurationMs,
      workload: { requestedClicks: clickLabels, completedClicks: clicked },
      renderer: {
        jsHeapUsedMb: mb(afterMetrics.JSHeapUsedSize ?? 0),
        jsHeapTotalMb: mb(afterMetrics.JSHeapTotalSize ?? 0),
        documents: afterDom.documents,
        nodes: afterDom.nodes,
        listeners: afterDom.jsEventListeners,
        nodeDelta: afterDom.nodes - beforeDom.nodes,
        listenerDelta: afterDom.jsEventListeners - beforeDom.jsEventListeners,
        taskDurationMs: metricDelta(beforeMetrics, afterMetrics, 'TaskDuration', 1000),
        scriptDurationMs: metricDelta(beforeMetrics, afterMetrics, 'ScriptDuration', 1000),
        layoutDurationMs: metricDelta(beforeMetrics, afterMetrics, 'LayoutDuration', 1000),
        recalcStyleDurationMs: metricDelta(beforeMetrics, afterMetrics, 'RecalcStyleDuration', 1000),
        layoutCount: metricDelta(beforeMetrics, afterMetrics, 'LayoutCount'),
        recalcStyleCount: metricDelta(beforeMetrics, afterMetrics, 'RecalcStyleCount'),
      },
      processes: processDeltas(beforeProcesses, afterProcesses),
    };

    const json = JSON.stringify(report, null, 2);
    console.log(json);
    if (outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${json}\n`);
    }
  } finally {
    pageClient.close();
    browserClient.close();
  }
}

// ---------------------------------------------------------------------------
// Main-process profiling (V8 inspector on --inspect-port)
// ---------------------------------------------------------------------------

const inspectEndpoint = `http://${host}:${inspectPort}`;

/**
 * Resolve the main-process inspector target. Electron's `--inspect` exposes a
 * single `node` target; we accept the first entry either way so this keeps
 * working if the shape changes.
 */
async function mainTarget() {
  let list;
  try {
    list = await readJson(`${inspectEndpoint}/json/list`);
  } catch (error) {
    throw new Error(
      `No main-process inspector at ${inspectEndpoint} (${error.message}). ` +
        'Launch the app with `pnpm dev:perf`, which adds --inspect.',
    );
  }
  const target = list.find((entry) => entry.webSocketDebuggerUrl);
  if (!target) throw new Error(`No debuggable target at ${inspectEndpoint}`);
  return target;
}

function frameLabel(callFrame) {
  const name = callFrame.functionName || '(anonymous)';
  const url = (callFrame.url || '').replace(/^file:\/\//, '');
  // Keep the tail of the path — enough to identify the module, short enough to read.
  const shortUrl = url ? url.split('/').slice(-2).join('/') : '(native)';
  return `${name} @ ${shortUrl}:${(callFrame.lineNumber ?? 0) + 1}`;
}

/**
 * Fold a .cpuprofile into self-time per function plus per-file totals.
 *
 * V8 reports `samples` (node ids) and `timeDeltas` (µs since the previous
 * sample), so self time for a node is the sum of the deltas of the samples that
 * landed on it — the honest "which function was actually on-CPU" measure.
 */
function foldCpuProfile(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicros = new Map();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];

  let totalMicros = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const delta = Math.max(0, deltas[i] ?? 0);
    totalMicros += delta;
    selfMicros.set(samples[i], (selfMicros.get(samples[i]) ?? 0) + delta);
  }

  const functions = [];
  const byFile = new Map();
  let idleMicros = 0;

  for (const [id, micros] of selfMicros) {
    const node = byId.get(id);
    if (!node) continue;
    const name = node.callFrame.functionName;
    if (name === '(idle)' || name === '(program)') {
      idleMicros += micros;
      continue;
    }
    functions.push({ label: frameLabel(node.callFrame), ms: micros / 1000, hits: node.hitCount ?? 0 });

    const url = (node.callFrame.url || '').replace(/^file:\/\//, '');
    const file = url ? url.split('/').slice(-2).join('/') : '(native)';
    byFile.set(file, (byFile.get(file) ?? 0) + micros);
  }

  functions.sort((a, b) => b.ms - a.ms);
  const files = [...byFile.entries()]
    .map(([file, micros]) => ({ file, ms: micros / 1000 }))
    .sort((a, b) => b.ms - a.ms);

  return {
    totalMs: totalMicros / 1000,
    idleMs: idleMicros / 1000,
    busyMs: (totalMicros - idleMicros) / 1000,
    functions,
    files,
  };
}

async function cpu() {
  // `--target renderer` profiles the React renderer over the normal CDP port
  // instead of the main process over the inspector port; everything downstream
  // (folding, reporting) is identical because both speak the same Profiler
  // domain.
  const useRenderer = option('--target', 'main') === 'renderer';
  const target = useRenderer ? (await targets()).page : await mainTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send('Profiler.enable');
    // 200µs — ~5x finer than the 1ms default, which matters when total busy time
    // over the window is only a few hundred ms.
    await client.send('Profiler.setSamplingInterval', { interval: 200 });
    await client.send('Profiler.start');
    if (useRenderer && clickLabels.length > 0) {
      // Drive the same workload the `sample` command drives, so the profile
      // explains a measured number rather than an idle window.
      const startedAt = Date.now();
      let index = 0;
      while (Date.now() - startedAt < durationMs) {
        await clickByLabel(client, clickLabels[index % clickLabels.length]);
        index += 1;
        await sleep(1000);
      }
    } else {
      await sleep(durationMs);
    }
    const { profile } = await client.send('Profiler.stop');
    await client.send('Profiler.disable');

    const folded = foldCpuProfile(profile);
    const wallMs = (profile.endTime - profile.startTime) / 1000;

    const report = {
      label,
      capturedAt: new Date().toISOString(),
      endpoint: inspectEndpoint,
      target: target.title ?? target.url,
      wallMs: round(wallMs),
      busyMs: round(folded.busyMs),
      idleMs: round(folded.idleMs),
      cpuPercent: round((folded.busyMs / wallMs) * 100),
      topFunctions: folded.functions.slice(0, topN).map((fn) => ({
        ms: round(fn.ms),
        percentOfBusy: round((fn.ms / Math.max(folded.busyMs, 0.001)) * 100),
        fn: fn.label,
      })),
      topFiles: folded.files.slice(0, topN).map((entry) => ({
        ms: round(entry.ms),
        percentOfBusy: round((entry.ms / Math.max(folded.busyMs, 0.001)) * 100),
        file: entry.file,
      })),
    };

    console.log(JSON.stringify(report, null, 2));

    const targetPath = outputPath ?? `.perf/${label}.cpuprofile`;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, JSON.stringify(profile));
    console.error(`\n[raw profile written to ${targetPath} — open in Chrome DevTools > Performance]`);
  } finally {
    client.close();
  }
}

/**
 * Fold a V8 sampling heap profile into bytes-allocated per allocation site.
 * The tree carries `selfSize` per node; children accumulate separately.
 */
function foldHeapProfile(node, out = new Map()) {
  if (node.selfSize > 0) {
    const key = frameLabel(node.callFrame);
    out.set(key, (out.get(key) ?? 0) + node.selfSize);
  }
  for (const child of node.children ?? []) foldHeapProfile(child, out);
  return out;
}

async function heap() {
  const target = await mainTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send('HeapProfiler.enable');
    const before = await client.send('Runtime.getHeapUsage').catch(() => null);
    // 16KB sampling interval — fine enough to catch steady per-tick churn.
    await client.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
    await sleep(durationMs);
    const { profile } = await client.send('HeapProfiler.stopSampling');
    const after = await client.send('Runtime.getHeapUsage').catch(() => null);
    await client.send('HeapProfiler.disable');

    const folded = [...foldHeapProfile(profile.head).entries()]
      .map(([site, bytes]) => ({ site, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    const totalBytes = folded.reduce((sum, entry) => sum + entry.bytes, 0);

    const report = {
      label,
      capturedAt: new Date().toISOString(),
      endpoint: inspectEndpoint,
      durationMs,
      heapUsedMbBefore: before ? mb(before.usedSize) : null,
      heapUsedMbAfter: after ? mb(after.usedSize) : null,
      totalAllocatedMb: mb(totalBytes),
      allocatedMbPerMinute: round((totalBytes / 1024 / 1024) * (60000 / durationMs), 2),
      topAllocationSites: folded.slice(0, topN).map((entry) => ({
        mb: mb(entry.bytes),
        percent: round((entry.bytes / Math.max(totalBytes, 1)) * 100),
        site: entry.site,
      })),
    };

    console.log(JSON.stringify(report, null, 2));
    if (outputPath) {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    }
  } finally {
    client.close();
  }
}

/**
 * Census the main process's live libuv handles (what is keeping the loop alive
 * right now). In Electron the main loop is Chromium's message pump with node
 * integration polled on top, so every libuv wakeup costs a cross-thread signal
 * + a pump round trip.
 *
 * This reports STANDING handles, not a rate. For wakeups-per-second attributed
 * to the code that scheduled them, use the in-process TimerCensus — the
 * `[perf-timers]` line under `pnpm dev:perf`.
 */
async function handles() {
  const target = await mainTarget();
  const client = new CdpClient(target.webSocketDebuggerUrl);
  try {
    await client.send('Runtime.enable');

    const measure = `(() => {
      const counts = {};
      for (const kind of process.getActiveResourcesInfo()) {
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return counts;
    })()`;

    // Walk node's internal timer lists to read the delay of every LIVE timer.
    // process._getActiveHandles() is the only surface that exposes them.
    const liveTimers = `(() => {
      const out = [];
      const handles = process._getActiveHandles ? process._getActiveHandles() : [];
      for (const h of handles) {
        const name = h && h.constructor ? h.constructor.name : typeof h;
        const entry = { type: name };
        if (typeof h._idleTimeout === 'number' && h._idleTimeout >= 0) entry.delayMs = h._idleTimeout;
        if (typeof h._repeat === 'number') entry.repeatMs = h._repeat;
        out.push(entry);
      }
      // Node keeps Timeouts off _getActiveHandles in modern versions; also walk
      // the internal timers map when reachable.
      return out;
    })()`;

    const [censusRes, timersRes] = await Promise.all([
      client.send('Runtime.evaluate', { expression: measure, returnByValue: true, includeCommandLineAPI: true }),
      client.send('Runtime.evaluate', { expression: liveTimers, returnByValue: true, includeCommandLineAPI: true }),
    ]);

    // NOTE: there is deliberately no "wakeup rate" number here. An earlier
    // version scheduled its own `setInterval(…, 1)` and reported how fast THAT
    // fired, which measures the profiler's own timer, not the app's — an idle
    // app and one already carrying a 60Hz interval produced nearly identical
    // figures. Timer wakeup RATE comes from the in-process TimerCensus
    // (`[perf-timers]` under `pnpm dev:perf`), which counts real fires per site;
    // this command reports the live HANDLE census only.
    console.log(JSON.stringify({
      label,
      capturedAt: new Date().toISOString(),
      activeResources: censusRes.result.value,
      activeHandles: timersRes.result.value,
    }, null, 2));
  } finally {
    client.close();
  }
}

if (command === 'inspect') await inspect();
else if (command === 'sample') await sample();
else if (command === 'cpu') await cpu();
else if (command === 'heap') await heap();
else if (command === 'handles') await handles();
else throw new Error(`Unknown command: ${command}`);
