/**
 * Detalle de un rechazo de Google para el log: las APIs nuevas responden
 * {error: {status, message}} (p. ej. PERMISSION_DENIED con el motivo). Nunca
 * lanza; la respuesta de Google no incluye la llave.
 */
export async function errorGoogle(
  respuesta: Response,
): Promise<{ status: number; error?: string; mensaje?: string }> {
  const cuerpo = (await respuesta.json().catch(() => null)) as {
    error?: { status?: string; message?: string };
  } | null;
  return {
    status: respuesta.status,
    error: cuerpo?.error?.status,
    mensaje: cuerpo?.error?.message,
  };
}
