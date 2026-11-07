import { Injectable } from '@nestjs/common';
import { Problema } from '../../comun/http/problema';
import { PrismaService } from '../../comun/prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { ListarAuditoriaDto } from './auditoria.dto';

const MODULOS: Record<string, string> = {
  usuario: 'Usuarios',
  voluntario: 'Usuarios',
  verificacion_identidad: 'Usuarios',
  tipo_alimento: 'Configuración',
  banco_alimentos: 'Configuración',
  parametro_sistema: 'Configuración',
  almacen: 'Almacenes',
  donacion: 'Donaciones',
  asignacion: 'Donaciones',
  ruta: 'Rutas',
  parada_ruta: 'Rutas',
  recepcion_donacion: 'Recepción',
  lote_inventario: 'Inventario',
  movimiento_inventario: 'Inventario',
  incidencia: 'Incidencias',
};

@Injectable()
export class AuditoriaService {
  constructor(private readonly prisma: PrismaService) {}

  async listar(filtro: ListarAuditoriaDto) {
    const desde = filtro.desde ? new Date(filtro.desde) : undefined;
    const hasta = filtro.hasta ? new Date(filtro.hasta) : undefined;
    if (desde && hasta && desde >= hasta) {
      throw new Problema(
        400,
        'rango-fechas-invalido',
        'desde debe ser anterior a hasta',
      );
    }
    const where: Prisma.auditoriaWhereInput = {
      created_at: { gte: desde, lt: hasta },
      usuario_id: filtro.usuario_id,
      entidad: filtro.entidad,
      accion: filtro.accion,
      ...(filtro.rol
        ? {
            usuario: {
              usuario_rol_usuario_rol_usuario_idTousuario: {
                some: { activo: true, rol: { codigo: filtro.rol } },
              },
            },
          }
        : {}),
    };
    const [registros, total] = await this.prisma.$transaction(
      [
        this.prisma.auditoria.findMany({
          where,
          take: filtro.limite,
          skip: filtro.desplazamiento,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          include: {
            usuario: {
              select: {
                nombres: true,
                apellidos: true,
                email: true,
                usuario_rol_usuario_rol_usuario_idTousuario: {
                  where: { activo: true },
                  select: { rol: { select: { codigo: true } } },
                },
              },
            },
          },
        }),
        this.prisma.auditoria.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    return {
      datos: registros.map((r) => ({
        id: r.id.toString(),
        fecha: r.created_at.toISOString(),
        actor: r.usuario
          ? [r.usuario.nombres, r.usuario.apellidos]
              .filter(Boolean)
              .join(' ') || r.usuario.email
          : 'Sistema',
        usuario_id: r.usuario_id,
        roles:
          r.usuario?.usuario_rol_usuario_rol_usuario_idTousuario
            .map((ur) => ur.rol.codigo)
            .sort() ?? [],
        modulo: MODULOS[r.entidad] ?? r.entidad,
        accion: r.accion,
        entidad: r.entidad,
        // La bitácora no almacena el método HTTP original.
        metodo: '',
        descripcion: `${r.accion.toLowerCase().replaceAll('_', ' ')} ${r.entidad}${r.entidad_id ? ` (${r.entidad_id})` : ''}.`,
        detalles: {
          ...(r.entidad_id ? { id: r.entidad_id } : {}),
          valores_anteriores: JSON.stringify(r.valores_anteriores),
          valores_nuevos: JSON.stringify(r.valores_nuevos),
        },
      })),
      total,
      limite: filtro.limite,
      desplazamiento: filtro.desplazamiento,
    };
  }
}
