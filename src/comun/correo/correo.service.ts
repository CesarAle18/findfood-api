import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { ConfigApp } from '../../config/configuracion';

/** Envío de correo transaccional por SMTP propio (§19.5). Opcional. */
@Injectable()
export class CorreoService {
  private readonly logger = new Logger(CorreoService.name);
  private readonly transporte?: Transporter;
  private readonly remitente?: string;

  constructor(config: ConfigApp) {
    const url = config.get('SMTP_URL');
    if (url) {
      this.transporte = createTransport(url);
      this.remitente = config.get('SMTP_FROM');
    }
  }

  get configurado(): boolean {
    return Boolean(this.transporte);
  }

  /** Devuelve false si no hay SMTP o el envío falla; nunca lanza. */
  async enviar(para: string, asunto: string, texto: string): Promise<boolean> {
    if (!this.transporte) return false;
    try {
      await this.transporte.sendMail({
        from: this.remitente,
        to: para,
        subject: asunto,
        text: texto,
      });
      return true;
    } catch (err) {
      this.logger.error({ err, para }, 'No se pudo enviar el correo');
      return false;
    }
  }
}
