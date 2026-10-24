import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Token de sesión de autocompletado: el cliente genera un UUID por búsqueda y
 * lo repite hasta elegir un lugar. Google cobra la sesión completa una sola vez.
 */
export class SesionGeoDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sesion: string;
}

export class AutocompletarDto extends SesionGeoDto {
  @ApiProperty({ example: 'Calle 72 # 10' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  q: string;

  /**
   * Obsoletos: antes sesgaban la búsqueda hacia este punto. Ahora siempre se
   * busca dentro de la zona de servicio; se aceptan e ignoran para que los
   * clientes que aún los envían no reciban 400.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description:
      'Obsoleto, se ignora: la búsqueda se limita a Bogotá y municipios vecinos',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({
    deprecated: true,
    description: 'Obsoleto, se ignora (ver lat)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;
}

export class GeocodificarDto {
  @ApiProperty({ example: 'Calle 72 # 10-34, Bogotá' })
  @IsString()
  @MinLength(3)
  @MaxLength(255)
  direccion: string;
}

export class InversaDto {
  @ApiProperty({ example: 4.6533 })
  @Type(() => Number)
  @IsLatitude()
  lat: number;

  @ApiProperty({ example: -74.0836 })
  @Type(() => Number)
  @IsLongitude()
  lng: number;
}
