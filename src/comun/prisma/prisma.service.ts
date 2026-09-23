import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigApp } from '../../config/configuracion';
import { Prisma, PrismaClient } from '../../generated/prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * Cliente de Prisma con un pool persistente (proceso de larga vida en Railway).
 * El esquema lo define SQL: toda operación sobre columnas geography/geometry,
 * FOR UPDATE SKIP LOCKED o funciones fn_* va por $queryRaw / $executeRaw.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigApp) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL'),
        max: config.get('DB_POOL_MAX'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Transacción interactiva con plazos acordes a una petición HTTP. */
  transaccion<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(fn, { maxWait: 5_000, timeout: 15_000 });
  }
}
