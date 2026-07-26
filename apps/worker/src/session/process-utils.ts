import { spawn, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { connect } from "net";

export interface ManagedProcess {
  name: string;
  child: ChildProcess;
}

export function spawnManaged(
  name: string,
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): ManagedProcess {
  const child = spawn(command, args, {
    env: env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });
  child.stdout?.resume();
  child.stderr?.resume();
  return { name, child };
}

/** SIGTERM, then SIGKILL if the process refuses to exit. */
export async function killManaged(proc: ManagedProcess, graceMs = 3000): Promise<void> {
  const { child } = proc;
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once("exit", done);
    try {
      child.kill("SIGTERM");
    } catch {
      done();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done();
    }, graceMs);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const finish = (result: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

export async function waitForPort(port: number, timeoutMs = 15000, host = "127.0.0.1"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(port, host)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${host}:${port} to accept connections`);
}

export async function waitForFile(path: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path} to appear`);
}
