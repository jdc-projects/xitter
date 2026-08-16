import { KafkaContainer, type StartedKafkaContainer } from '@testcontainers/kafka';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

export interface Disposable {
  stop(): Promise<unknown>;
}

export interface PostgresHandle extends Disposable {
  /** Connection string for the service-owned database (created for you). */
  connectionString: string;
}

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

/** Start a throwaway KRaft Kafka broker (no ZooKeeper). */
export async function startKafka(): Promise<KafkaHandle> {
  const container: StartedKafkaContainer = await new KafkaContainer('apache/kafka:4.3.1').start();
  const host = container.getHost();
  const port = container.getMappedPort(9092);
  return {
    bootstrapServers: `${host}:${port}`,
    stop: () => container.stop(),
  };
}
