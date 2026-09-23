import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
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
  estado_usuario,
  estado_verificacion,
  tipo_almacenamiento,
} from '../../generated/prisma/enums';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CrearAsesorDto {
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

export class SuspenderDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) descripcion: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) motivo_id?: number;

  @ApiPropertyOptional({
    description: 'Fin de la suspensión; sin fecha es indefinida',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  fin_at?: string;
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
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  documento_fiscal?: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(255) direccion: string;
  @ApiProperty() @IsString() @MaxLength(80) ciudad: string;

  @ApiProperty({ type: CoordenadaDto })
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion: CoordenadaDto;

  @ApiPropertyOptional() @IsOptional() @EsTelefono() telefono?: string;
  @ApiPropertyOptional() @IsOptional() @IsEmail() email?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  capacidad_total_kg?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  radio_operacion_km?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  tiene_flota_propia?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsObject() horario_recepcion?: Record<
    string,
    unknown
  >;
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
