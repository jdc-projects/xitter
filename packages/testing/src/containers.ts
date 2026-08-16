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
  const container: StartedTestContainer = await new GenericContainer('apache/kafka:4.3.1')
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
      test: ['CMD-SHELL', '/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9093 >/dev/null 2>&1'],
      interval: 1_000,
      timeout: 10_000,
      retries: 120,
      startPeriod: 10_000,
    })
    .withWaitStrategy(Wait.forAll([Wait.forHealthCheck(), Wait.forListeningPorts()]))
    .start();
  return {
    bootstrapServers: `${container.getHost()}:${hostPort}`,
    stop: () => container.stop(),
  };
}
