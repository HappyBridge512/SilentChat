const { execFileSync } = require('child_process');

function listPidsOnPort(port) {
  if (process.platform === 'win32') {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const lines = output.split(/\r?\n/);
    const pids = new Set();

    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      if (!line.includes(`:${port}`)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }

  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${port}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((x) => Number(x))
      .filter((x) => Number.isInteger(x) && x > 0);
  } catch (_error) {
    return [];
  }
}

function killPids(pids) {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: ['ignore', 'ignore', 'ignore'] });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.log(`Stopped process ${pid}`);
    } catch (_error) {
      // Process may have already exited.
    }
  }
}

const port = Number(process.argv[2] || process.env.PORT || 3000);
if (!Number.isInteger(port) || port <= 0) {
  console.error('Invalid port');
  process.exit(1);
}

const pids = listPidsOnPort(port);
if (pids.length === 0) {
  console.log(`Port ${port} is free`);
  process.exit(0);
}

killPids(pids);
console.log(`Port ${port} cleared`);
