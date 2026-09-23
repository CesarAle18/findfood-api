import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Max,
  Min,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

/** Celular colombiano: 10 dígitos con +57 opcional; espacios y guiones se ignoran. */
export function normalizarTelefono(valor: string): string | null {
  const limpio = valor.replace(/[\s\-().]/g, '');
  const coincide = /^(?:\+?57)?(\d{10})$/.exec(limpio);
  return coincide ? `+57${coincide[1]}` : null;
}

/** Valida y normaliza a +57XXXXXXXXXX (§13.2). */
export function EsTelefono(opciones?: ValidationOptions) {
  return (objeto: object, propiedad: string) => {
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? (normalizarTelefono(value) ?? value) : value,
    )(objeto, propiedad);
    registerDecorator({
      name: 'esTelefono',
      target: objeto.constructor,
      propertyName: propiedad,
      options: {
        message: `${propiedad} debe ser un celular de 10 dígitos, con +57 opcional`,
        ...opciones,
      },
      validator: {
        validate: (valor: unknown) =>
          typeof valor === 'string' && /^\+57\d{10}$/.test(valor),
      },
    });
  };
}

export class PaginacionDto {
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limite = 20;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  desplazamiento = 0;
}

export interface Pagina<T> {
  datos: T[];
  total: number;
  limite: number;
  desplazamiento: number;
}
