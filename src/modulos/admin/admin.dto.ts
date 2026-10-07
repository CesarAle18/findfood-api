import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ROLES } from '../../comun/auth/tipos';
import { CoordenadaDto } from '../../comun/geo';
import { EsTelefono, PaginacionDto } from '../../comun/validacion';
import {
  ambito_motivo,
  estado_usuario,
  estado_verificacion,
  tipo_almacenamiento,
} from '../../generated/prisma/enums';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Roles internos que el ADMIN puede crear; donantes y voluntarios se registran en la app. */
export const ROLES_INTERNOS = ['ADMIN', 'ASESOR_BANCO'] as const;
export type RolInterno = (typeof ROLES_INTERNOS)[number];

export class CrearUsuarioInternoDto {
  @ApiProperty({ enum: ROLES_INTERNOS })
  @IsIn(ROLES_INTERNOS)
  rol: RolInterno;

  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @ApiProperty()
  @Transform(recortar)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  nombres: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(100)
  apellidos?: string;
  @ApiProperty({ example: '+573001234567' }) @EsTelefono() telefono: string;
}

export class ListarUsuariosDto extends PaginacionDto {
  @ApiPropertyOptional({ description: 'Busca en correo, nombres y apellidos' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: estado_usuario })
  @IsOptional()
  @IsIn(Object.values(estado_usuario))
  estado?: estado_usuario;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  rol?: (typeof ROLES)[number];
}

/** La suspensión es indefinida hasta que un ADMIN reactiva la cuenta. */
export class SuspenderDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) descripcion: string;
}

export class ListarVerificacionesDto extends PaginacionDto {
  @ApiPropertyOptional({ enum: estado_verificacion, default: 'PENDIENTE' })
  @IsOptional()
  @IsIn(Object.values(estado_verificacion))
  estado: estado_verificacion = 'PENDIENTE';
}

export class RechazarVerificacionDto {
  @ApiProperty({ description: 'Motivo del catálogo RECHAZO_VERIFICACION' })
  @IsInt()
  @Min(1)
  motivo_id: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacion?: string;
}

export class ActualizarParametroDto {
  @ApiProperty({
    description:
      'Valor como texto; se valida contra el tipo_dato del parámetro',
  })
  @IsString()
  @MaxLength(2000)
  valor: string;
}

export class BancoDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(150) nombre: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(255) direccion: string;
  @ApiProperty() @IsString() @MaxLength(80) ciudad: string;

  @ApiProperty({ type: CoordenadaDto })
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion: CoordenadaDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tiene_flota_propia?: boolean;
}

export class TipoAlimentoDto {
  @ApiProperty() @IsInt() @Min(1) categoria_alimento_id: number;
  @ApiProperty() @IsInt() @Min(1) unidad_medida_id: number;

  @ApiProperty({ example: 'FRIJOL' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z0-9_]{2,40}$/)
  codigo: string;

  @ApiProperty()
  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre: string;
  @ApiProperty() @IsBoolean() requiere_refrigeracion: boolean;

  @ApiProperty({ enum: tipo_almacenamiento })
  @IsIn(Object.values(tipo_almacenamiento))
  tipo_almacenamiento: tipo_almacenamiento;

  @ApiProperty() @IsBoolean() perecedero: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) vida_util_dias?: number;
}

export class ActualizarTipoAlimentoDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nombre?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiere_refrigeracion?: boolean;

  @ApiPropertyOptional({ enum: tipo_almacenamiento })
  @IsOptional()
  @IsIn(Object.values(tipo_almacenamiento))
  tipo_almacenamiento?: tipo_almacenamiento;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() perecedero?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) vida_util_dias?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() activo?: boolean;
}

export const CATALOGOS = [
  'categorias_alimento',
  'tipos_alimento',
  'unidades_medida',
  'tipos_vehiculo',
  'motivos',
  'tipos_incidencia',
  'tipos_destino_distribucion',
] as const;
export type Catalogo = (typeof CATALOGOS)[number];

export class FiltroCatalogosDto {
  @ApiPropertyOptional({
    description: `Catálogos a devolver, separados por coma. Por defecto, todos. Valores: ${CATALOGOS.join(', ')}`,
    example: 'unidades_medida,tipos_alimento',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    (Array.isArray(value) ? value : [value])
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : [v]))
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== ''),
  )
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(CATALOGOS, {
    each: true,
    message: `incluir solo admite: ${CATALOGOS.join(', ')}`,
  })
  incluir?: Catalogo[];

  @ApiPropertyOptional({
    enum: ambito_motivo,
    description: 'Filtra los motivos por ámbito (p. ej. RECHAZO_ASIGNACION)',
  })
  @IsOptional()
  @IsIn(Object.values(ambito_motivo))
  ambito?: ambito_motivo;
}
