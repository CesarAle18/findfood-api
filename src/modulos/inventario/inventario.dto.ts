import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { CoordenadaDto } from '../../comun/geo';
import { EsTelefono, PaginacionDto } from '../../comun/validacion';
import {
  estado_distribucion,
  tipo_almacenamiento,
} from '../../generated/prisma/enums';

// --- Almacenes ---------------------------------------------------------------

export class CrearAlmacenDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(80) nombre: string;
  @ApiProperty() @IsString() @MinLength(5) @MaxLength(255) direccion: string;
  @ApiProperty({ default: 'Bogotá' }) @IsString() @MaxLength(80) ciudad: string;

  @ApiProperty({ type: CoordenadaDto })
  @ValidateNested()
  @Type(() => CoordenadaDto)
  ubicacion: CoordenadaDto;

  @ApiPropertyOptional() @IsOptional() @EsTelefono() telefono?: string;

  @ApiProperty({
    description: 'Franjas por día en que la sede recibe',
    example: { lunes: ['08:00-17:00'] },
  })
  @IsObject()
  horario_disponibilidad: Record<string, unknown>;

  @ApiProperty({ enum: tipo_almacenamiento })
  @IsIn(Object.values(tipo_almacenamiento))
  tipo: tipo_almacenamiento;

  @ApiProperty() @IsNumber() @Min(1) capacidad_kg: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-30)
  @Max(60)
  temperatura_min?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-30)
  @Max(60)
  temperatura_max?: number;
}

export class ActualizarAlmacenDto {
  @ApiPropertyOptional({
    description:
      'Desactivar una sede llena para que el motor no le dirija donaciones (§6.6)',
  })
  @IsOptional()
  @IsBoolean()
  activo?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  nombre?: string;
  @ApiPropertyOptional() @IsOptional() @EsTelefono() telefono?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  horario_disponibilidad?: Record<string, unknown>;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(1)
  capacidad_kg?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-30)
  @Max(60)
  temperatura_min?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(-30)
  @Max(60)
  temperatura_max?: number;
}

// --- Recepción ---------------------------------------------------------------

export class ItemRecibidoDto {
  @ApiProperty() @IsUUID() donacion_item_id: string;

  @ApiPropertyOptional({ description: 'Por defecto, la cantidad declarada' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cantidad_aceptada?: number;

  @ApiPropertyOptional({
    description: 'Por defecto, el peso real o el estimado del producto',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  peso_aceptado_kg?: number;

  @ApiPropertyOptional({
    description: 'Corrige la fecha de vencimiento del lote',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  fecha_vencimiento?: string;
}

export const ESTADOS_RECEPCION = [
  'ACEPTADA',
  'ACEPTADA_PARCIAL',
  'RECHAZADA',
] as const;

export class CrearRecepcionDto {
  @ApiProperty() @IsUUID() donacion_id: string;

  @ApiProperty({ enum: ESTADOS_RECEPCION })
  @IsIn(ESTADOS_RECEPCION)
  estado: (typeof ESTADOS_RECEPCION)[number];

  @ApiPropertyOptional({
    description: 'RECHAZO_RECEPCION; obligatorio si no se acepta todo',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  motivo_id?: number;

  @ApiPropertyOptional({
    type: [ItemRecibidoDto],
    description: 'En ACEPTADA_PARCIAL, solo los productos aceptados',
  })
  @IsOptional()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ItemRecibidoDto)
  items?: ItemRecibidoDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observaciones?: string;
}

export class ListarRecepcionesDto extends PaginacionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() almacen_id?: string;
}

// --- Lotes -------------------------------------------------------------------

export class ListarLotesDto extends PaginacionDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() almacen_id?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  tipo_alimento_id?: number;
}

export const TIPOS_AJUSTE = ['AJUSTE', 'MERMA', 'VENCIMIENTO'] as const;

export class AjusteLoteDto {
  @ApiProperty({ enum: TIPOS_AJUSTE })
  @IsIn(TIPOS_AJUSTE)
  tipo: (typeof TIPOS_AJUSTE)[number];

  @ApiProperty({
    description:
      'Unidades del lote. MERMA y VENCIMIENTO siempre descuentan (valor positivo); AJUSTE admite signo',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @NotEquals(0)
  cantidad: number;

  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) motivo: string;
}

// --- Distribución ------------------------------------------------------------

export class LineaDistribucionDto {
  @ApiProperty() @IsInt() @Min(1) tipo_alimento_id: number;
  @ApiProperty() @IsInt() @Min(1) unidad_medida_id: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) cantidad: number;
}

export class CrearDistribucionDto {
  @ApiProperty() @IsInt() @Min(1) tipo_destino_id: number;
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  nombre_destino: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  documento_destino?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contacto?: string;
  @ApiPropertyOptional() @IsOptional() @EsTelefono() telefono?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  numero_beneficiarios?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  observaciones?: string;

  @ApiPropertyOptional({ description: 'Despachar solo desde esta sede' })
  @IsOptional()
  @IsUUID()
  almacen_id?: string;

  @ApiProperty({ type: [LineaDistribucionDto] })
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LineaDistribucionDto)
  lineas: LineaDistribucionDto[];
}

export class ListarDistribucionesDto extends PaginacionDto {
  @ApiPropertyOptional({ enum: estado_distribucion })
  @IsOptional()
  @IsIn(Object.values(estado_distribucion))
  estado?: estado_distribucion;
}

// --- Alertas y KPI -----------------------------------------------------------

export class AtenderAlertaDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  accion_tomada: string;
}

export class RangoFechasDto {
  @ApiPropertyOptional({ description: 'Por defecto, hace 30 días' })
  @IsOptional()
  @IsISO8601()
  desde?: string;
  @ApiPropertyOptional({ description: 'Por defecto, ahora' })
  @IsOptional()
  @IsISO8601()
  hasta?: string;
}
