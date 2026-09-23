import { randomInt } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';
import { CorreoService } from '../../comun/correo/correo.service';
import {
  conflicto,
  noEncontrado,
  noProcesable,
  Problema,
} from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import {
  ErrorSupabase,
  SupabaseService,
} from '../../comun/supabase/supabase.service';
import { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { Pagina } from '../../comun/validacion';
import type { Prisma } from '../../generated/prisma/client';
import type {
  CrearAsesorDto,
  ListarUsuariosDto,
  SuspenderDto,
} from './admin.dto';

const MINUSCULAS = 'abcdefghijkmnpqrstuvwxyz';
const MAYUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITOS = '23456789';
const SIMBOLOS = '!@#$%*?-_';

/** Contraseña temporal de 14 caracteres con al menos uno de cada clase. */
export function generarPasswordTemporal(): string {
  const todos = MINUSCULAS + MAYUSCULAS + DIGITOS + SIMBOLOS;
  const elegir = (conjunto: string) => conjunto[randomInt(conjunto.length)];
  const caracteres = [
    elegir(MINUSCULAS),
    elegir(MAYUSCULAS),
    elegir(DIGITOS),
    elegir(SIMBOLOS),
  ];
  while (caracteres.length < 14) caracteres.push(elegir(todos));
  for (let i = caracteres.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [caracteres[i], caracteres[j]] = [caracteres[j], caracteres[i]];
  }
  return caracteres.join('');
}

@Injectable()
export class UsuariosAdminService {
  private readonly logger = new Logger(UsuariosAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly correo: CorreoService,
    private readonly trazabilidad: TrazabilidadService,
  ) {}

  /**
   * Alta de un asesor (§11): la cuenta se crea con la API de administración y
   * el rol llega por app_metadata (el disparador §16 lo aplica). La contraseña
   * temporal se envía por correo; sin SMTP configurado se devuelve una sola vez
   * al administrador.
   */
  async crearAsesor(
    admin: UsuarioAutenticado,
    dto: CrearAsesorDto,
    peticion?: Request,
  ) {
    const password = generarPasswordTemporal();
    let id: string;
    try {
      id = await this.supabase.crearUsuario({
        email: dto.email,
        password,
        appMetadata: { rol: 'ASESOR_BANCO', password_temporal: true },
        userMetadata: {
          nombres: dto.nombres,
          apellidos: dto.apellidos ?? null,
          telefono: dto.telefono,
        },
      });
    } catch (err) {
      if (
        err instanceof ErrorSupabase &&
        (err.codigo === 'email_exists' || err.status === 422)
      ) {
        throw conflicto(
          'email-registrado',
          'Ya existe una cuenta con ese correo',
        );
      }
      this.logger.error({ err }, 'Supabase no creó la cuenta del asesor');
      throw new Problema(
        502,
        'proveedor-auth-no-disponible',
        'No se pudo crear la cuenta en Supabase Auth',
      );
    }

    await this.prisma.transaccion(async (tx) => {
      await tx.usuario.updateMany({
        where: { id },
        data: { created_by: admin.id },
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId: admin.id,
        accion: 'CREAR',
        entidad: 'usuario',
        entidadId: id,
        nuevos: { email: dto.email, rol: 'ASESOR_BANCO' },
        peticion,
      });
    });

    const enviado = await this.correo.enviar(
      dto.email,
      'Tu cuenta de FindFood',
      [
        `Hola ${dto.nombres},`,
        '',
        'Se creó tu cuenta de asesor del banco de alimentos en FindFood.',
        `Usuario: ${dto.email}`,
        `Contraseña temporal: ${password}`,
        '',
        'Deberás cambiarla en tu primer ingreso al panel.',
      ].join('\n'),
    );
    if (!enviado) {
      this.logger.warn(
        { usuarioId: id },
        'Contraseña temporal sin correo: se entrega al administrador',
      );
    }
    return {
      id,
      email: dto.email,
      nombres: dto.nombres,
      correo_enviado: enviado,
      ...(enviado ? {} : { password_temporal: password }),
    };
  }

  async listar(filtro: ListarUsuariosDto): Promise<Pagina<unknown>> {
    const donde: Prisma.usuarioWhereInput = {
      deleted_at: null,
      ...(filtro.estado ? { estado: filtro.estado } : {}),
      ...(filtro.rol
        ? {
            usuario_rol_usuario_rol_usuario_idTousuario: {
              some: { activo: true, rol: { codigo: filtro.rol } },
            },
          }
        : {}),
      ...(filtro.q
        ? {
            OR: [
              { email: { contains: filtro.q, mode: 'insensitive' } },
              { nombres: { contains: filtro.q, mode: 'insensitive' } },
              { apellidos: { contains: filtro.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [datos, total] = await Promise.all([
      this.prisma.usuario.findMany({
        where: donde,
        orderBy: { created_at: 'desc' },
        take: filtro.limite,
        skip: filtro.desplazamiento,
        select: {
          id: true,
          email: true,
          nombres: true,
          apellidos: true,
          telefono: true,
          estado: true,
          ultimo_acceso_at: true,
          created_at: true,
          usuario_rol_usuario_rol_usuario_idTousuario: {
            select: { activo: true, rol: { select: { codigo: true } } },
          },
        },
      }),
      this.prisma.usuario.count({ where: donde }),
    ]);
    return {
      datos: datos.map(
        ({ usuario_rol_usuario_rol_usuario_idTousuario: roles, ...u }) => ({
          ...u,
          roles: roles.filter((r) => r.activo).map((r) => r.rol.codigo),
          roles_inactivos: roles
            .filter((r) => !r.activo)
            .map((r) => r.rol.codigo),
        }),
      ),
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }

  /**
   * Suspensión: estado + suspension_cuenta + cierre de sesiones (§13.2). El
   * AuthGuard la hace efectiva desde la siguiente petición.
   */
  async suspender(
    admin: UsuarioAutenticado,
    id: string,
    dto: SuspenderDto,
    peticion?: Request,
  ) {
    if (id === admin.id)
      throw noProcesable(
        'auto-suspension',
        'No puedes suspender tu propia cuenta',
      );
    const fin = dto.fin_at ? new Date(dto.fin_at) : null;
    if (fin && fin <= new Date()) {
      throw noProcesable(
        'fecha-invalida',
        'La suspensión debe terminar en el futuro',
      );
    }
    await this.prisma.transaccion(async (tx) => {
      const usuario = await tx.usuario.findUnique({
        where: { id },
        select: { estado: true, deleted_at: true },
      });
      if (!usuario || usuario.deleted_at) throw noEncontrado('Usuario');
      if (usuario.estado === 'SUSPENDIDO') {
        throw conflicto('ya-suspendido', 'La cuenta ya está suspendida');
      }
      if (dto.motivo_id) {
        const motivo = await tx.motivo.count({
          where: { id: dto.motivo_id, activo: true },
        });
        if (!motivo)
          throw noProcesable('motivo-invalido', 'El motivo no existe');
      }
      await tx.suspension_cuenta.create({
        data: {
          usuario_id: id,
          motivo_id: dto.motivo_id ?? null,
          descripcion: dto.descripcion,
          suspendido_por: admin.id,
          fin_at: fin,
        },
      });
      await tx.usuario.update({
        where: { id },
        data: { estado: 'SUSPENDIDO', updated_by: admin.id },
      });
      // Un voluntario suspendido deja de recibir ofertas.
      await tx.voluntario.updateMany({
        where: { usuario_id: id },
        data: { disponible: false },
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId: admin.id,
        accion: 'SUSPENDER',
        entidad: 'usuario',
        entidadId: id,
        anteriores: { estado: usuario.estado },
        nuevos: {
          estado: 'SUSPENDIDO',
          fin_at: fin,
          descripcion: dto.descripcion,
        },
        peticion,
      });
    });
    try {
      await this.supabase.bloquearSesiones(id, fin ?? undefined);
    } catch (err) {
      this.logger.error(
        { err, usuarioId: id },
        'No se cerraron las sesiones; el AuthGuard ya bloquea el acceso',
      );
    }
    return { id, estado: 'SUSPENDIDO', fin_at: fin };
  }

  async reactivar(admin: UsuarioAutenticado, id: string, peticion?: Request) {
    const estado = await this.prisma.transaccion(async (tx) => {
      const usuario = await tx.usuario.findUnique({
        where: { id },
        select: { estado: true, telefono: true, email_verificado_at: true },
      });
      if (!usuario) throw noEncontrado('Usuario');
      if (usuario.estado !== 'SUSPENDIDO') {
        throw conflicto('no-suspendido', 'La cuenta no está suspendida');
      }
      const nuevo = this.estadoTrasSuspension(usuario);
      await tx.suspension_cuenta.updateMany({
        where: { usuario_id: id, levantada_at: null },
        data: { levantada_at: new Date(), levantada_por: admin.id },
      });
      await tx.usuario.update({
        where: { id },
        data: { estado: nuevo, updated_by: admin.id },
      });
      await this.trazabilidad.auditar(tx, {
        usuarioId: admin.id,
        accion: 'REACTIVAR',
        entidad: 'usuario',
        entidadId: id,
        anteriores: { estado: 'SUSPENDIDO' },
        nuevos: { estado: nuevo },
        peticion,
      });
      return nuevo;
    });
    try {
      await this.supabase.desbloquearSesiones(id);
    } catch (err) {
      this.logger.error(
        { err, usuarioId: id },
        'No se levantó el bloqueo en Supabase Auth',
      );
    }
    return { id, estado };
  }

  private estadoTrasSuspension(u: {
    telefono: string | null;
    email_verificado_at: Date | null;
  }) {
    return u.telefono && u.email_verificado_at
      ? ('ACTIVO' as const)
      : ('PENDIENTE_CONFIRMACION' as const);
  }

  /** Tarea periódica: levanta las suspensiones temporales cumplidas. */
  async levantarSuspensionesVencidas(): Promise<number> {
    return this.prisma.transaccion(async (tx) => {
      const vencidas = await tx.$queryRaw<{ usuario_id: string }[]>`
        UPDATE suspension_cuenta SET levantada_at = now()
         WHERE levantada_at IS NULL AND fin_at IS NOT NULL AND fin_at <= now()
        RETURNING usuario_id`;
      let reactivados = 0;
      for (const { usuario_id } of vencidas) {
        const pendiente = await tx.suspension_cuenta.count({
          where: { usuario_id, levantada_at: null },
        });
        if (pendiente) continue;
        const u = await tx.usuario.findUnique({
          where: { id: usuario_id },
          select: { estado: true, telefono: true, email_verificado_at: true },
        });
        if (u?.estado !== 'SUSPENDIDO') continue;
        await tx.usuario.update({
          where: { id: usuario_id },
          data: { estado: this.estadoTrasSuspension(u) },
        });
        reactivados++;
      }
      return reactivados;
    });
  }

  /**
   * Tarea cuentas_sin_confirmar (§7): borra con la API de administración las
   * cuentas que nunca confirmaron el correo. fn_preparar_baja_sin_confirmar
   * libera antes la fila de donante (FK RESTRICT).
   */
  async eliminarCuentasSinConfirmar(dias: number): Promise<number> {
    const cuentas = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM fn_cuentas_sin_confirmar(${dias}::int) LIMIT 100`;
    let eliminadas = 0;
    for (const { id } of cuentas) {
      const [{ ok }] = await this.prisma.$queryRaw<{ ok: boolean }[]>`
        SELECT fn_preparar_baja_sin_confirmar(${id}::uuid) AS ok`;
      if (!ok) continue;
      try {
        await this.supabase.eliminarUsuario(id);
        eliminadas++;
      } catch (err) {
        this.logger.warn(
          { err, usuarioId: id },
          'No se pudo eliminar la cuenta sin confirmar',
        );
      }
    }
    return eliminadas;
  }
}
