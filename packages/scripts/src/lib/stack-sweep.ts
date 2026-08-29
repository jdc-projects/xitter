import { capture } from './exec.js';

/** A compose project (env copy) with its containers, as `docker compose ls` sees it. */
export interface ComposeProjectInfo {
  name: string;
  status: string;
}

/** A stack must dead-answer longer than a full bootstrap to be swept. */
const STACK_GRACE_MS = 10 * 60_000;

/**
 * Stale sibling-stack detection (#175): a project is abandoned when its
 * containers exist but its edge serves only Bad Gateway - the killed
 * worker session's apps never came back, and its teardown never ran.
 * The edge port is read from docker itself (env name and port offset are
 * independent - deriving the port from the project name is wrong).
 */
export interface StackLiveness {
  /** Projects with running containers whose edge port is dead. */
  stale: ComposeProjectInfo[];
  /** Projects whose edge port answered (or whose state could not be read). */
  live: ComposeProjectInfo[];
}

export async function listComposeProjects(): Promise<ComposeProjectInfo[]> {
  const stdout = await capture('docker', ['compose', 'ls', '--all', '--format', 'json']).catch(
    () => '',
  );
  if (!stdout.trim()) return [];
  try {
    const parsed = JSON.parse(stdout) as Array<{ Name?: string; Status?: string }>;
    return parsed
      .filter((row) => typeof row.Name === 'string')
      .map((row) => ({ name: row.Name!, status: row.Status ?? '' }));
  } catch {
    return [];
  }
}

/** `80/tcp -> 0.0.0.0:38080` (docker port) -> 38080; accepts ps forms too. */
export function parsePublishedHostPort(ports: string): number | null {
  const match = /(?:0\.0\.0\.0:|\[::]:|127\.0\.0\.1:)(\d+)(?:->|\s|$)/.exec(ports);
  return match ? Number(match[1]) : null;
}

/**
 * The project's edge (traefik) container's published host port, from the
 * compose project label. Null when the project has no edge container or
 * it publishes nothing.
 */
async function projectEdgePort(project: string): Promise<number | null> {
  // Names only: podman's docker-compat `ps {{.Ports}}` omits host bindings,
  // so the mapping is read via `docker port` (which shows them reliably).
  const stdout = await capture('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Names}}',
  ]).catch(() => '');
  const traefik = stdout
    .split('\n')
    .map((line) => line.trim())
    .find((name) => name.includes('traefik'));
  if (!traefik) return null;
  const mappings = await capture('docker', ['port', traefik]).catch(() => '');
  for (const line of mappings.split('\n')) {
    const port = parsePublishedHostPort(line);
    if (port !== null) return port;
  }
  return null;
}

/**
 * How the stack answers HTTP on its edge port. A live stack serves real
 * responses (any status); a stale one - containers running, apps dead -
 * has traefik answering 502 Bad Gateway for every route. Connection
 * failures mean the edge itself is down (not this sweep's case).
 */
async function edgeResponds(port: number): Promise<'live' | 'stale' | 'unknown'> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(2_000),
    });
    if (res.status === 502 || res.status === 503) return 'stale';
    return 'live';
  } catch {
    return 'unknown';
  }
}

/**
 * Container-set age of a project (oldest container's Created timestamp).
 * Podman emits `2026-08-29 01:04:06 +0100 BST` - the trailing zone NAME
 * breaks Date.parse, so it is stripped; the numeric offset survives.
 */
export function parseDockerCreatedAt(line: string): number | null {
  const withoutZoneName = line.replace(/\s+[A-Za-z]{2,5}$/, '');
  const ms = Date.parse(
    withoutZoneName.endsWith('Z')
      ? withoutZoneName
      : `${withoutZoneName}Z`.replace(/(\s\+\d{4})Z$/, '$1'),
  );
  return Number.isFinite(ms) ? ms : null;
}

async function projectAgeMs(project: string): Promise<number | null> {
  const stdout = await capture('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.CreatedAt}}',
  ]).catch(() => '');
  const oldest = stdout
    .split('\n')
    .map((line) => parseDockerCreatedAt(line.trim()))
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b)[0];
  return oldest === undefined ? null : Date.now() - oldest;
}

/**
 * Partition compose projects into stale/live. Only xitter-prefixed projects
 * are considered; everything else is foreign and reported live (never
 * touched). Unknown edge port or stopped status -> live (fail-safe: the
 * sweep only removes what it can PROVE is dead).
 */
export async function partitionStacks(excludeProject: string): Promise<StackLiveness> {
  const projects = await listComposeProjects();
  const stale: ComposeProjectInfo[] = [];
  const live: ComposeProjectInfo[] = [];
  for (const project of projects) {
    if (!project.name.startsWith('xitter-') || project.name === excludeProject) {
      live.push(project);
      continue;
    }
    if (!/running/i.test(project.status)) {
      live.push(project);
      continue;
    }
    // Bootstrap grace: a sibling session mid-start (containers up, apps
    // still launching) legitimately answers 502 for a few minutes - only
    // a project that has been dead-answering for longer than a full
    // bootstrap window is provably abandoned.
    const ageMs = await projectAgeMs(project.name);
    // Unknown age is CONSERVATIVE live: the grace period protects siblings
    // mid-bootstrap (containers up, apps launching, edge answers 502), and
    // skipping it on an unreadable age could sweep a live session's boot.
    if (ageMs === null || ageMs < STACK_GRACE_MS) {
      live.push(project);
      continue;
    }
    const port = await projectEdgePort(project.name);
    if (port === null) {
      live.push(project);
      continue;
    }
    const answer = await edgeResponds(port);
    (answer === 'stale' ? stale : live).push(project);
  }
  return { stale, live };
}

/** `docker compose -p <name> down --volumes --remove-orphans` for one project. */
export async function downProject(name: string, composeFile: string): Promise<void> {
  await capture('docker', [
    'compose',
    '-f',
    composeFile,
    '-p',
    name,
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
}
