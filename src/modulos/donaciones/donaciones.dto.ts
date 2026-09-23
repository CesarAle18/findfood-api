import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { EsTelefono, PaginacionDto } from '../../comun/validacion';
import { estado_donacion } from '../../generated/prisma/enums';

const recortar = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ItemDonacionDto {
  @ApiProperty() @IsInt() @Min(1) tipo_alimento_id: number;

  @ApiPropertyOptional({
    description: 'Por defecto, la unidad del tipo de alimento',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  unidad_medida_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(150)
  descripcion?: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  cantidad: number;

  @ApiProperty({ description: 'Kilogramos estimados del producto' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99_999_999)
  peso_estimado_kg: number;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  fecha_vencimiento?: string;

  @ApiPropertyOptional({
    description: 'Por defecto, lo que diga el tipo de alimento',
  })
  @IsOptional()
  @IsBoolean()
  requiere_refrigeracion?: boolean;

  @ApiPropertyOptional({ description: 'Ruta de la foto (proposito PRODUCTO)' })
  @IsOptional()
  @IsString()
  ruta_foto?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observaciones?: string;
}

export class CrearDonacionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(120)
  titulo?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  descripcion?: string;

  @ApiProperty({ example: '2026-09-23T14:00:00-05:00' })
  @IsISO8601({ strict: true })
  ventana_recogida_inicio: string;

  @ApiProperty({ example: '2026-09-23T18:00:00-05:00' })
  @IsISO8601({ strict: true })
  ventana_recogida_fin: string;

  @ApiProperty()
  @Transform(recortar)
  @IsString()
  @MinLength(5)
  @MaxLength(255)
  direccion_recogida: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  referencia_recogida?: string;

  @ApiProperty({ type: CoordenadaDto })
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion_recogida: CoordenadaDto;

  @ApiPropertyOptional({
    description:
      'Contacto alternativo; si falta, se usa el teléfono del donante',
  })
  @IsOptional()
  @Transform(recortar)
  @IsString()
  @MaxLength(120)
  contacto_nombre?: string;

  @ApiPropertyOptional() @IsOptional() @EsTelefono() contacto_telefono?: string;

  @ApiProperty({ type: [ItemDonacionDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ItemDonacionDto)
  items: ItemDonacionDto[];
}

/** Solo en BORRADOR o EXPIRADA. Si se envía `items`, reemplaza todos los productos. */
export class ActualizarDonacionDto extends PartialType(CrearDonacionDto) {}

export class ListarDonacionesDto extends PaginacionDto {
  @ApiPropertyOptional({ enum: estado_donacion })
  @IsOptional()
  @IsIn(Object.values(estado_donacion))
  estado?: estado_donacion;

  @ApiPropertyOptional() @IsOptional() @IsUUID() almacen_id?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() desde?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() hasta?: string;
}

export class CancelarDonacionDto {
  @ApiProperty({ description: 'Motivo del catálogo CANCELACION_DONACION' })
  @IsInt()
  @Min(1)
  motivo_id: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacion?: string;
}

export class ReasignarDonacionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  observacion?: string;
}
