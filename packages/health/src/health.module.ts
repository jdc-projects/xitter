/**
 * Shared liveness/readiness endpoints for the Nest services.
 *
 * `/healthz` (liveness) answers 200 whenever the HTTP stack is up - it never
 * checks dependencies, so a slow database cannot get a healthy pod killed.
 * `/readyz` (readiness) pings the service database through its Prisma client
 * and answers 503 until it responds, so orchestrators stop routing traffic
 * during startup and outages.
 *
 * Both routes sit at the root (outside the `api/{service}/v1` global prefix)
 * because they serve infrastructure probes, not the public API - services
 * exclude `healthz`/`readyz` from `setGlobalPrefix` in their bootstrap.
 */
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  TerminusModule,
  type HealthCheckResult,
} from '@nestjs/terminus';

/**
 * Structural slice of a Prisma client - each service passes its own generated
 * client, so this package stays independent of per-service generated code.
 */
export interface HealthCheckedDb {
  $queryRawUnsafe(query: string): Promise<unknown>;
  $disconnect(): Promise<unknown>;
}

/** Injection token for the Prisma client used by the readiness ping. */
export const HEALTH_DB = Symbol('XITTER_HEALTH_DB');

/** Readiness ping timeout - a hung database must not hang the probe. */
const DB_PING_TIMEOUT_MS = 2_000;

export interface HealthModuleOptions {
  /** Creates the service's Prisma client (lazily, at module init). */
  prismaFactory: () => HealthCheckedDb;
}

@Injectable()
export class DatabasePingIndicator {
  constructor(private readonly indicators: HealthIndicatorService) {}

  async pingCheck(key: string, db: HealthCheckedDb) {
    const check = this.indicators.check(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`database ping exceeded ${DB_PING_TIMEOUT_MS}ms`)),
          DB_PING_TIMEOUT_MS,
        );
      });
      await Promise.race([db.$queryRawUnsafe('SELECT 1'), timeout]);
    } catch {
      return check.down();
    } finally {
      clearTimeout(timer);
    }
    return check.up();
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly checks: HealthCheckService,
    private readonly dbPing: DatabasePingIndicator,
    @Inject(HEALTH_DB) private readonly db: HealthCheckedDb,
  ) {}

  @Get('healthz')
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.checks.check([]);
  }

  @Get('readyz')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.checks.check([() => this.dbPing.pingCheck('database', this.db)]);
  }
}

@Injectable()
export class DbShutdownHook implements OnApplicationShutdown {
  constructor(@Inject(HEALTH_DB) private readonly db: HealthCheckedDb) {}

  onApplicationShutdown(): Promise<unknown> {
    return this.db.$disconnect();
  }
}

@Module({})
export class HealthModule {
  static forRoot(options: HealthModuleOptions): DynamicModule {
    const dbProvider: Provider = { provide: HEALTH_DB, useFactory: options.prismaFactory };
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot()],
      controllers: [HealthController],
      providers: [dbProvider, DatabasePingIndicator, DbShutdownHook],
    };
  }
}
