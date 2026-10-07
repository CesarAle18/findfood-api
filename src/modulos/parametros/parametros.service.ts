import { Injectable } from '@nestjs/common';
import { noEncontrado, noProcesable } from '../../comun/http/problema';
import { PrismaService, type Tx } from '../../comun/prisma/prisma.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Request } from 'express';

const TTL_CACHE_MS = 30_000;
export const CLAVES_PESO = [
  'PESO_PROXIMIDAD',
  'PESO_URGENCIA',
  'PESO_CONFIABILIDAD',
  'PESO_HOLGURA',
] as const;

/** Lo que el panel web configura: pesos del puntaje (§6.4) y paradas por ruta. */
export const CLAVES_EDITABLES = [
  ...CLAVES_PESO,
  'MAX_PARADAS_POR_RUTA',
] as const;
const PARADAS_MIN = 1;
const PARADAS_MAX = 5;

interface Parametro {
  clave: string;
  valor: string;
  tipo_dato: string;
}

/** Lectura tipada de parametro_sistema (globales, banco_id NULL) con caché corta. */
@Injectable()
export class ParametrosService {
  private cache?: { expira: number; valores: Map<string, Parametro> };

  constructor(
    private readonly prisma: PrismaService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  private async todos(): Promise<Map<string, Parametro>> {
    if (this.cache && this.cache.expira > Date.now()) return this.cache.valores;
    const filas = await this.prisma.parametro_sistema.findMany({
      where: { banco_id: null },
      select: { clave: true, valor: true, tipo_dato: true },
    });
    const valores = new Map(filas.map((f) => [f.clave, f]));
    this.cache = { expira: Date.now() + TTL_CACHE_MS, valores };
    return valores;
  }

  invalidar(): void {
    this.cache = undefined;
  }

  private async crudo(clave: string): Promise<string> {
    const p = (await this.todos()).get(clave);
    if (!p) throw new Error(`Parámetro ${clave} no configurado`);
    return p.valor;
  }

  async entero(clave: string): Promise<number> {
    return Number.parseInt(await this.crudo(clave), 10);
  }

  async decimal(clave: string): Promise<number> {
    return Number(await this.crudo(clave));
  }

  async json<T>(clave: string): Promise<T> {
    return JSON.parse(await this.crudo(clave)) as T;
  }

  async pesosPuntaje(): Promise<{
    proximidad: number;
    urgencia: number;
    confiabilidad: number;
    holgura: number;
  }> {
    const [proximidad, urgencia, confiabilidad, holgura] = await Promise.all(
      CLAVES_PESO.map((c) => this.decimal(c)),
    );
    return { proximidad, urgencia, confiabilidad, holgura };
  }

  listar() {
    return this.prisma.parametro_sistema.findMany({
      where: { banco_id: null, clave: { in: [...CLAVES_EDITABLES] } },
      orderBy: { clave: 'asc' },
      select: {
        clave: true,
        valor: true,
        tipo_dato: true,
        descripcion: true,
        updated_at: true,
        updated_by: true,
      },
    });
  }

  /**
   * Solo CLAVES_EDITABLES. Valida el tipo declarado, que los PESO_* sigan
   * sumando 1 (§6.4) y el rango de MAX_PARADAS_POR_RUTA.
   */
  async actualizar(
    clave: string,
    valor: string,
    usuarioId: string,
    peticion?: Request,
  ) {
    if (!(CLAVES_EDITABLES as readonly string[]).includes(clave))
      throw noEncontrado('Parámetro');
    return this.prisma.transaccion(async (tx: Tx) => {
      const actual = await tx.parametro_sistema.findFirst({
        where: { clave, banco_id: null },
      });
      if (!actual) throw noEncontrado('Parámetro');

      const normalizado = validarTipo(actual.tipo_dato, valor, clave);

      if (clave === 'MAX_PARADAS_POR_RUTA') {
        const paradas = Number(normalizado);
        if (paradas < PARADAS_MIN || paradas > PARADAS_MAX) {
          throw noProcesable(
            'paradas-fuera-de-rango',
            `MAX_PARADAS_POR_RUTA debe estar entre ${PARADAS_MIN} y ${PARADAS_MAX}`,
          );
        }
      }

      if ((CLAVES_PESO as readonly string[]).includes(clave)) {
        const pesos = await tx.parametro_sistema.findMany({
          where: { clave: { in: [...CLAVES_PESO] }, banco_id: null },
        });
        const suma = pesos.reduce(
          (s, p) => s + Number(p.clave === clave ? normalizado : p.valor),
          0,
        );
        if (Math.abs(suma - 1) > 1e-6) {
          throw noProcesable(
            'pesos-no-suman-uno',
            'Los cuatro PESO_* deben sumar 1',
            `Con este valor la suma sería ${suma.toFixed(4)}`,
          );
        }
      }

      const actualizado = await tx.parametro_sistema.update({
        where: { id: actual.id },
        data: { valor: normalizado, updated_by: usuarioId },
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId,
        accion: 'ACTUALIZAR',
        entidad: 'parametro_sistema',
        entidadId: clave,
        anteriores: { valor: actual.valor },
        nuevos: { valor: normalizado },
        peticion,
      });
      this.invalidar();
      return actualizado;
    });
  }
}

function validarTipo(tipo: string, valor: string, clave: string): string {
  const invalido = () =>
    noProcesable(
      'parametro-tipo-invalido',
      `El valor no es un ${tipo} válido para ${clave}`,
    );
  const texto = valor.trim();
  switch (tipo) {
    case 'INT':
      if (!/^-?\d+$/.test(texto)) throw invalido();
      if (Number(texto) < 0) throw invalido();
      return texto;
    case 'DECIMAL':
      if (!/^-?\d+(\.\d+)?$/.test(texto) || Number(texto) < 0) throw invalido();
      return texto;
    case 'BOOLEAN':
      if (!['true', 'false'].includes(texto)) throw invalido();
      return texto;
    case 'JSON':
      try {
        return JSON.stringify(JSON.parse(texto));
      } catch {
        throw invalido();
      }
    default:
      return valor;
  }
}
