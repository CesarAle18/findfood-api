import { Injectable } from '@nestjs/common';
import { GoogleLugaresService } from '../../comun/google/google-lugares.service';
import { noEncontrado, Problema } from '../../comun/http/problema';
import type { AutocompletarDto, GeocodificarDto, InversaDto } from './geo.dto';

/** Tope de consultas por usuario y minuto: protege el presupuesto de Google (§15.2). */
export const LIMITE_POR_MINUTO = 60;
const VENTANA_MS = 60_000;

const noDisponible = () =>
  new Problema(
    503,
    'geo-no-disponible',
    'La búsqueda de direcciones no está disponible',
    'Ubique el punto en el mapa o use el buscador del dispositivo',
  );

/**
 * Proxy de búsqueda de direcciones para la app y el panel: la llave de
 * servidor nunca sale de la API. Solo lectura: no escribe ubicaciones, que
 * siguen llegando como CoordenadaDto a los endpoints de cada dominio. Todo se
 * limita a la zona de servicio (Bogotá y municipios vecinos): lo que queda
 * afuera responde 404, igual que una dirección que no existe.
 */
@Injectable()
export class GeoService {
  private readonly consultas = new Map<
    string,
    { inicio: number; cuenta: number }
  >();
  constructor(private readonly lugares: GoogleLugaresService) {}

  async autocompletar(usuarioId: string, dto: AutocompletarDto) {
    this.limitar(usuarioId);
    const sugerencias = await this.lugares.autocompletar(dto.q, dto.sesion);
    if (!sugerencias) throw noDisponible();
    return { sugerencias };
  }

  async lugar(usuarioId: string, placeId: string, sesion: string) {
    this.limitar(usuarioId);
    if (!/^[\w-]{1,512}$/.test(placeId)) throw noEncontrado('Lugar');
    const lugar = await this.lugares.detalle(placeId, sesion);
    if (lugar === null) throw noDisponible();
    if (!lugar) throw noEncontrado('Lugar');
    return lugar;
  }

  async geocodificar(usuarioId: string, dto: GeocodificarDto) {
    this.limitar(usuarioId);
    const r = await this.lugares.geocodificar(dto.direccion);
    if (r === null) throw noDisponible();
    if (!r) throw noEncontrado('Dirección');
    return r;
  }

  async inversa(usuarioId: string, dto: InversaDto) {
    this.limitar(usuarioId);
    const r = await this.lugares.geocodificarInversa(dto);
    if (r === null) throw noDisponible();
    if (!r) throw noEncontrado('Dirección');
    return { direccion: r.direccion };
  }

  /** Ventana fija por usuario, en memoria: la API corre como un solo proceso. */
  private limitar(usuarioId: string): void {
    if (!this.lugares.disponible) throw noDisponible();
    const ahora = Date.now();
    const actual = this.consultas.get(usuarioId);
    if (!actual || ahora - actual.inicio >= VENTANA_MS) {
      this.consultas.set(usuarioId, { inicio: ahora, cuenta: 1 });
      return;
    }
    if (++actual.cuenta > LIMITE_POR_MINUTO) {
      throw new Problema(
        429,
        'demasiadas-solicitudes',
        'Demasiadas búsquedas de direcciones',
        'Espere un minuto e intente de nuevo',
      );
    }
  }
}
