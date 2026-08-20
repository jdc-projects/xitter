import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
export interface Disposable {
  stop(): Promise<unknown>;
}

export interface PostgresHandle extends Disposable {
  /** Connection string for the service-owned database (created for you). */
  connectionString: string;
}

// Ryuk (the reaper) cannot start on Podman-backed docker sockets - it dies
// instantly and every container start fails with "Log stream ended". Tests
// stop their containers explicitly in afterAll; leaked containers on a hard
// crash are the accepted trade-off (CI runners are ephemeral anyway).
process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';

/**
 * Start a throwaway Postgres with one database + user, mirroring the local
 * "shared instance, database per service" topology.
 */
export async function startPostgres(
  dbName: string,
  dbUser = 'test',
  dbPassword = 'test',
): Promise<PostgresHandle> {
  // Ephemeral host port, so no fixed-port lock - but label the container so
  // crashed-run orphans can be identified and swept (the label-scoped sweep
  // below only removes containers older than the vitest suite timeout:
  // a live suite's container is always younger).
  await sweepLabelledOrphans(POSTGRES_TEST_LABEL, 10 * 60_000).catch(() => undefined);
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:18.6-alpine',
  )
    .withDatabase(dbName)
    .withUsername(dbUser)
    .withPassword(dbPassword)
    .withLabels({ [POSTGRES_TEST_LABEL]: 'true' })
    .start();
  return {
    connectionString: container.getConnectionUri(),
    stop: () => container.stop(),
  };
}

/** Postgres test containers carry this label (orphan sweep, below). */
const POSTGRES_TEST_LABEL = 'xitter.test.postgres';

export interface KafkaHandle extends Disposable {
  bootstrapServers: string;
  /** Releases the fixed-port lock; also stops the container. */
  stop(): Promise<unknown>;
}

export interface RustFsHandle extends Disposable {
  /** S3 endpoint URL reachable from the host (testcontainers port). */
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

export interface OpenSearchHandle extends Disposable {
  /** Cluster URL reachable from the host (HTTP, security disabled like compose). */
  url: string;
}

// Ephemeral host port (no fixed-port lock needed), labelled so crashed-run
// orphans can be swept by hand - same pattern as the RustFS container.
const OPENSEARCH_TEST_LABEL = 'xitter.test.opensearch';

/**
 * Start a throwaway OpenSearch node, same image + env as the local compose
 * stack (infra/docker/compose.yaml): single node, security plugin disabled.
 * Ephemeral host port; readiness is the plain HTTP retry loop below - the
 * testcontainers port-bind wait is deliberately absent: under a loaded
 * podman VM (sibling stacks + parallel CI suites) that check races podman's
 * port proxy and fails while the JVM is healthy. Heap halved vs compose -
 * CI runners hold several of these at once and a test corpus needs a
 * fraction of 512m.
 */
export async function startOpenSearch(): Promise<OpenSearchHandle> {
  const container = await new GenericContainer('opensearchproject/opensearch:3.8.0')
    .withLabels({ [OPENSEARCH_TEST_LABEL]: 'true' })
    .withEnvironment({
      'discovery.type': 'single-node',
      DISABLE_SECURITY_PLUGIN: 'true',
      OPENSEARCH_JAVA_OPTS: '-Xms256m -Xmx256m',
      'bootstrap.memory_lock': 'false',
    })
    .withExposedPorts(9200)
    // The default host-port wait (60s) fires while the JVM is still booting
    // on CI's shared runners - the container is healthy, just slow. The
    // HTTP loop below is the real readiness gate; give the bind 5 minutes.
    .withStartupTimeout(300_000)
    .start();
  const url = `http://${container.getHost()}:${container.getMappedPort(9200)}`;

  // The HTTP layer boots a few seconds after the port listens.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      await container.stop().catch(() => undefined);
      throw new Error('OpenSearch testcontainer did not become healthy in 120s');
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }

  return { url, stop: () => container.stop() };
}

// Ephemeral host port, so no fixed-port lock is needed - but label the
// container so crashed-run orphans can be identified and swept by hand.
const RUSTFS_TEST_LABEL = 'xitter.test.rustfs';

/**
 * Start a throwaway RustFS (S3-compatible) server, same image as the local
 * compose stack (infra/docker/compose.yaml). Ephemeral host port; callers
 * create buckets themselves with their own S3 client (podman-backed sockets
 * make log-based waits unreliable, so readiness is the caller's retry loop).
 */
export async function startRustfs(
  accessKey = 'test',
  secretKey = 'test-secret',
): Promise<RustFsHandle> {
  const container = await new GenericContainer('rustfs/rustfs:1.0.0-rc.2')
    .withLabels({ [RUSTFS_TEST_LABEL]: 'true' })
    .withEnvironment({
      RUSTFS_ACCESS_KEY: accessKey,
      RUSTFS_SECRET_KEY: secretKey,
      RUSTFS_VOLUMES: '/data',
      RUSTFS_ADDRESS: '0.0.0.0:9000',
      RUSTFS_CONSOLE_ENABLE: 'false',
    })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  const port = container.getMappedPort(9000);
  const host = container.getHost();
  return {
    endpoint: `http://${host}:${port}`,
    accessKey,
    secretKey,
    stop: () => container.stop(),
  };
}

/**
 * Serialise fixed-port usage across concurrent vitest runs (CI runs service
 * suites in parallel and docker fails the whole start on a port clash).
 * A lock directory per port: exists = busy, removed on release.
 */
/**
 * Orphaned containers from interrupted/killed runs keep their host-port
 * publishing alive in the podman socket; every later publish to the same
 * port then fails with "proxy already running" (a podman API quirk - no
 * actual proxy process is involved). Only containers WE created (labelled
 * below) and that publish our port are ever swept - a live suite's
 * container cannot match: the port lock serialises suites machine-wide, so
 * while we hold it, any labelled container on this port is a leftover from
 * a crashed run. Unrelated containers are never touched.
 */
const KAFKA_TEST_LABEL = 'xitter.test.kafka';

async function sweepOrphansOnPort(port: number): Promise<void> {
  const socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') ?? '/var/run/docker.sock';
  const fetch = (await import('node:http')).request;
  const list = await new Promise<unknown[]>((resolve, reject) => {
    const req = fetch(
      {
        socketPath,
        path: `/containers/json?all=1&filters=${encodeURIComponent(
          JSON.stringify({ label: [KAFKA_TEST_LABEL] }),
        )}`,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as unknown;
            if (res.statusCode !== 200 || !Array.isArray(parsed)) {
              reject(new Error(`socket list failed (${res.statusCode}): ${body.slice(0, 80)}`));
              return;
            }
            resolve(parsed);
          } catch {
            reject(new Error(`socket list returned non-JSON (${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  const orphans = (list as { Id: string; Ports: { PublicPort?: number }[] }[]).filter((c) =>
    c.Ports?.some((p) => p.PublicPort === port),
  );
  await Promise.all(
    orphans.map(
      (c) =>
        new Promise<void>((resolve) => {
          const req = fetch(
            { socketPath, path: `/containers/${c.Id}?force=true`, method: 'DELETE' },
            () => resolve(),
          );
          req.on('error', () => resolve());
          req.end();
        }),
    ),
  );
}

/**
 * Remove labelled containers older than `minAgeMs`. Ephemeral-port fixtures
 * (Postgres) leak when a vitest run is killed: nothing else can identify
 * them, so the label does. Age-gated because concurrency: another suite's
 * in-flight container matches the label but is necessarily younger than a
 * suite timeout; only long-lived leftovers are ever removed. Never touches
 * unlabelled containers.
 */
async function sweepLabelledOrphans(label: string, minAgeMs: number): Promise<void> {
  const socketPath = process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') ?? '/var/run/docker.sock';
  const http = await import('node:http');
  const list = await new Promise<{ Id: string; Created: number }[]>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: `/containers/json?all=1&filters=${encodeURIComponent(
          JSON.stringify({ label: [label] }),
        )}`,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as unknown;
            if (res.statusCode !== 200 || !Array.isArray(parsed)) {
              reject(new Error(`orphan sweep list failed (${res.statusCode})`));
              return;
            }
            resolve(parsed as { Id: string; Created: number }[]);
          } catch {
            reject(new Error('orphan sweep list returned non-JSON'));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
  const cutoff = (Date.now() - minAgeMs) / 1000;
  const stale = list.filter((c) => c.Created < cutoff);
  if (stale.length > 0) {
    process.stderr.write(
      `[test-containers] sweeping ${stale.length} orphaned ${label} container(s)\n`,
    );
  }
  await Promise.all(
    stale.map(
      (c) =>
        new Promise<void>((resolve) => {
          const req = http.request(
            { socketPath, path: `/containers/${c.Id}?force=true`, method: 'DELETE' },
            () => resolve(),
          );
          req.on('error', () => resolve());
          req.end();
        }),
    ),
  );
}

/**
 * Serialise fixed-port usage across concurrent vitest runs (CI runs service
 * suites in parallel and docker fails the whole start on a port clash).
 * A lock directory per port: exists = busy. The lock spans the container's
 * ENTIRE lifetime (acquired in startKafka, released by handle.stop()) - if
 * it only covered the start, another suite could acquire it and sweep what
 * it wrongly considers an orphan while the container is still in use.
 *
 * Stale locks: no PID probing (permission systems flag kill-based liveness
 * checks, and /proc is not portable) - a waiter steals any lock older than
 * staleAfterMs. Healthy holders refresh the lock's mtime every 15s, so the
 * bound only trips for hard-killed runs.
 */
const LOCK_STALE_MS = 60_000;

async function acquireFixedPortLock(port: number): Promise<() => Promise<void>> {
  const lockDir = join(tmpdir(), `xitter-test-port-${port}.lock`);
  // Three Kafka suites (social, posts, fanout) serialise on this lock under
  // parallel turbo; the last waiter can legitimately queue for several
  // minutes on loaded runners. Deadlock stays bounded by the mtime steal.
  const maxWaitMs = 600_000;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for test port lock ${lockDir}. If no test run is active, remove the directory and retry.`,
        );
      }
      try {
        const stats = await stat(lockDir);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          process.stderr.write(`[test-port-lock] removed stale lock ${lockDir}\n`);
          continue;
        }
      } catch {
        /* lock vanished between checks - the mkdir retry wins the race */
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  // Heartbeat so waiters can distinguish a live holder from a killed one.
  const heartbeat = setInterval(() => {
    utimes(lockDir, new Date(), new Date()).catch(() => undefined);
  }, 15_000);
  heartbeat.unref();
  return () => {
    clearInterval(heartbeat);
    return rm(lockDir, { recursive: true, force: true });
  };
}

/**
 * Start a throwaway KRaft Kafka broker (no ZooKeeper), same image as the
 * local compose stack (infra/docker/compose.yaml).
 *
 * The broker must advertise an address the host can reach, but testcontainers
 * assigns the host port only after start - so this binds a fixed host port
 * (`XITTER_TEST_KAFKA_PORT`, default 9093 - the dev stack publishes 9092) and
 * advertises it directly. @testcontainers/kafka cannot be used with the
 * apache/kafka image: its starter script ends by invoking the Confluent-only
 * `/etc/confluent/docker/run`, which does not exist in apache/kafka, so the
 * broker never actually starts.
 */
export async function startKafka(): Promise<KafkaHandle> {
  const hostPort = Number(process.env.XITTER_TEST_KAFKA_PORT ?? 9093);
  const releaseLock = await acquireFixedPortLock(hostPort);
  // Inside the lock the port is provably unowned by any live suite: sweep
  // leftovers from crashed/killed runs, then start. Podman-backed sockets
  // also intermittently 500 the port-publish request ("proxy already
  // running" - no actual proxy involved); retrying with a fresh container
  // and another sweep is reliable.
  const maxAttempts = 3;
  let container: StartedTestContainer;
  for (let attempt = 1; ; attempt++) {
    try {
      await sweepOrphansOnPort(hostPort);
      container = await startKafkaContainer(hostPort);
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transient =
        message.includes('proxy already running') || message.includes('port is already allocated');
      if (!transient || attempt >= maxAttempts) {
        await releaseLock();
        if (transient) {
          // Label-filtered sweep found nothing to clean, so the port is held
          // by something we do not own (another project, a manual container).
          throw new Error(
            `Host port ${hostPort} is in use by a non-test container. Free it or set XITTER_TEST_KAFKA_PORT. (Original error: ${message.slice(0, 120)})`,
          );
        }
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
    }
  }
  return {
    bootstrapServers: `${container.getHost()}:${hostPort}`,
    stop: async () => {
      try {
        await container.stop();
      } finally {
        await releaseLock();
      }
    },
  };
}

async function startKafkaContainer(hostPort: number): Promise<StartedTestContainer> {
  return (
    new GenericContainer('apache/kafka:4.3.1')
      // Owns this container for orphan-sweep purposes (see sweepOrphansOnPort).
      .withLabels({ [KAFKA_TEST_LABEL]: 'true' })
      .withEnvironment({
        CLUSTER_ID: '5L6g3nShT-eMCtK--X86sw',
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:29093',
        KAFKA_LISTENERS: 'PLAINTEXT://:29092,CONTROLLER://:29093,EXTERNAL://:9093',
        KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:29092,EXTERNAL://localhost:9093',
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
          'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT',
        KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      })
      .withExposedPorts({ container: 9093, host: hostPort })
      // Health probe mirrors the compose stack; log-based waits are unusable on
      // Podman-backed sockets (the log stream never reaches testcontainers).
      .withHealthCheck({
        test: [
          'CMD-SHELL',
          '/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9093 >/dev/null 2>&1',
        ],
        interval: 1_000,
        timeout: 10_000,
        retries: 120,
        startPeriod: 10_000,
      })
      .withWaitStrategy(Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]))
      .start()
  );
}
