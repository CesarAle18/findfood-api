import { Injectable, Logger } from '@nestjs/common';
import { ConfigApp } from '../../config/configuracion';
import { type BloqueCorreo, htmlCorreo } from './plantilla';

const URL_BREVO = 'https://api.brevo.com/v3/smtp/email';
const TIEMPO_LIMITE_MS = 10_000;

/**
 * Envío de correo transaccional por la API HTTP de Brevo (§19.5). Opcional.
 *
 * Se usa la API REST y no SMTP porque Railway bloquea los puertos salientes
 * 25/465/587/2525 en todos los planes por debajo de Pro. La API va por HTTPS
 * (443), que sí está permitido.
 */
@Injectable()
export class CorreoService {
  private readonly logger = new Logger(CorreoService.name);
  private readonly apiKey?: string;
  private readonly remitente?: { email: string; name: string };

  constructor(config: ConfigApp) {
    const apiKey = config.get('BREVO_API_KEY');
    const email = config.get('BREVO_SENDER_EMAIL');
    if (apiKey && email) {
      this.apiKey = apiKey;
      this.remitente = {
        email,
        name: config.get('BREVO_SENDER_NAME') ?? 'FindFood',
      };
    }
  }

  get configurado(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Devuelve false si no hay Brevo o el envío falla; nunca lanza. Sin `html`,
   * cada línea de `texto` se vuelve un párrafo del diseño común.
   */
  async enviar(
    para: string,
    asunto: string,
    texto: string,
    html?: string,
  ): Promise<boolean> {
    if (!this.apiKey || !this.remitente) return false;

    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), TIEMPO_LIMITE_MS);

    try {
      const respuesta = await fetch(URL_BREVO, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender: this.remitente,
          to: [{ email: para }],
          subject: asunto,
          textContent: texto,
          htmlContent: html ?? htmlTextoPlano(asunto, texto),
        }),
        signal: control.signal,
      });

      if (!respuesta.ok) {
        const detalle = await respuesta.text().catch(() => '');
        this.logger.error(
          { estado: respuesta.status, detalle, para },
          'Brevo rechazó el envío',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error({ err, para }, 'No se pudo enviar el correo');
      return false;
    } finally {
      clearTimeout(temporizador);
    }
  }
}

/** Versión HTML de un correo de solo texto: los filtros puntúan peor sin ella. */
function htmlTextoPlano(asunto: string, texto: string): string {
  return htmlCorreo(
    asunto,
    texto
      .split('\n')
      .filter((linea) => linea.trim())
      .map((linea): BloqueCorreo => ({ tipo: 'parrafo', texto: linea })),
  );
}
