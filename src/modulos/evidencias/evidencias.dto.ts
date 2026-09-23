import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CoordenadaDto } from '../../comun/geo';
import { tipo_evidencia } from '../../generated/prisma/enums';
import {
  EXTENSIONES,
  type Extension,
  PROPOSITOS,
  type Proposito,
} from './archivos.service';

export class SolicitarSubidaDto {
  @ApiProperty({ enum: PROPOSITOS, default: 'EVIDENCIA' })
  @IsOptional()
  @IsIn(PROPOSITOS)
  proposito: Proposito = 'EVIDENCIA';

  @ApiProperty({ enum: EXTENSIONES, default: 'jpg' })
  @IsOptional()
  @IsIn(EXTENSIONES)
  extension: Extension = 'jpg';
}

const MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];

export class PadreEvidenciaDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() donacion_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parada_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() recepcion_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() incidencia_id?: string;
}

export class RegistrarEvidenciaDto extends PadreEvidenciaDto {
  @ApiProperty({
    description: 'UUID generado en el móvil: reenviar es idempotente (§8.4)',
  })
  @IsUUID()
  id: string;

  @ApiProperty({ enum: tipo_evidencia })
  @IsIn(Object.values(tipo_evidencia))
  tipo: tipo_evidencia;

  @ApiProperty({ description: 'Ruta devuelta por /evidencias/upload-url' })
  @IsString()
  @MaxLength(300)
  ruta: string;

  @ApiProperty({ description: 'Hora del dispositivo al capturar' })
  @IsISO8601({ strict: true })
  capturada_at: string;

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

  @ApiPropertyOptional({ description: 'SHA-256 en hexadecimal' })
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/)
  hash_archivo?: string;

  @ApiPropertyOptional({ enum: MIME })
  @IsOptional()
  @IsIn(MIME)
  mime_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(25 * 1024 * 1024)
  tamano_bytes?: number;
}
