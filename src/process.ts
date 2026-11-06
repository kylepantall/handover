export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program (no shell) and collects its output. */
export async function runProcess(cmd: string, args: string[], { timeoutMs = 30_000 } = {}): Promise<ProcessResult> {
  const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
