import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CambiarEstadoUsuarioDto } from './admin.dto';
import { UsuariosAdminService } from './usuarios-admin.service';
import type { PrismaService } from '../../comun/prisma/prisma.service';
import type { SupabaseService } from '../../comun/supabase/supabase.service';
import type { CorreoService } from '../../comun/correo/correo.service';
import type { TrazabilidadService } from '../../comun/trazabilidad/trazabilidad.service';
import type { UsuarioAutenticado } from '../../comun/auth/tipos';

const admin = { id: 'admin', roles: ['ADMIN'] } as UsuarioAutenticado;
function setup(estado = 'ACTIVO') {
  const account = {
    estado,
    deleted_at: null as Date | null,
    telefono: '+573104445566' as string | null,
    email_verificado_at: new Date() as Date | null,
  };
  const tx = {
    usuario: {
      findUnique: jest.fn().mockResolvedValue(account),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    voluntario: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const audit = jest.fn().mockResolvedValue(undefined);
  const prisma = {
    transaccion: jest.fn((callback: (value: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const service = new UsuariosAdminService(
    prisma as unknown as PrismaService,
    {} as SupabaseService,
    {} as CorreoService,
    { auditar: audit } as unknown as TrazabilidadService,
  );
  return { service, account, tx, audit, prisma };
}

describe('cambio administrativo ACTIVO/INACTIVO', () => {
  it('inactiva, elimina disponibilidad y audita en la misma transacción', async () => {
    const { service, tx, audit } = setup();
    await expect(
      service.cambiarEstado(admin, 'other', { estado: 'INACTIVO' }),
    ).resolves.toEqual({ id: 'other', estado: 'INACTIVO' });
    expect(tx.usuario.updateMany).toHaveBeenCalledWith({
      where: { id: 'other', estado: 'ACTIVO', deleted_at: null },
      data: { estado: 'INACTIVO', updated_by: 'admin' },
    });
    expect(tx.voluntario.updateMany).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        anteriores: { estado: 'ACTIVO' },
        nuevos: { estado: 'INACTIVO' },
      }),
    );
  });
  it('activa sin cambiar la disponibilidad del voluntario', async () => {
    const { service, tx } = setup('INACTIVO');
    await expect(
      service.cambiarEstado(admin, 'other', { estado: 'ACTIVO' }),
    ).resolves.toEqual({ id: 'other', estado: 'ACTIVO' });
    expect(tx.voluntario.updateMany).not.toHaveBeenCalled();
  });
  it('no permite inactivar la cuenta propia', async () => {
    const { service, prisma } = setup();
    await expect(
      service.cambiarEstado(admin, 'admin', { estado: 'INACTIVO' }),
    ).rejects.toMatchObject({ tipo: 'auto-inactivacion' });
    expect(prisma.transaccion).not.toHaveBeenCalled();
  });
  it.each(['SUSPENDIDO', 'PENDIENTE_CONFIRMACION'])(
    'no cambia una cuenta %s',
    async (estado) => {
      const { service, tx } = setup(estado);
      await expect(
        service.cambiarEstado(admin, 'other', { estado: 'ACTIVO' }),
      ).rejects.toMatchObject({ tipo: 'estado-no-editable' });
      expect(tx.usuario.updateMany).not.toHaveBeenCalled();
    },
  );
  it('no activa una cuenta sin confirmar el correo', async () => {
    const { service, account } = setup('INACTIVO');
    account.email_verificado_at = null;
    await expect(
      service.cambiarEstado(admin, 'other', { estado: 'ACTIVO' }),
    ).rejects.toMatchObject({ tipo: 'cuenta-sin-confirmar' });
  });
  it('detecta modificaciones concurrentes y no audita un cambio perdido', async () => {
    const { service, tx, audit } = setup();
    tx.usuario.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.cambiarEstado(admin, 'other', { estado: 'INACTIVO' }),
    ).rejects.toMatchObject({ tipo: 'estado-modificado' });
    expect(audit).not.toHaveBeenCalled();
  });
  it('no modifica usuarios eliminados', async () => {
    const { service, account } = setup();
    account.deleted_at = new Date();
    await expect(
      service.cambiarEstado(admin, 'other', { estado: 'INACTIVO' }),
    ).rejects.toMatchObject({ tipo: 'no-encontrado' });
  });
  it('acepta repetir el estado sin crear otro registro de auditoría', async () => {
    const { service, tx, audit } = setup();
    await service.cambiarEstado(admin, 'other', { estado: 'ACTIVO' });
    expect(tx.usuario.updateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it('valida únicamente los dos estados del contrato', async () => {
    expect(
      await validate(
        plainToInstance(CambiarEstadoUsuarioDto, { estado: 'ACTIVO' }),
      ),
    ).toHaveLength(0);
    expect(
      await validate(
        plainToInstance(CambiarEstadoUsuarioDto, { estado: 'SUSPENDIDO' }),
      ),
    ).not.toHaveLength(0);
  });
});
