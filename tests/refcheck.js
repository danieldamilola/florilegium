'use strict';
/*
 * Builds a throwaway copy of the app (from any git ref) outside the repo and
 * points the acceptance suite at it. Used to check the suite against both the
 * baseline prototype and the in-flight full-book implementation without ever
 * touching index.html in the working tree.
 *
 *   node tests/_refcheck.js build <ref> <destDir>
 *   node tests/_refcheck.js run   <destDir> [testNamePattern]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TESTS = ['e2e.test.js', 'helpers.js', 'netstub.js', 'check-helpers.js'];

function build(ref, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'index.html'), execFileSync('git', ['show', `${ref}:index.html`], { maxBuffer: 1e9 }));
  for (const f of TESTS) fs.copyFileSync(path.join(__dirname, f), path.join(dest, 'tests', f));
  console.log(`built ${ref} -> ${dest}`);
}

function run(dest, pattern) {
  const args = ['--test', '--test-reporter=tap'];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  args.push('tests/e2e.test.js');
  const env = { ...process.env, FLORI_PORT: process.env.FLORI_REF_PORT || '4182' };
  console.log(`--- suite against ${dest} (app ${fs.statSync(path.join(dest, 'index.html')).size} bytes) ---`);
  try {
    const out = execFileSync(process.execPath, args, { cwd: dest, env, encoding: 'utf8', maxBuffer: 1e9 });
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write(e.stdout || '');
  }
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'build') build(a, b);
else if (cmd === 'run') run(a, b);