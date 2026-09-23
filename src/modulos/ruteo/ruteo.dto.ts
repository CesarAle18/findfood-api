import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CoordenadaDto } from '../../comun/geo';
import { PaginacionDto } from '../../comun/validacion';
import { estado_ruta } from '../../generated/prisma/enums';

export class CrearRutaDto {
  @ApiProperty({
    type: [String],
    description:
      'Donaciones a recoger (ASIGNADAS al voluntario; PUBLICADAS o EXPIRADAS para la flota del banco)',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  donacion_ids: string[];

  @ApiPropertyOptional({
    type: CoordenadaDto,
    description: 'Punto de partida; por defecto la última ubicación o la base',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  origen?: CoordenadaDto;
}

export class ListarRutasDto extends PaginacionDto {
  @ApiPropertyOptional({ enum: estado_ruta })
  @IsOptional()
  @IsIn(Object.values(estado_ruta))
  estado?: estado_ruta;
}

export class LlegadaParadaDto {
  @ApiPropertyOptional({ type: CoordenadaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion?: CoordenadaDto;
}

export class PesoItemDto {
  @ApiProperty() @IsUUID() item_id: string;
  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  peso_real_kg: number;
}

export class ConfirmarParadaDto {
  @ApiPropertyOptional({
    description: 'Obligatorio en RECOGIDA: kilos realmente recogidos',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(99_999_999)
  peso_confirmado_kg?: number;

  @ApiPropertyOptional({
    type: [PesoItemDto],
    description: 'Peso real por producto (§19.6)',
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PesoItemDto)
  items?: PesoItemDto[];

  @ApiPropertyOptional({ type: CoordenadaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion?: CoordenadaDto;

  @ApiPropertyOptional({ description: 'Precisión del GPS en metros' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  precision_m?: number;

  @ApiPropertyOptional({
    description:
      'Confirmación sin GPS confiable (queda marcada para auditoría)',
  })
  @IsOptional()
  @IsBoolean()
  confirmacion_manual?: boolean;

  @ApiProperty({ description: 'Hora del dispositivo al confirmar' })
  @IsISO8601({ strict: true })
  confirmada_en_dispositivo: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}

export class ParadaFallidaDto {
  @ApiProperty({ description: 'Tipo de incidencia (p. ej. DONANTE_AUSENTE)' })
  @IsInt()
  @Min(1)
  tipo_incidencia_id: number;

  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) descripcion: string;

  @ApiPropertyOptional({ type: CoordenadaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion?: CoordenadaDto;
}
