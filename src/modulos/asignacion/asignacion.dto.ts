import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class RespuestaConMotivoDto {
  @ApiProperty({
    description:
      'Motivo del catálogo (RECHAZO_ASIGNACION o ABANDONO_ASIGNACION)',
  })
  @IsInt()
  @Min(1)
  motivo_id: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacion?: string;
}

export class CalificacionDto {
  @ApiProperty({ minimum: 0, maximum: 5 })
  @IsInt()
  @Min(0)
  @Max(5)
  puntaje: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comentario?: string;
}
