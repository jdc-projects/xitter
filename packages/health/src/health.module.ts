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
import { Internal } from '@xitter/auth-nest';
import { API_VERSION } from '@xitter/api-contracts';

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
  /** Service name reported by the admin health endpoint (defaults to 'api'). */
  serviceName?: string;
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
      // Promise.race subscribes to - and so "handles" - the losing promise,
      // but that is incidental. Attach an explicit no-op catch so a refactor
      // of this race can never turn a late ping rejection (database outage)
      // into an unhandled rejection, which Node treats as fatal.
      const ping = db.$queryRawUnsafe('SELECT 1');
      ping.catch(() => {});
      await Promise.race([ping, timeout]);
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

/** Injection token for the service name the admin health endpoint reports. */
export const HEALTH_SERVICE_NAME = Symbol('XITTER_HEALTH_SERVICE_NAME');

/**
 * Health with Terminus detail for the admin dashboard (T10). Sits under the
 * service's API prefix at `internal/admin/health` - unlike the root probes it
 * IS part of the API surface, admin-role-gated like every other internal
 * admin route (the root probes stay unauthenticated for the kubelet).
 */
@Controller('internal/admin')
export class AdminHealthController {
  constructor(
    private readonly checks: HealthCheckService,
    private readonly dbPing: DatabasePingIndicator,
    @Inject(HEALTH_DB) private readonly db: HealthCheckedDb,
    @Inject(HEALTH_SERVICE_NAME) private readonly serviceName: string,
  ) {}

  @Get('health')
  @Internal({ admin: true })
  async health(): Promise<{
    service: string;
    status: 'ok' | 'error';
    uptimeSeconds: number;
    version: string;
    checks: Record<string, { status: 'up' | 'down'; message?: string }>;
  }> {
    // Deliberately NOT wrapped in @HealthCheck(): Terminus translates a down
    // indicator into a thrown 503 whose body is its own shape. The dashboard
    // aggregates five services and wants one uniform 200 + adminHealth body
    // carrying the same detail, with status inside the payload.
    const indicator = await this.dbPing.pingCheck('database', this.db);
    const checks: Record<string, { status: 'up' | 'down'; message?: string }> = {};
    for (const [key, detail] of Object.entries(indicator)) {
      checks[key] = {
        status: detail.status === 'down' ? 'down' : 'up',
        ...(detail.message ? { message: detail.message } : {}),
      };
    }
    const status = Object.values(checks).every((check) => check.status === 'up') ? 'ok' : 'error';
    return {
      service: this.serviceName,
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      version: API_VERSION,
      checks,
    };
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
      controllers: [HealthController, AdminHealthController],
      providers: [
        dbProvider,
        { provide: HEALTH_SERVICE_NAME, useValue: options.serviceName ?? 'api' },
        DatabasePingIndicator,
        DbShutdownHook,
      ],
    };
  }
}
