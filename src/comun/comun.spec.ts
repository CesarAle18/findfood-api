import { Prisma } from '../generated/prisma/client';
import { generarPasswordTemporal } from '../modulos/admin/usuarios-admin.service';
import { renderizarPlantilla } from '../modulos/notificaciones/plantilla';
import { generarCodigo } from './codigos';
import { distanciaKm } from './geo';
import { codigoPostgres, violaUnicidad } from './http/errores-pg';
import { aJson } from './http/serializacion.interceptor';
import { fechaBogota } from './tiempo';
import { normalizarTelefono } from './validacion';

describe('teléfono (§13.2)', () => {
  it.each([
    ['3001234567', '+573001234567'],
    ['+573001234567', '+573001234567'],
    ['57 300 123 4567', '+573001234567'],
    ['(300) 123-4567', '+573001234567'],
  ])('normaliza %s', (entrada, esperado) => {
    expect(normalizarTelefono(entrada)).toBe(esperado);
  });

  it.each(['12345', '+13001234567', '30012345678', 'abc'])(
    'rechaza %s',
    (entrada) => {
      expect(normalizarTelefono(entrada)).toBeNull();
    },
  );
});

describe('fecha civil en Bogotá', () => {
  it('a las 23:30 de Bogotá sigue siendo el mismo día aunque en UTC ya sea el siguiente', () => {
    expect(fechaBogota(new Date('2026-09-23T04:30:00Z'))).toBe('2026-09-22');
    expect(fechaBogota(new Date('2026-09-23T05:30:00Z'))).toBe('2026-09-23');
  });
});

describe('códigos legibles', () => {
  it('caben en varchar(20) y no usan caracteres ambiguos', () => {
    const codigo = generarCodigo('DON', new Date('2026-09-22T15:00:00-05:00'));
    expect(codigo).toMatch(/^DON-260922-[2-9A-HJKMNP-Z]{5}$/);
    expect(codigo.length).toBeLessThanOrEqual(20);
  });
});

describe('contraseña temporal', () => {
  it('tiene 14 caracteres con minúscula, mayúscula, dígito y símbolo', () => {
    for (let i = 0; i < 50; i++) {
      const p = generarPasswordTemporal();
      expect(p).toHaveLength(14);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[!@#$%*?\-_]/);
    }
  });
});

describe('plantillas de notificación', () => {
  it('sustituye variables y deja vacías las que faltan', () => {
    expect(
      renderizarPlantilla('Tienes {{minutos}} minutos para responder.', {
        minutos: 10,
      }),
    ).toBe('Tienes 10 minutos para responder.');
    expect(renderizarPlantilla('{{voluntario}} recogerá tu donación.')).toBe(
      'recogerá tu donación.',
    );
  });
});

describe('distancia geodésica', () => {
  it('un grado de latitud son ~111 km', () => {
    expect(distanciaKm({ lat: 4, lng: -74 }, { lat: 5, lng: -74 })).toBeCloseTo(
      111.2,
      0,
    );
  });
});

describe('errores de PostgreSQL', () => {
  const errorRaw = () =>
    new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `23505`. Message: `duplicate key value violates unique constraint "uq_asignacion_vigente"`',
      { code: 'P2010', clientVersion: 'x', meta: { code: '23505' } },
    );

  it('extrae el SQLSTATE y no confunde el código de Prisma (P2010) con uno de PostgreSQL', () => {
    expect(codigoPostgres(errorRaw())).toBe('23505');
  });

  it('reconoce la restricción única violada', () => {
    expect(violaUnicidad(errorRaw(), 'uq_asignacion_vigente')).toBe(true);
    expect(violaUnicidad(errorRaw(), 'uq_recepcion_donacion')).toBe(false);
  });

  it('respeta P0001 (RAISE EXCEPTION de plpgsql)', () => {
    expect(codigoPostgres({ code: 'P2010', meta: { code: 'P0001' } })).toBe(
      'P0001',
    );
  });
});

describe('serialización', () => {
  it('Decimal y BigInt salen como números', () => {
    expect(
      aJson({
        peso: new Prisma.Decimal('10.50'),
        id: BigInt(7),
        lista: [new Prisma.Decimal(1)],
      }),
    ).toEqual({
      peso: 10.5,
      id: 7,
      lista: [1],
    });
  });
});
