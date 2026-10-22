/**
 * Diseño común de los correos de FindFood: título verde, bloques de texto,
 * recuadro destacado y pie con el eslogan. Es el mismo estilo de las
 * plantillas de Supabase Auth (confirmación de correo).
 *
 * Solo tablas y estilos en línea: Gmail y Outlook ignoran <style>, flexbox y
 * la mayoría del CSS moderno. Todo el texto se escapa aquí.
 */

const VERDE = '#1f7a5a';
const VERDE_FONDO = '#eef6f1';
const VERDE_BORDE = '#d3e6db';
const VERDE_TENUE = '#4b6b5c';
const TEXTO = '#1a1a1a';
const TEXTO_TENUE = '#6b6b6b';
const DIVISOR = '#e5e5e5';
const FUENTE = 'Arial,Helvetica,sans-serif';
const MONO = "'Courier New',Courier,monospace";

export const ESLOGAN = 'Conectamos alimentos con quienes más los necesitan.';

export type BloqueCorreo =
  | { tipo: 'parrafo'; texto: string; tenue?: boolean }
  | {
      tipo: 'recuadro';
      etiqueta: string;
      filas: { nombre: string; valor: string; codigo?: boolean }[];
    };

export function escaparHtml(texto: string): string {
  return texto
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function htmlCorreo(titulo: string, bloques: BloqueCorreo[]): string {
  const cuerpo = bloques.map(bloqueHtml).join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escaparHtml(titulo)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;margin:0 auto;font-family:${FUENTE};font-size:14px;line-height:1.6;color:${TEXTO}">
<tr><td style="padding:0 0 16px;font-size:20px;font-weight:bold;line-height:1.3;color:${VERDE}">${escaparHtml(titulo)}</td></tr>
${cuerpo}
<tr><td style="padding:24px 0 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="border-top:1px solid ${DIVISOR};padding:20px 0 0;text-align:center">
<div style="font-size:14px;font-weight:bold;color:${VERDE}">FindFood</div>
<div style="font-size:12px;color:${TEXTO_TENUE}">${escaparHtml(ESLOGAN)}</div>
</td></tr>
</table>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

function bloqueHtml(bloque: BloqueCorreo): string {
  if (bloque.tipo === 'parrafo') {
    const color = bloque.tenue ? TEXTO_TENUE : TEXTO;
    return `<tr><td style="padding:0 0 12px;color:${color}">${escaparHtml(bloque.texto)}</td></tr>`;
  }
  const filas = bloque.filas
    .map((fila) => {
      const valor = fila.codigo
        ? `font-family:${MONO};font-size:22px;font-weight:bold;letter-spacing:2px;color:${VERDE}`
        : `font-size:15px;font-weight:bold;color:${TEXTO}`;
      return `<div style="padding:8px 0 0">
<div style="font-size:12px;color:${VERDE_TENUE}">${escaparHtml(fila.nombre)}</div>
<div style="${valor};word-break:break-all">${escaparHtml(fila.valor)}</div>
</div>`;
    })
    .join('');
  return `<tr><td style="padding:12px 0 24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="background:${VERDE_FONDO};border:1px solid ${VERDE_BORDE};border-radius:8px;padding:24px 16px;text-align:center">
<div style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:${VERDE_TENUE}">${escaparHtml(bloque.etiqueta)}</div>
${filas}
</td></tr>
</table>
</td></tr>`;
}
