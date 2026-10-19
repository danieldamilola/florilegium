'use strict';
/*
 * Self-check for the in-page helper bundle (QA_HELPERS in helpers.js).
 *
 * The bundle is injected into the browser as a template literal, so escaping
 * bugs are invisible until they silently disable a detector or break parsing.
 * Two failures have already been caused by this in the suite's history:
 *   - a single \b became a backspace and killed the end-of-book detector
 *   - a single \n inside a string broke the whole bundle (caught by the parse
 *     check below, after it had already broken a test run)
 *
 * Run standalone: node tests/check-helpers.js   (exit 1 on failure)
 * Also executed as a case inside tests/e2e.test.js.
 */
const fs = require('fs');
const path = require('path');

function inspectHelpers() {
  const file = path.join(__dirname, 'helpers.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const QA_HELPERS = ');
  if (start < 0) throw new Error('QA_HELPERS not found in helpers.js');
  const q1 = src.indexOf('`', start);
  const q2 = src.indexOf('`', q1 + 1);
  if (q1 < 0 || q2 < 0) throw new Error('QA_HELPERS template bounds not found');

  // Must match how helpers.js builds the string (String.raw keeps backslashes).
  const usesRaw = src.slice(start, start + 64).includes('String.raw');
  const body = src.slice(q1 + 1, q2);
  const evaluated = usesRaw ? String.raw({ raw: [body.replace(/\\`/g, '`')] }) : eval('`' + body + '`');

  const problems = [];
  for (let i = 0; i < evaluated.length; i++) {
    const c = evaluated.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 9 && c !== 13) problems.push({ code: c, at: evaluated.slice(Math.max(0, i - 40), i + 20) });
  }
  try {
    new Function(evaluated);
  } catch (e) {
    problems.push({ code: 'parse', at: e.message });
  }
  if (!evaluated.includes('readerState')) problems.push({ code: 'missing', at: 'readerState is not exported' });
  if (!evaluated.includes('function endState')) problems.push({ code: 'missing', at: 'endState detector is missing' });
  return { problems, evaluated, usesRaw };
}

module.exports = { inspectHelpers };

if (require.main === module) {
  const { problems, evaluated, usesRaw } = inspectHelpers();
  console.log(`QA_HELPERS built with String.raw: ${usesRaw}`);
  console.log('unexpected control characters / parse errors:', problems.length);
  problems.slice(0, 20).forEach(p => console.log(' ', p.code, JSON.stringify(p.at)));
  console.log('endOfBook line:', (evaluated.split('\n').find(l => l.includes('endOfBook:')) || '').trim());
  console.log('endState marker:', (evaluated.split('\n').find(l => l.includes('var MARK=')) || '').trim());
  console.log('split line:', (evaluated.split('\n').find(l => l.includes('var lines=')) || '').trim());
  process.exit(problems.length ? 1 : 0);
}