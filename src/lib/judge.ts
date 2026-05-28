import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import type { SubmissionStatus } from '@/types';

type Testcase = {
  id: string;
  input: string;
  output: string;
};

type LangConfig = {
  image: string;
  file: string;
  compile?: string[];
  run: string[];
};

export type JudgeInput = {
  language: string;
  code: string;
  timeLimitMs: number;
  memoryLimitMb: number;
  testcases: Testcase[];
};

export type JudgeResult = {
  status: SubmissionStatus;
  execTime?: number;
  memory?: number;
  message?: string;
  results: {
    testcaseId: string;
    status: SubmissionStatus;
    time: number;
    memory: number;
  }[];
};

const OUTPUT_LIMIT = 1_000_000;
const DOCKER_TIMEOUT_BUFFER = 10_000;

const LANG_CONFIGS: Record<string, LangConfig> = {
  nodejs: { image: 'node:20-slim', file: 'main.js', run: ['node', '/code/main.js'] },
  javascript: { image: 'node:20-slim', file: 'main.js', run: ['node', '/code/main.js'] },
  python: { image: 'python:3-slim', file: 'main.py', run: ['python3', '/code/main.py'] },
  c: {
    image: 'gcc:latest',
    file: 'main.c',
    compile: ['gcc', '-O2', '-std=c11', '-o', '/code/main', '/code/main.c'],
    run: ['/code/main'],
  },
  cpp: {
    image: 'gcc:latest',
    file: 'main.cpp',
    compile: ['g++', '-O2', '-std=c++17', '-o', '/code/main', '/code/main.cpp'],
    run: ['/code/main'],
  },
  java: {
    image: 'eclipse-temurin:17-jdk',
    file: 'Main.java',
    compile: ['javac', '-d', '/code', '/code/Main.java'],
    run: ['java', '-cp', '/code', 'Main'],
  },
};

const pulledImages = new Set<string>();

function normalizeOutput(value: string) {
  return value.replace(/\r\n/g, '\n').trimEnd();
}

function runDocker(
  image: string,
  cmd: string[],
  codeDir: string,
  input: string,
  timeLimitMs: number,
  memoryLimitMb: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; outputExceeded: boolean; time: number }> {
  return new Promise((resolve) => {
    const started = performance.now();
    const args = [
      'run', '--rm',
      '-v', `${codeDir}:/code`,
      '-m', `${memoryLimitMb}m`,
      '--cpus', '1',
      '--network', 'none',
      '--init',
      image,
      ...cmd,
    ];

    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeLimitMs + DOCKER_TIMEOUT_BUFFER);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > OUTPUT_LIMIT) {
        outputExceeded = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: 1, timedOut: false, outputExceeded: false, time: Math.round(performance.now() - started) }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const elapsed = Math.round(performance.now() - started);
      resolve({ stdout, stderr, exitCode: outputExceeded ? -1 : (timedOut ? -1 : (code ?? 1)), timedOut, outputExceeded, time: elapsed });
    });
    child.stdin.end(input);
  });
}

async function ensureImage(image: string): Promise<boolean> {
  if (pulledImages.has(image)) return true;
  return new Promise((resolve) => {
    const child = spawn('docker', ['pull', '-q', image], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      if (code === 0) pulledImages.add(image);
      resolve(code === 0);
    });
  });
}

async function compileInContainer(config: LangConfig, codeDir: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', [
      'run', '--rm',
      '-v', `${codeDir}:/code`,
      '-m', '512m',
      '--cpus', '2',
      '--network', 'none',
      config.image,
      ...config.compile!,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, stderr: 'docker error' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
  });
}

export async function judgeSubmission(input: JudgeInput): Promise<JudgeResult> {
  const config = LANG_CONFIGS[input.language];
  if (!config) {
    return { status: 'CE', message: '지원하지 않는 언어입니다.', results: [] };
  }
  if (input.testcases.length === 0) {
    return { status: 'JE', message: '등록된 테스트케이스가 없습니다.', results: [] };
  }

  const ok = await ensureImage(config.image);
  if (!ok) {
    return { status: 'JE', message: `Docker 이미지(${config.image})를 가져올 수 없습니다. Docker 데몬이 실행 중인지 확인하세요.`, results: [] };
  }

  const dir = await mkdtemp(`${tmpdir()}/sco-judge-`);
  try {
    await writeFile(`${dir}/${config.file}`, input.code, 'utf8');

    if (config.compile) {
      const compiled = await compileInContainer(config, dir);
      if (!compiled.ok) {
        return {
          status: 'CE',
          message: compiled.stderr.slice(0, 800) || '컴파일에 실패했습니다.',
          results: [],
        };
      }
    }

    const results: JudgeResult['results'] = [];
    let maxTime = 0;
    for (const tc of input.testcases) {
      const r = await runDocker(config.image, config.run, dir, tc.input, input.timeLimitMs, input.memoryLimitMb);

      if (r.outputExceeded) {
        results.push({ testcaseId: tc.id, status: 'OLE', time: r.time, memory: input.memoryLimitMb });
        return { status: 'OLE', execTime: r.time, memory: input.memoryLimitMb, results };
      }
      if (r.timedOut) {
        results.push({ testcaseId: tc.id, status: 'TLE', time: input.timeLimitMs, memory: input.memoryLimitMb });
        return { status: 'TLE', execTime: input.timeLimitMs, memory: input.memoryLimitMb, results };
      }
      if (r.exitCode !== 0) {
        results.push({ testcaseId: tc.id, status: 'RE', time: r.time, memory: input.memoryLimitMb });
        return { status: 'RE', execTime: Math.max(maxTime, r.time), memory: input.memoryLimitMb, message: r.stderr.slice(0, 500) || undefined, results };
      }

      const isAc = normalizeOutput(r.stdout) === normalizeOutput(tc.output);
      maxTime = Math.max(maxTime, r.time);

      results.push({
        testcaseId: tc.id,
        status: isAc ? 'AC' : 'WA',
        time: r.time,
        memory: input.memoryLimitMb,
      });

      if (!isAc) {
        return { status: 'WA', execTime: maxTime, memory: input.memoryLimitMb, results };
      }
    }

    return { status: 'AC', execTime: maxTime, memory: input.memoryLimitMb, results };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function statusLabel(status: SubmissionStatus) {
  return (
    {
      AC: '맞았습니다',
      WA: '틀렸습니다',
      TLE: '시간 초과',
      MLE: '메모리 초과',
      RE: '런타임 에러',
      CE: '컴파일 에러',
      JE: '채점 오류',
      PE: '출력 형식 오류',
      OLE: '출력 초과',
      PENDING: '대기 중',
      RUNNING: '채점 중',
    } satisfies Record<SubmissionStatus, string>
  )[status];
}
