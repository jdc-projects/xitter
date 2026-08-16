import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
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
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:18.6-alpine',
  )
    .withDatabase(dbName)
    .withUsername(dbUser)
    .withPassword(dbPassword)
    .start();
  return {
    connectionString: container.getConnectionUri(),
    stop: () => container.stop(),
  };
}

export interface KafkaHandle extends Disposable {
  bootstrapServers: string;
}

/**
 * Start a throwaway KRaft Kafka broker (no ZooKeeper).
 *
 * @testcontainers/kafka v12 exposes its PLAINTEXT listener on 9093 (9092 is
 * the inter-broker port and is never published to the host), so the mapped
 * port must be requested for 9093.
 */
export async function startKafka(): Promise<KafkaHandle> {
  const container: StartedKafkaContainer = await new KafkaContainer('apache/kafka:4.3.1').start();
  const host = container.getHost();
  const port = container.getMappedPort(9093);
  return {
    bootstrapServers: `${host}:${port}`,
    stop: () => container.stop(),
  };
}
