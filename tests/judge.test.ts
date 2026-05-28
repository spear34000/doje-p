import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { judgeSubmission } from '../src/lib/judge';

const HAS_DOCKER = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

test('judgeSubmission accepts matching nodejs output for every testcase', { skip: !HAS_DOCKER }, async () => {
  const result = await judgeSubmission({
    language: 'nodejs',
    code: "const fs=require('fs'); const n=Number(fs.readFileSync(0,'utf8')); console.log(n*2);",
    timeLimitMs: 1000,
    memoryLimitMb: 128,
    testcases: [
      { id: 'a', input: '2\n', output: '4\n' },
      { id: 'b', input: '7\n', output: '14\n' },
    ],
  });

  assert.equal(result.status, 'AC');
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.status === 'AC'));
});

test('judgeSubmission returns WA when output differs', { skip: !HAS_DOCKER }, async () => {
  const result = await judgeSubmission({
    language: 'nodejs',
    code: "console.log('wrong');",
    timeLimitMs: 1000,
    memoryLimitMb: 128,
    testcases: [{ id: 'a', input: '', output: 'right\n' }],
  });

  assert.equal(result.status, 'WA');
  assert.equal(result.results[0]?.status, 'WA');
});

test('judgeSubmission returns TLE when execution exceeds time limit', { skip: !HAS_DOCKER }, async () => {
  const result = await judgeSubmission({
    language: 'nodejs',
    code: 'while (true) {}',
    timeLimitMs: 100,
    memoryLimitMb: 128,
    testcases: [{ id: 'a', input: '', output: '' }],
  });

  assert.equal(result.status, 'TLE');
});

test('judgeSubmission returns OLE when output is too large', { skip: !HAS_DOCKER }, async () => {
  const result = await judgeSubmission({
    language: 'nodejs',
    code: "console.log('x'.repeat(1100000));",
    timeLimitMs: 1000,
    memoryLimitMb: 128,
    testcases: [{ id: 'a', input: '', output: '' }],
  });

  assert.equal(result.status, 'OLE');
});

test('judgeSubmission compiles and runs C++ submissions', { skip: !HAS_DOCKER }, async () => {
  const result = await judgeSubmission({
    language: 'cpp',
    code: '#include <iostream>\nusing namespace std;\nint main(){int n;cin>>n;cout<<n*3<<"\\n";}',
    timeLimitMs: 1000,
    memoryLimitMb: 128,
    testcases: [{ id: 'a', input: '5\n', output: '15\n' }],
  });

  assert.equal(result.status, 'AC');
});
