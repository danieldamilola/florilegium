'use strict';
/*
 * Guard against a trap this suite already fell into once: the in-page helper
 * bundle is a JS template literal, so a stray single backslash (\b, \s, \n)
 * silently becomes a control character in the browser and quietly disables a
 * whole detection branch. node/check-helpers.js is also runnable standalone.
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
  const evaluated = eval('`' + src.slice(q1 + 1, q2) + '`');
  const bad = [];
  for (let i = 0; i < evaluated.length; i++) {
    const c = evaluated.charCodeAt(i);
    if (c < 32 && c !== 10 && c !== 9 && c !== 13) bad.push({ code: c, at: evaluated.slice(Math.max(0, i - 40), i + 20) });
  }
  return { bad, evaluated };
}

module.exports = { inspectHelpers };

if (require.main === module) {
  const { bad, evaluated } = inspectHelpers();
  console.log('unexpected control characters in QA_HELPERS:', bad.length);
  bad.slice(0, 20).forEach(b => console.log(' ', b.code, JSON.stringify(b.at)));
  console.log('endOfBook line:', (evaluated.split('\n').find(l => l.includes('endOfBook:')) || '').trim());
  process.exit(bad.length ? 1 : 0);
}