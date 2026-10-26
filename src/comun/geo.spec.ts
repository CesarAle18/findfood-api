import { plainToInstance, Type } from 'class-transformer';
import { IsOptional, ValidateNested, validate } from 'class-validator';
import { validarConfiguracion } from '../config/configuracion';
import {
  CoordenadaDto,
  DentroDeZonaServicio,
  dentroDeZonaServicio,
  parsearZonaServicio,
  reiniciarZonaServicio,
  ZONA_SERVICIO_BOGOTA,
  zonaServicio,
} from './geo';

const CHIA = { lat: 4.86, lng: -74.05 };
const SOACHA = { lat: 4.58, lng: -74.22 };
const MEDELLIN = { lat: 6.24, lng: -75.58 };

class ConPunto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  @DentroDeZonaServicio()
  punto?: CoordenadaDto | null;
}

const errores = (punto: unknown) =>
  validate(plainToInstance(ConPunto, { punto }));

describe('zona de servicio (Bogotá y municipios vecinos)', () => {
  const anterior = process.env.ZONA_SERVICIO;

  beforeEach(() => {
    delete process.env.ZONA_SERVICIO;
    reiniciarZonaServicio();
  });

  afterAll(() => {
    if (anterior === undefined) delete process.env.ZONA_SERVICIO;
    else process.env.ZONA_SERVICIO = anterior;
    reiniciarZonaServicio();
  });

  it('sin ZONA_SERVICIO usa Bogotá y municipios vecinos', () => {
    expect(zonaServicio()).toEqual(ZONA_SERVICIO_BOGOTA);
    expect(dentroDeZonaServicio({ lat: 4.6533, lng: -74.0836 })).toBe(true);
    expect(dentroDeZonaServicio(CHIA)).toBe(true);
    expect(dentroDeZonaServicio(SOACHA)).toBe(true);
    expect(dentroDeZonaServicio(MEDELLIN)).toBe(false);
  });

  it('incluye el borde del rectángulo', () => {
    const { sur, norte, oeste, este } = ZONA_SERVICIO_BOGOTA;
    expect(dentroDeZonaServicio({ lat: sur, lng: oeste })).toBe(true);
    expect(dentroDeZonaServicio({ lat: norte, lng: este })).toBe(true);
    expect(dentroDeZonaServicio({ lat: norte + 0.001, lng: este })).toBe(false);
    expect(dentroDeZonaServicio({ lat: sur, lng: oeste - 0.001 })).toBe(false);
  });

  it('respeta una ZONA_SERVICIO configurada', () => {
    process.env.ZONA_SERVICIO = '5.9, -76, 6.5, -75.3';
    reiniciarZonaServicio();
    expect(zonaServicio()).toEqual({
      sur: 5.9,
      oeste: -76,
      norte: 6.5,
      este: -75.3,
    });
    expect(dentroDeZonaServicio(MEDELLIN)).toBe(true);
    expect(dentroDeZonaServicio(CHIA)).toBe(false);
  });

  it('lee "sur,oeste,norte,este" y rechaza lo demás', () => {
    expect(parsearZonaServicio('4.44,-74.3,5,-73.95')).toEqual(
      ZONA_SERVICIO_BOGOTA,
    );
    for (const malo of [
      '',
      '4.44,-74.3,5',
      '4.44,-74.3,5,-73.95,1',
      '4.44,-74.3,,-73.95',
      'a,b,c,d',
      '4.44,-74.3,Infinity,-73.95',
      '5,-74.3,4.44,-73.95',
      '4.44,-73.95,5,-74.3',
    ]) {
      expect(parsearZonaServicio(malo)).toBeNull();
    }
  });

  it('la configuración rechaza al arrancar una ZONA_SERVICIO inválida', () => {
    const base = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      SUPABASE_URL: 'http://supabase.prueba',
      SUPABASE_SERVICE_ROLE_KEY: 'clave-de-servicio-de-pruebas',
    };
    expect(validarConfiguracion(base).ZONA_SERVICIO).toBeUndefined();
    expect(
      validarConfiguracion({ ...base, ZONA_SERVICIO: '4.44,-74.3,5,-73.95' })
        .ZONA_SERVICIO,
    ).toBe('4.44,-74.3,5,-73.95');
    expect(() =>
      validarConfiguracion({ ...base, ZONA_SERVICIO: '5,-74.3,4.44,-73.95' }),
    ).toThrow(/ZONA_SERVICIO/);
  });

  it('el decorador rechaza puntos fuera de la zona con un mensaje claro', async () => {
    expect(await errores(CHIA)).toHaveLength(0);
    const [error] = await errores(MEDELLIN);
    expect(error.constraints).toEqual({
      dentroDeZonaServicio:
        'El punto debe estar en Bogotá o un municipio vecino.',
    });
  });

  it('el decorador deja la forma y la ausencia a los demás validadores', async () => {
    expect(await errores(undefined)).toHaveLength(0);
    expect(await errores(null)).toHaveLength(0);
    const [error] = await errores('no es un punto');
    expect(error.constraints).not.toHaveProperty('dentroDeZonaServicio');
  });
});
