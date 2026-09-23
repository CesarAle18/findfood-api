import { Injectable, Logger } from '@nestjs/common';
import { ConfigApp } from '../../config/configuracion';

export interface MensajePush {
  token: string;
  titulo: string;
  cuerpo: string;
  data?: Record<string, unknown>;
}

export type ResultadoPush =
  { ok: true } | { ok: false; error: string; tokenInvalido: boolean };

/** Proveedor de push detrás de una interfaz: Expo hoy, FCM directo si el equipo lo decide (§19.4). */
export abstract class ProveedorPush {
  abstract enviar(mensajes: MensajePush[]): Promise<ResultadoPush[]>;
}

const URL_EXPO = 'https://exp.host/--/api/v2/push/send';
const MAX_POR_LOTE = 100;

interface TicketExpo {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

@Injectable()
export class ExpoPushService extends ProveedorPush {
  private readonly logger = new Logger(ExpoPushService.name);
  private readonly accessToken?: string;

  constructor(config: ConfigApp) {
    super();
    this.accessToken = config.get('EXPO_ACCESS_TOKEN');
  }

  async enviar(mensajes: MensajePush[]): Promise<ResultadoPush[]> {
    const resultados: ResultadoPush[] = [];
    for (let i = 0; i < mensajes.length; i += MAX_POR_LOTE) {
      resultados.push(
        ...(await this.lote(mensajes.slice(i, i + MAX_POR_LOTE))),
      );
    }
    return resultados;
  }

  private async lote(mensajes: MensajePush[]): Promise<ResultadoPush[]> {
    const respuesta = await fetch(URL_EXPO, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(this.accessToken
          ? { Authorization: `Bearer ${this.accessToken}` }
          : {}),
      },
      body: JSON.stringify(
        mensajes.map((m) => ({
          to: m.token,
          title: m.titulo,
          body: m.cuerpo,
          data: m.data ?? {},
          sound: 'default',
          priority: 'high',
          channelId: 'default',
        })),
      ),
    });
    if (!respuesta.ok) {
      throw new Error(`Expo Push respondió ${respuesta.status}`);
    }
    const { data } = (await respuesta.json()) as { data?: TicketExpo[] };
    return mensajes.map((_m, i): ResultadoPush => {
      const ticket = data?.[i];
      if (ticket?.status === 'ok') return { ok: true };
      const codigo = ticket?.details?.error ?? 'Desconocido';
      if (codigo !== 'DeviceNotRegistered') {
        this.logger.warn(
          { codigo, mensaje: ticket?.message },
          'Push rechazado',
        );
      }
      return {
        ok: false,
        error: `${codigo}: ${ticket?.message ?? 'sin detalle'}`.slice(0, 500),
        tokenInvalido: codigo === 'DeviceNotRegistered',
      };
    });
  }
}
