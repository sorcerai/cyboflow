/**
 * Smoke test for build/verifyArtifact.js (artifactBuildCompleted size floor).
 * Run as: node build/verifyArtifact.test.js
 * Exits 0 on success, 1 on any failure.
 *
 * Fixtures are sparse files: ftruncate gives a 120 MB apparent size at no disk
 * cost, and the check under test reads st.size — which is exactly the number
 * that was wrong in the 215K-stub release.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const verifyArtifactModule = require('./verifyArtifact');
const verifyArtifact = verifyArtifactModule.default;
const helpers = verifyArtifactModule._helpers;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    failed++;
  } else {
    console.log('PASS:', message);
    passed++;
  }
}

/** Run the hook capturing warnings and the thrown error. */
async function runCapturing(ctx) {
  const warnings = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = () => {};
  let error = null;
  try {
    await verifyArtifact(ctx);
  } catch (err) {
    error = err;
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
  return { error, message: error ? error.message : '', warnings };
}

function macArtifact(file) {
  return { file, arch: 3, packager: { platform: { name: 'mac' } } };
}

function writeSparseFile(file, bytes) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

async function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifyartifact-test-'));
  try {
    return await fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case A: only distributables are judged
// ---------------------------------------------------------------------------
async function caseA() {
  const { shouldVerifyArtifact } = helpers;
  assert(shouldVerifyArtifact('/out/Cyboflow-1.0.0-macOS-arm64.dmg'), 'Case A: .dmg is checked');
  assert(shouldVerifyArtifact('/out/Cyboflow-1.0.0-macOS-arm64.zip'), 'Case A: .zip is checked');
  assert(shouldVerifyArtifact('/out/APP.DMG'), 'Case A: the extension match is case-insensitive');
  assert(
    !shouldVerifyArtifact('/out/Cyboflow-1.0.0-macOS-arm64.zip.blockmap'),
    'Case A: .blockmap is ignored'
  );
  assert(!shouldVerifyArtifact('/out/latest-mac.yml'), 'Case A: latest-mac.yml is ignored');
  assert(!shouldVerifyArtifact(undefined), 'Case A: a missing file name is ignored');
}

// ---------------------------------------------------------------------------
// Case B: an undersized DMG hard-fails — the 215K stub
// ---------------------------------------------------------------------------
async function caseB() {
  await withTmpDir(async (tmpDir) => {
    const dmg = path.join(tmpDir, 'Cyboflow-9.9.9-macOS-arm64.dmg');
    writeSparseFile(dmg, 215 * 1024);

    const { message } = await runCapturing(macArtifact(dmg));
    assert(message !== '', 'Case B: a 215K DMG throws');
    assert(message.includes('is only 0.2 MB'), 'Case B: the error reports the actual size');
    assert(message.includes('floor is 100.0 MB'), 'Case B: the error reports the floor');
    assert(message.includes('that is a stub'), 'Case B: the error explains what went wrong');
  });
}

// ---------------------------------------------------------------------------
// Case C: a full-size DMG passes
// ---------------------------------------------------------------------------
async function caseC() {
  await withTmpDir(async (tmpDir) => {
    const dmg = path.join(tmpDir, 'Cyboflow-9.9.9-macOS-arm64.dmg');
    writeSparseFile(dmg, 120 * 1024 * 1024);

    const { error, warnings } = await runCapturing(macArtifact(dmg));
    assert(error === null, 'Case C: a 120 MB DMG passes');
    assert(warnings.length === 0, 'Case C: a passing artifact emits no warnings');
  });
}

// ---------------------------------------------------------------------------
// Case D: non-distributable artifacts are not judged even when tiny
// ---------------------------------------------------------------------------
async function caseD() {
  await withTmpDir(async (tmpDir) => {
    const blockmap = path.join(tmpDir, 'Cyboflow-9.9.9-macOS-arm64.dmg.blockmap');
    fs.writeFileSync(blockmap, 'tiny');
    const { error } = await runCapturing(macArtifact(blockmap));
    assert(error === null, 'Case D: a tiny .blockmap does not throw');

    const yml = path.join(tmpDir, 'latest-mac.yml');
    fs.writeFileSync(yml, 'version: 9.9.9\n');
    const ymlResult = await runCapturing(macArtifact(yml));
    assert(ymlResult.error === null, 'Case D: latest-mac.yml does not throw');
  });
}

// ---------------------------------------------------------------------------
// Case E: non-mac platforms return early
// ---------------------------------------------------------------------------
async function caseE() {
  await withTmpDir(async (tmpDir) => {
    const dmg = path.join(tmpDir, 'stub.dmg');
    writeSparseFile(dmg, 1024);
    const { error } = await runCapturing({
      file: dmg,
      arch: 1,
      packager: { platform: { name: 'linux' } }
    });
    assert(error === null, 'Case E: a non-mac artifact is not judged');
  });
}

// ---------------------------------------------------------------------------
// Case F: CYBOFLOW_SKIP_BUNDLE_CHECKS=1 skips the floor, loudly
// ---------------------------------------------------------------------------
async function caseF() {
  await withTmpDir(async (tmpDir) => {
    const dmg = path.join(tmpDir, 'stub.dmg');
    writeSparseFile(dmg, 215 * 1024);

    const previous = process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
    process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = '1';
    let result;
    try {
      result = await runCapturing(macArtifact(dmg));
    } finally {
      if (previous === undefined) delete process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS;
      else process.env.CYBOFLOW_SKIP_BUNDLE_CHECKS = previous;
    }

    assert(result.error === null, 'Case F: the skip switch suppresses the failure');
    assert(
      result.warnings.join('\n').includes('CYBOFLOW_SKIP_BUNDLE_CHECKS=1'),
      'Case F: the skip is announced loudly'
    );
  });
}

// ---------------------------------------------------------------------------
// Case G: an artifact electron-builder announced but did not write
// ---------------------------------------------------------------------------
async function caseG() {
  await withTmpDir(async (tmpDir) => {
    const { message } = await runCapturing(macArtifact(path.join(tmpDir, 'ghost.dmg')));
    assert(
      message.includes('does not exist on disk'),
      'Case G: a missing artifact throws rather than silently passing'
    );
  });
}

// ---------------------------------------------------------------------------
// Case H: the floor is injectable for callers that need a different bar
// ---------------------------------------------------------------------------
async function caseH() {
  await withTmpDir(async (tmpDir) => {
    const dmg = path.join(tmpDir, 'small.dmg');
    writeSparseFile(dmg, 2 * 1024 * 1024);
    assert(
      helpers.verifyArtifactFile(dmg, 1024 * 1024) === null,
      'Case H: a 2 MB DMG clears a 1 MB floor'
    );
    assert(
      helpers.verifyArtifactFile(dmg, 4 * 1024 * 1024) !== null,
      'Case H: the same DMG fails a 4 MB floor'
    );
    assert(
      helpers.DEFAULT_MIN_ARTIFACT_BYTES === 100 * 1024 * 1024,
      'Case H: the shipped floor is 100 MB'
    );
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('--- verifyArtifact smoke test ---');
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  await caseE();
  await caseF();
  await caseG();
  await caseH();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
