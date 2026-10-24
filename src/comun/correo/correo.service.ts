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
      this.logger.log(
        { remitente: email, nombre: this.remitente.name },
        'Correo por Brevo habilitado',
      );
    } else {
      this.logger.warn(
        { falta: apiKey ? 'BREVO_SENDER_EMAIL' : 'BREVO_API_KEY' },
        'Brevo no configurado: la contraseña temporal se devuelve al administrador',
      );
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
    if (!this.apiKey || !this.remitente) {
      this.logger.warn(
        { para, asunto },
        'Correo no enviado: Brevo no configurado',
      );
      return false;
    }

    this.logger.log({ para, asunto }, 'Enviando correo por Brevo');
    const inicio = Date.now();
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

      const detalle = await respuesta.text().catch(() => '');
      const duracionMs = Date.now() - inicio;
      if (!respuesta.ok) {
        this.logger.error(
          { estado: respuesta.status, detalle, para, duracionMs },
          'Brevo rechazó el envío',
        );
        return false;
      }
      this.logger.log(
        { para, messageId: idMensaje(detalle), duracionMs },
        'Brevo aceptó el correo',
      );
      return true;
    } catch (err) {
      const duracionMs = Date.now() - inicio;
      if (control.signal.aborted) {
        this.logger.error(
          { para, duracionMs },
          `Brevo no respondió en ${TIEMPO_LIMITE_MS / 1000} s`,
        );
      } else {
        this.logger.error(
          { err, para, duracionMs },
          'No se pudo enviar el correo',
        );
      }
      return false;
    } finally {
      clearTimeout(temporizador);
    }
  }
}

/** `messageId` de la respuesta de Brevo, para buscar el envío en sus logs. */
function idMensaje(cuerpo: string): string | undefined {
  try {
    const { messageId } = JSON.parse(cuerpo) as { messageId?: string };
    return messageId;
  } catch {
    return undefined;
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
