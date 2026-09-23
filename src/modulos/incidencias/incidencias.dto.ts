import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CoordenadaDto } from '../../comun/geo';
import { PaginacionDto } from '../../comun/validacion';
import { estado_incidencia, severidad } from '../../generated/prisma/enums';

export class ContextoIncidenciaDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() donacion_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() asignacion_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() parada_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() recepcion_id?: string;
}

export class CrearIncidenciaDto extends ContextoIncidenciaDto {
  @ApiProperty() @IsInt() @Min(1) tipo_incidencia_id: number;

  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) descripcion: string;

  @ApiPropertyOptional({
    enum: severidad,
    description: 'Por defecto, la del tipo',
  })
  @IsOptional()
  @IsIn(Object.values(severidad))
  nivel?: severidad;

  @ApiPropertyOptional({ type: CoordenadaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion?: CoordenadaDto;
}

export class ListarIncidenciasDto extends PaginacionDto {
  @ApiPropertyOptional({ enum: estado_incidencia })
  @IsOptional()
  @IsIn(Object.values(estado_incidencia))
  estado?: estado_incidencia;

  @ApiPropertyOptional() @IsOptional() @IsUUID() donacion_id?: string;
}

export class ResolverIncidenciaDto {
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(2000) resolucion: string;
}
