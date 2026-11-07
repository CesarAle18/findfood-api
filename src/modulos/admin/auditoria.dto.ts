import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ROLES, type CodigoRol } from '../../comun/auth/tipos';
import { PaginacionDto } from '../../comun/validacion';

export class ListarAuditoriaDto extends PaginacionDto {
  @ApiPropertyOptional({
    description: 'Fecha ISO 8601 inclusiva',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  desde?: string;

  @ApiPropertyOptional({
    description: 'Fecha ISO 8601 exclusiva',
    format: 'date-time',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  hasta?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  usuario_id?: string;

  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  rol?: CodigoRol;

  @ApiPropertyOptional({
    description: 'Entidad auditada, por ejemplo usuario o almacen',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  entidad?: string;

  @ApiPropertyOptional({ example: 'ACTUALIZAR' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  accion?: string;
}
