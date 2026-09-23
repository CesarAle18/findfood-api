import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CoordenadaDto } from '../../comun/geo';
import { EsTelefono } from '../../comun/validacion';
import { plataforma_dispositivo } from '../../generated/prisma/enums';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ActualizarPerfilDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  nombres?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(100)
  apellidos?: string;

  @ApiPropertyOptional({
    example: '+573001234567',
    description: '10 dígitos, +57 opcional',
  })
  @IsOptional()
  @EsTelefono()
  telefono?: string;

  @ApiPropertyOptional({
    description: 'true para registrar la aceptación de términos (Ley 1581)',
  })
  @IsOptional()
  @IsIn([true])
  acepto_terminos?: true;
}

export class RegistrarDispositivoDto {
  @ApiProperty({ example: 'ExponentPushToken[xxxxxxxxxxxxxxxx]' })
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  token_push: string;

  @ApiProperty({ enum: plataforma_dispositivo })
  @IsIn(Object.values(plataforma_dispositivo))
  plataforma: plataforma_dispositivo;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  modelo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  version_app?: string;
}

export class SolicitudVoluntarioDto {
  @ApiProperty() @IsInt() @Min(1) tipo_vehiculo_id: number;

  @ApiProperty({ example: 'ABC123' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value.replace(/[\s-]/g, '').toUpperCase()
      : value,
  )
  @Matches(/^[A-Z0-9]{5,10}$/, {
    message: 'placa_vehiculo debe tener 5 a 10 letras o números',
  })
  placa_vehiculo: string;

  @ApiProperty({
    description: 'Ruta de la foto del vehículo (proposito VEHICULO)',
  })
  @IsString()
  url_foto_vehiculo: string;

  @ApiProperty() @IsNumber() @Min(1) @Max(10_000) capacidad_carga_kg: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(100)
  capacidad_volumen_m3?: number;

  @ApiProperty() @IsBoolean() tiene_refrigeracion: boolean;

  @ApiProperty({ example: '1995-04-12' })
  @IsISO8601({ strict: true })
  fecha_nacimiento: string;

  @ApiPropertyOptional({ default: false }) @IsOptional() @IsBoolean() es_grupo =
    false;

  @ApiPropertyOptional({ description: 'Obligatoria si es_grupo' })
  @ValidateIf((o: SolicitudVoluntarioDto) => o.es_grupo)
  @Transform(recortar)
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  organizacion?: string;

  @ApiProperty({
    type: CoordenadaDto,
    description: 'Punto desde el que suele salir',
  })
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion_base: CoordenadaDto;

  @ApiPropertyOptional({ default: 10 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  radio_cobertura_km = 10;

  @ApiProperty({
    description:
      'Ruta del documento, cara frontal (proposito DOCUMENTO_IDENTIDAD)',
  })
  @IsString()
  documento_frente: string;

  @ApiPropertyOptional() @IsOptional() @IsString() documento_reverso?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() selfie?: string;
}

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export class FranjaDto {
  @ApiProperty({ description: '0 = domingo … 6 = sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  dia_semana: number;

  @ApiProperty({ example: '08:00' }) @Matches(HORA) hora_inicio: string;
  @ApiProperty({ example: '12:00' }) @Matches(HORA) hora_fin: string;
}

export class DisponibilidadDto {
  @ApiProperty({
    type: [FranjaDto],
    description: 'Reemplaza todas las franjas semanales (hora de Bogotá)',
  })
  @ArrayMaxSize(42)
  @ValidateNested({ each: true })
  @Type(() => FranjaDto)
  franjas: FranjaDto[];
}

export class EstadoVoluntarioDto {
  @ApiProperty() @IsBoolean() disponible: boolean;
}

export class UbicacionVoluntarioDto extends CoordenadaDto {}
