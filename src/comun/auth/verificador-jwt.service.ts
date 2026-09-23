import { Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  decodeProtectedHeader,
  type JWTPayload,
  jwtVerify,
} from 'jose';
import { ConfigApp } from '../../config/configuracion';

/**
 * Verifica localmente los JWT de Supabase Auth, sin llamar al servicio:
 * con el JWKS del proyecto (en caché) o, si el proyecto aún usa el secreto
 * HS256 heredado, con ese secreto.
 */
@Injectable()
export class VerificadorJwt {
  private readonly emisor: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly secreto?: Uint8Array;

  constructor(config: ConfigApp) {
    const base = config.get('SUPABASE_URL').replace(/\/+$/, '');
    this.emisor = `${base}/auth/v1`;
    this.jwks = createRemoteJWKSet(
      new URL(`${this.emisor}/.well-known/jwks.json`),
      { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 },
    );
    const secreto = config.get('SUPABASE_JWT_SECRET');
    if (secreto) this.secreto = new TextEncoder().encode(secreto);
  }

  /** Devuelve el claim `sub` (= auth.users.id) o lanza si el token no es válido. */
  async verificar(token: string): Promise<string> {
    const opciones = { issuer: this.emisor, audience: 'authenticated' };
    const { alg } = decodeProtectedHeader(token);
    let payload: JWTPayload;
    if (alg === 'HS256') {
      if (!this.secreto) throw new Error('HS256 sin SUPABASE_JWT_SECRET');
      ({ payload } = await jwtVerify(token, this.secreto, {
        ...opciones,
        algorithms: ['HS256'],
      }));
    } else {
      ({ payload } = await jwtVerify(token, this.jwks, {
        ...opciones,
        algorithms: ['ES256', 'RS256'],
      }));
    }
    if (!payload.sub) throw new Error('Token sin sub');
    return payload.sub;
  }
}
