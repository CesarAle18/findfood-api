// Genera postman/FindFood-endpoints.postman_collection.json con TODOS los
// endpoints de la API, a partir del código compilado (dist/):
//   - rutas, parámetros y cuerpos salen del documento OpenAPI de @nestjs/swagger;
//   - los roles salen de los decoradores @Roles() y @Publica() de cada método.
// Así la colección no se desactualiza: basta con `npm run postman:generar`.
//
// No arranca el servidor ni se conecta a la base: crea la app sin init().
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(RAIZ, 'package.json'));
const SALIDA = join(RAIZ, 'postman', 'FindFood-endpoints.postman_collection.json');

// Configuración ficticia: la validación de arranque la exige, pero nada se conecta.
process.env.ENV_FILE = join(RAIZ, '.env.generador-inexistente');
process.env.NODE_ENV = 'development';
process.env.TAREAS_HABILITADAS = 'false';
process.env.DATABASE_URL = 'postgresql://generador@127.0.0.1:1/findfood';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'clave-ficticia-del-generador';
process.env.SUPABASE_JWT_SECRET = 'secreto-ficticio-del-generador';

const { NestFactory, ModulesContainer } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { AppModule } = require(join(RAIZ, 'dist', 'app.module.js'));
const { configurarApp } = require(join(RAIZ, 'dist', 'configurar-app.js'));

// --- Documento OpenAPI y roles por operación ----------------------------------

const app = await NestFactory.create(AppModule, { logger: false });
configurarApp(app);
const doc = SwaggerModule.createDocument(
  app,
  new DocumentBuilder().addBearerAuth().build(),
);

/** operationId (Controlador_metodo) → { roles, publica } */
const acceso = new Map();
for (const modulo of app.get(ModulesContainer).values()) {
  for (const { metatype: C } of modulo.controllers.values()) {
    for (const metodo of Object.getOwnPropertyNames(C.prototype)) {
      if (metodo === 'constructor') continue;
      const f = C.prototype[metodo];
      const leer = (clave) =>
        Reflect.getMetadata(clave, f) ?? Reflect.getMetadata(clave, C);
      acceso.set(`${C.name}_${metodo}`, {
        roles: leer('auth:roles') ?? null,
        publica: leer('auth:publica') ?? false,
      });
    }
  }
}
await app.close();

// --- Convenciones de la colección ---------------------------------------------

/** Carpetas en el orden del flujo; las etiquetas nuevas van al final. */
const CARPETAS = [
  ['operación', 'Operación y salud'],
  ['panel', 'Panel web (acceso y recuperación)'],
  ['identidad', 'Identidad: mi cuenta'],
  ['notificaciones', 'Notificaciones'],
  ['catálogos', 'Catálogos'],
  ['administración', 'Administración'],
  ['voluntario', 'Voluntario'],
  ['donaciones', 'Donaciones'],
  ['asignaciones', 'Asignaciones (ofertas)'],
  ['ruteo', 'Rutas y paradas'],
  ['evidencias', 'Evidencias'],
  ['incidencias', 'Incidencias'],
  ['inventario', 'Inventario'],
  ['indicadores', 'Indicadores'],
];

const TOKEN_POR_ROL = {
  ADMIN: 'token_admin',
  ASESOR_BANCO: 'token_asesor',
  DONANTE: 'token_donante',
  VOLUNTARIO: 'token_voluntario',
};

/** Recurso de la ruta → variable que guarda su id. */
const VARIABLE_POR_RECURSO = [
  ['/v1/admin/usuarios', 'usuario_id'],
  ['/v1/admin/verificaciones', 'verificacion_id'],
  ['/v1/admin/tipos-alimento', 'tipo_alimento_id'],
  ['/v1/me/dispositivos', 'dispositivo_id'],
  ['/v1/me/notificaciones', 'notificacion_id'],
  ['/v1/donaciones', 'donacion_id'],
  ['/v1/asignaciones', 'oferta_id'],
  ['/v1/rutas', 'ruta_id'],
  ['/v1/paradas', 'parada_id'],
  ['/v1/incidencias', 'incidencia_id'],
  ['/v1/almacenes', 'sede_id'],
  ['/v1/recepciones', 'recepcion_id'],
  ['/v1/inventario/lotes', 'lote_id'],
  ['/v1/distribuciones', 'distribucion_id'],
  ['/v1/alertas', 'alerta_id'],
];
const variableDe = (ruta) =>
  VARIABLE_POR_RECURSO.find(([prefijo]) => ruta.startsWith(`${prefijo}/{`) || ruta === prefijo)?.[1];

/** Valores que no son texto literal (números o variables sin comillas en el JSON). */
const crudo = (texto) => `@@${texto}@@`;

/** Ejemplos por nombre de campo: ids del environment de `npm run datos:prueba`. */
const POR_CAMPO = {
  tipo_alimento_id: crudo('{{tipo_arroz}}'),
  unidad_medida_id: crudo('{{unidad_kg}}'),
  tipo_vehiculo_id: crudo('{{vehiculo_automovil}}'),
  tipo_incidencia_id: crudo('{{tipo_incidencia_ausente}}'),
  tipo_destino_id: crudo('{{destino_comedor}}'),
  categoria_alimento_id: 1,
  donacion_id: '{{donacion_id}}',
  donacion_ids: ['{{donacion_id}}'],
  parada_id: '{{parada_id}}',
  recepcion_id: '{{recepcion_id}}',
  incidencia_id: '{{incidencia_id}}',
  asignacion_id: '{{oferta_id}}',
  almacen_id: '{{sede_id}}',
  item_id: '{{donacion_item_id}}',
  donacion_item_id: '{{donacion_item_id}}',
  ruta: '{{ruta_archivo}}',
  url_foto_vehiculo: '{{ruta_archivo}}',
  documento_frente: '{{ruta_archivo}}',
  ventana_recogida_inicio: '{{ventana_inicio}}',
  ventana_recogida_fin: '{{ventana_fin}}',
  fecha_vencimiento: '{{fecha_en_90_dias}}',
  capturada_at: '{{$isoTimestamp}}',
  confirmada_en_dispositivo: '{{$isoTimestamp}}',
  email: 'persona@findfood.local',
  id: '{{$guid}}',
  nombres: 'Nora',
  apellidos: 'Pérez',
  telefono: '+573001234567',
  contacto_nombre: 'Nora Pérez',
  contacto_telefono: '+573001234567',
  ciudad: 'Bogotá',
  direccion: 'Avenida 1 de Mayo # 30-10',
  direccion_recogida: 'Calle 72 # 10-34',
  referencia_recogida: 'Portería principal',
  titulo: 'Excedente de panadería',
  descripcion: 'Descripción de prueba',
  observacion: 'Observación de prueba',
  observaciones: 'Observación de prueba',
  motivo: 'Conteo físico del lote',
  accion_tomada: 'Se priorizó en la siguiente distribución',
  resolucion: 'Se contactó al donante y se reprogramó',
  nombre_destino: 'Comedor comunitario La Esperanza',
  activo: true,
  acepto_terminos: true,
  vida_util_dias: 30,
  capacidad_kg: 1000,
  capacidad_carga_kg: 500,
  peso_estimado_kg: 10,
  peso_real_kg: 10,
  peso_confirmado_kg: 10,
  cantidad: 10,
  puntaje: 5,
  dia_semana: 1,
  radio_cobertura_km: 10,
  tiene_refrigeracion: false,
  disponible: true,
};

/** El motivo depende del ámbito de cada operación. */
const MOTIVO_POR_OPERACION = {
  AdminController_rechazar: '{{motivo_rechazo_verificacion}}',
  DonacionesController_cancelar: '{{motivo_cancelacion}}',
  AsignacionController_rechazar: '{{motivo_rechazo_asignacion}}',
  AsignacionController_abandonar: '{{motivo_abandono}}',
};

/** Campos opcionales que conviene mostrar aunque no tengan ejemplo propio. */
const OPCIONALES_UTILES = {
  RegistrarEvidenciaDto: ['parada_id', 'ubicacion'],
  ConfirmarParadaDto: ['peso_confirmado_kg', 'ubicacion'],
  CrearDonacionDto: ['titulo', 'descripcion'],
};
/** Ejemplos que el esquema no expresa bien (un solo padre, tipo coherente). */
const AJUSTES = {
  RegistrarEvidenciaDto: { tipo: 'RECOGIDA', mime_type: 'image/jpeg' },
  CrearIncidenciaDto: { donacion_id: '{{donacion_id}}' },
  CrearUsuarioInternoDto: { rol: 'ASESOR_BANCO', email: 'nuevo.asesor@findfood.local' },
  BancoDto: { nombre: 'Banco de Alimentos de Bogotá', direccion: 'Calle 19 # 32-50' },
  CrearAlmacenDto: { nombre: 'Sede Sur' },
  ActualizarAlmacenDto: { nombre: 'Sede Sur' },
  TipoAlimentoDto: { nombre: 'Fríjol', perecedero: true },
  ActualizarTipoAlimentoDto: { nombre: 'Fríjol' },
  ActualizarParametroDto: { valor: '0.35' },
};

/** Nombres de petición que no se deducen bien del método del controlador. */
const NOMBRES = {
  SaludController_comprobar: 'Salud',
  TareasController_estado: 'Estado de las tareas programadas',
  PanelController_sesion: 'Validar acceso al panel',
  PanelController_recuperarContrasena: 'Enviar código de recuperación',
  MeController_perfil: 'Mi perfil',
  MeController_actualizar: 'Completar o actualizar mi perfil',
  MeController_impacto: 'Mi impacto',
  NotificacionesController_bandeja: 'Bandeja',
  NotificacionesController_leer: 'Marcar como leída',
  NotificacionesController_leerTodas: 'Marcar todas como leídas',
  CatalogosController_consultar: 'Catálogos',
  AdminController_verificacion: 'Detalle de verificación',
  AdminController_banco: 'Ver banco',
  AdminController_actualizarParametro: 'Cambiar parámetro',
  AdminController_listarParametros: 'Parámetros',
  VoluntarioController_solicitar: 'Solicitar ser voluntario',
  VoluntarioController_disponibilidad: 'Reemplazar franjas de disponibilidad',
  VoluntarioController_estado: 'Interruptor de disponibilidad',
  VoluntarioController_ubicacion: 'Registrar ubicación',
  AsignacionController_ofertas: 'Mis ofertas',
  AsignacionController_calificar: 'Calificar',
  EvidenciasController_urlSubida: 'URL de subida',
  LotesController_ajustar: 'Ajuste de lote',
};

/** Notas que el esquema no dice. */
const NOTAS = {
  AdminController_crearUsuario:
    'Crea la cuenta en Supabase Auth con la service role key: necesita el proyecto real (con `start:local` responde 502).',
  PanelController_sesion:
    'Llamarla justo después del login: 200 con el perfil para ADMIN y ASESOR_BANCO; 403 `acceso-panel-denegado` para cualquier otro rol.',
  PanelController_recuperarContrasena:
    'Envía el código solo a cuentas ACTIVAS con rol ADMIN o ASESOR_BANCO. Responde siempre 202 con el mismo mensaje.',
  EvidenciasController_urlSubida:
    'El `proposito` elige el bucket: EVIDENCIA → `evidencias`, PRODUCTO → `donaciones`, DOCUMENTO_IDENTIDAD y VEHICULO → `documentos-identidad`. Guarda `ruta_archivo` y `url_subida`. Pídela con el token de quien va a usar el archivo: la API solo acepta rutas subidas por esa misma cuenta.',
  EvidenciasController_registrar:
    'Antes: `URL de subida` y `Subir archivo a Storage`. Con `tipo: PUBLICACION` y `donacion_id` la puede registrar el donante sobre su propia donación; RECOGIDA y ENTREGA exigen ser el voluntario de la parada.',
  DonacionesController_crear:
    'Para probar el bucket `donaciones`, agrega `ruta_foto: "{{ruta_archivo}}"` a un producto (URL de subida con PRODUCTO y token del donante). El detalle devuelve `foto_url` firmada por 300 s.',
  VoluntarioController_solicitar:
    'Usa archivos del bucket `documentos-identidad` (URL de subida con DOCUMENTO_IDENTIDAD y VEHICULO, token del mismo donante). El ADMIN los ve en el detalle de verificación con URLs de 60 s.',
  RutasController_detalle: 'Guarda el id de la primera parada en `parada_id`.',
  DonacionesController_detalle: 'Guarda el id del primer producto en `donacion_item_id`.',
};

/** Rutas abiertas a cualquier cuenta pero pensadas para un rol concreto. */
const TOKEN_POR_OPERACION = {
  EvidenciasController_urlSubida: 'token_voluntario',
  EvidenciasController_registrar: 'token_voluntario',
  EvidenciasController_listar: 'token_voluntario',
  IncidenciasController_crear: 'token_voluntario',
};

/** Subcarpetas por recurso (primer segmento tras /v1) dentro de una etiqueta. */
const SUBCARPETAS = {
  inventario: {
    almacenes: 'Sedes',
    recepciones: 'Recepciones',
    inventario: 'Lotes',
    distribuciones: 'Distribuciones',
    alertas: 'Alertas',
  },
  ruteo: { rutas: 'Rutas', paradas: 'Paradas' },
};

const esquemas = doc.components?.schemas ?? {};
const refDe = (s) => (s?.$ref ?? s?.allOf?.[0]?.$ref)?.split('/').pop();

function ejemplo(schema, operacion, nombreCampo, profundidad = 0) {
  const ref = refDe(schema);
  if (ref) return ejemploObjeto(ref, operacion, profundidad + 1);
  if (nombreCampo === 'motivo_id' && MOTIVO_POR_OPERACION[operacion]) {
    return crudo(MOTIVO_POR_OPERACION[operacion]);
  }
  if (nombreCampo in POR_CAMPO) return POR_CAMPO[nombreCampo];
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case 'array':
      return [ejemplo(schema.items ?? {}, operacion, nombreCampo, profundidad)];
    case 'boolean':
      return false;
    case 'integer':
    case 'number':
      return 1;
    case 'object':
      return {};
    default:
      return 'Texto de ejemplo';
  }
}

function ejemploObjeto(nombre, operacion, profundidad = 0) {
  const s = esquemas[nombre];
  if (!s || profundidad > 4) return {};
  const requeridos = new Set(s.required ?? []);
  const propiedades = Object.entries(s.properties ?? {});
  const todasOpcionales = requeridos.size === 0;
  const utiles = new Set(OPCIONALES_UTILES[nombre] ?? []);
  const objeto = {};
  for (const [campo, def] of propiedades) {
    const conEjemplo = def.example !== undefined || def.enum !== undefined;
    if (todasOpcionales || requeridos.has(campo) || utiles.has(campo) || conEjemplo) {
      objeto[campo] = ejemplo(def, operacion, campo, profundidad);
    }
  }
  return { ...objeto, ...(AJUSTES[nombre] ?? {}) };
}

const comoJson = (valor) =>
  JSON.stringify(valor, null, 2).replace(/"@@(.*?)@@"/g, '$1');

const TILDES = {
  parametro: 'parámetro',
  parametros: 'parámetros',
  verificacion: 'verificación',
  verificaciones: 'verificaciones',
  ubicacion: 'ubicación',
  contrasena: 'contraseña',
  sesion: 'sesión',
};

/** "crearUsuario" → "Crear usuario" */
const humano = (metodo) => {
  const texto = metodo
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(' ')
    .map((p) => TILDES[p] ?? p)
    .join(' ');
  return texto.charAt(0).toUpperCase() + texto.slice(1);
};

// --- Peticiones ---------------------------------------------------------------

function scriptsDe(metodo, ruta, operationId) {
  const lineas = [];
  const variable = variableDe(ruta);
  const esColeccion = variable && !ruta.endsWith('}');
  if (metodo === 'post' && esColeccion && !operationId.endsWith('_sesion')) {
    lineas.push(
      'const cuerpo = pm.response.json();',
      `if (pm.response.code < 300 && cuerpo.id) pm.collectionVariables.set('${variable}', cuerpo.id);`,
    );
  }
  if (metodo === 'get' && esColeccion) {
    lineas.push(
      'const cuerpo = pm.response.json();',
      'const lista = Array.isArray(cuerpo) ? cuerpo : cuerpo.datos;',
      `if (lista?.[0]?.id && !pm.collectionVariables.get('${variable}')) pm.collectionVariables.set('${variable}', lista[0].id);`,
    );
  }
  if (operationId === 'AsignacionController_ofertas') {
    lineas.push(
      'const cuerpo = pm.response.json();',
      'if (Array.isArray(cuerpo) && cuerpo[0]) {',
      "  pm.collectionVariables.set('oferta_id', cuerpo[0].id);",
      "  pm.collectionVariables.set('donacion_id', cuerpo[0].donacion_id);",
      '}',
    );
  }
  if (operationId === 'EvidenciasController_urlSubida') {
    lineas.push(
      'const cuerpo = pm.response.json();',
      "if (cuerpo.ruta) pm.collectionVariables.set('ruta_archivo', cuerpo.ruta);",
      "if (cuerpo.url_subida) pm.collectionVariables.set('url_subida', cuerpo.url_subida);",
    );
  }
  if (operationId === 'RutasController_detalle') {
    lineas.push(
      'const cuerpo = pm.response.json();',
      "if (cuerpo.paradas?.[0]?.id) pm.collectionVariables.set('parada_id', cuerpo.paradas[0].id);",
    );
  }
  if (operationId === 'DonacionesController_detalle') {
    lineas.push(
      'const cuerpo = pm.response.json();',
      "if (cuerpo.items?.[0]?.id) pm.collectionVariables.set('donacion_item_id', cuerpo.items[0].id);",
    );
  }
  return lineas.length
    ? [{ listen: 'test', script: { type: 'text/javascript', exec: lineas } }]
    : undefined;
}

function peticion(ruta, metodo, op) {
  const { roles, publica } = acceso.get(op.operationId) ?? {
    roles: null,
    publica: false,
  };
  const token = publica
    ? null
    : (TOKEN_POR_OPERACION[op.operationId] ?? TOKEN_POR_ROL[roles?.[0] ?? 'ADMIN']);

  const segmentos = ruta.replace(/^\//, '').split('/');
  const variablesRuta = [];
  const rutaPostman = segmentos.map((s) => {
    const m = /^\{(.+)\}$/.exec(s);
    if (!m) return s;
    const prefijo = `/${segmentos.slice(0, segmentos.indexOf(s)).join('/')}`;
    const valor =
      m[1] === 'clave' ? 'PESO_PROXIMIDAD' : `{{${variableDe(prefijo) ?? m[1]}}}`;
    variablesRuta.push({ key: m[1], value: valor });
    return `:${m[1]}`;
  });

  const consulta = (op.parameters ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => ({
      key: p.name,
      value: String(p.schema?.example ?? p.schema?.default ?? ''),
      description: [p.description, p.schema?.enum ? `Valores: ${p.schema.enum.join(', ')}` : '']
        .filter(Boolean)
        .join(' · '),
      disabled: true,
    }));

  const esquemaCuerpo = op.requestBody?.content?.['application/json']?.schema;
  const nombreCuerpo = refDe(esquemaCuerpo);

  const descripcion = [
    `\`${metodo.toUpperCase()} ${ruta}\``,
    publica
      ? 'Pública: sin token.'
      : roles
        ? `Roles: ${roles.join(', ')}. Usa \`{{${token}}}\`; cámbialo por el de otro rol permitido si lo necesitas.`
        : `Cualquier cuenta autenticada. Usa \`{{${token}}}\`.`,
    NOTAS[op.operationId] ?? '',
    nombreCuerpo ? `Cuerpo: \`${nombreCuerpo}\` (ver /docs). El ejemplo trae los campos obligatorios y los que tienen ejemplo.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const request = {
    method: metodo.toUpperCase(),
    auth: token
      ? { type: 'bearer', bearer: [{ key: 'token', value: `{{${token}}}`, type: 'string' }] }
      : { type: 'noauth' },
    header: nombreCuerpo ? [{ key: 'Content-Type', value: 'application/json' }] : [],
    url: {
      raw: `{{base_url}}/${rutaPostman.join('/')}`,
      host: ['{{base_url}}'],
      path: rutaPostman,
      ...(consulta.length ? { query: consulta } : {}),
      ...(variablesRuta.length ? { variable: variablesRuta } : {}),
    },
    description: descripcion,
  };
  if (nombreCuerpo) {
    request.body = {
      mode: 'raw',
      raw: comoJson(ejemploObjeto(nombreCuerpo, op.operationId)),
      options: { raw: { language: 'json' } },
    };
  }
  const nombreMetodo = op.operationId.split('_').slice(1).join('_');
  const item = {
    name: `${NOMBRES[op.operationId] ?? humano(nombreMetodo)} · ${metodo.toUpperCase()} ${ruta.replace(/^\/v1/, '')}`,
    request,
  };
  const eventos = scriptsDe(metodo, ruta, op.operationId);
  if (eventos) item.event = eventos;
  return item;
}

const porEtiqueta = new Map();
let total = 0;
for (const [ruta, operaciones] of Object.entries(doc.paths)) {
  for (const [metodo, op] of Object.entries(operaciones)) {
    const etiqueta = op.tags?.[0] ?? 'otros';
    if (!porEtiqueta.has(etiqueta)) porEtiqueta.set(etiqueta, []);
    porEtiqueta.get(etiqueta).push({ ruta, item: peticion(ruta, metodo, op) });
    total++;
  }
}

// La subida del binario va directo a Supabase Storage (no es un endpoint de la
// API), pero sin ella no se puede probar ningún bucket: va justo tras la URL.
const evidencias = porEtiqueta.get('evidencias') ?? [];
const posicionUrl = evidencias.findIndex(({ ruta }) => ruta === '/v1/evidencias/upload-url');
evidencias.splice(posicionUrl + 1, 0, {
  ruta: '',
  item: {
    name: 'Subir archivo a Storage · PUT {{url_subida}}',
    request: {
      method: 'PUT',
      auth: { type: 'noauth' },
      header: [{ key: 'Content-Type', value: 'image/jpeg' }],
      url: { raw: '{{url_subida}}', host: ['{{url_subida}}'] },
      body: { mode: 'file', file: { src: '' } },
      description: [
        'Sube el binario directo a Supabase Storage con la URL firmada (no pasa por la API). En Body → binary elige el archivo y ajusta `Content-Type` (`image/jpeg`, `image/png`, `image/webp`, `image/heic` o `application/pdf`).',
        '',
        'Solo funciona con la API contra el proyecto real (`npm run start:dev`): con `STORAGE_SIMULADO=true` la URL es ficticia y la API da todo archivo por subido.',
      ].join('\n'),
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: ["pm.test('archivo subido', () => pm.expect(pm.response.code).to.be.below(300));"],
        },
      },
    ],
  },
});

const orden = CARPETAS.map(([etiqueta]) => etiqueta);
const carpetas = [...porEtiqueta.keys()]
  .sort((a, b) => {
    const [ia, ib] = [orden.indexOf(a), orden.indexOf(b)];
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  })
  .map((etiqueta) => ({
    name: CARPETAS.find(([e]) => e === etiqueta)?.[1] ?? etiqueta,
    item: agrupar(etiqueta, porEtiqueta.get(etiqueta)),
  }));

function agrupar(etiqueta, entradas) {
  const subcarpetas = SUBCARPETAS[etiqueta];
  if (!subcarpetas) return entradas.map((e) => e.item);
  const grupos = new Map();
  for (const { ruta, item } of entradas) {
    const recurso = ruta.split('/')[2];
    const nombre = subcarpetas[recurso] ?? recurso;
    if (!grupos.has(nombre)) grupos.set(nombre, []);
    grupos.get(nombre).push(item);
  }
  return [...grupos].map(([name, item]) => ({ name, item }));
}

// --- Scripts y variables de la colección ----------------------------------------

const preRequest = [
  '// Local: firma aquí los tokens de cada rol (HS256, igual que Supabase) con la',
  '// clave del environment de `npm run datos:prueba`; el environment no guarda JWT.',
  "// Proyecto real: pega tu access_token de Supabase en la variable token_sesion.",
  "const clave = pm.environment.get('clave_jwt_local');",
  "const roles = ['admin', 'asesor', 'donante', 'voluntario', 'solicitante'];",
  'if (clave) {',
  "  const b64url = (palabras) => CryptoJS.enc.Base64.stringify(palabras).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');",
  '  const json = (obj) => b64url(CryptoJS.enc.Utf8.parse(JSON.stringify(obj)));',
  '  const ahora = Math.floor(Date.now() / 1000);',
  '  const firmar = (sub) => {',
  "    const cuerpo = json({ alg: 'HS256', typ: 'JWT' }) + '.' + json({",
  "      sub, role: 'authenticated', aud: 'authenticated',",
  "      iss: pm.environment.get('emisor_jwt_local'), iat: ahora, exp: ahora + 3600,",
  '    });',
  "    return cuerpo + '.' + b64url(CryptoJS.HmacSHA256(cuerpo, clave));",
  '  };',
  '  for (const rol of roles) {',
  "    const id = pm.environment.get('id_' + rol);",
  "    if (id) pm.variables.set('token_' + rol, firmar(id));",
  '  }',
  "} else if (pm.collectionVariables.get('token_sesion')) {",
  "  for (const rol of roles) pm.variables.set('token_' + rol, pm.collectionVariables.get('token_sesion'));",
  '}',
  '',
  '// Fechas relativas al momento de ejecutar (ventana de recogida y vencimientos).',
  'const minutos = (m) => new Date(Date.now() + m * 60000).toISOString();',
  'const fechaBogota = (dias) => new Date(Date.now() - 5 * 3600000 + dias * 86400000).toISOString().slice(0, 10);',
  "pm.variables.set('ventana_inicio', minutos(5));",
  "pm.variables.set('ventana_fin', minutos(245));",
  "pm.variables.set('fecha_en_90_dias', fechaBogota(90));",
];

// --- Sesión: Supabase Auth -------------------------------------------------------
// No son endpoints de la API (la API nunca ve contraseñas, §4), pero sin ellos
// no hay token contra el proyecto real. Guardan la sesión en token_sesion.

const GUARDAR_SESION = [
  'const cuerpo = pm.response.json();',
  'if (cuerpo.access_token) {',
  "  pm.collectionVariables.set('token_sesion', cuerpo.access_token);",
  "  pm.collectionVariables.set('refresh_token', cuerpo.refresh_token);",
  '}',
];

function auth(nombre, metodo, ruta, { cuerpo, descripcion, guardaSesion, conSesion }) {
  const [camino, consulta] = ruta.split('?');
  const item = {
    name: `${nombre} · ${metodo} /auth/v1/${ruta}`,
    request: {
      method: metodo,
      auth: conSesion
        ? { type: 'bearer', bearer: [{ key: 'token', value: '{{token_sesion}}', type: 'string' }] }
        : { type: 'noauth' },
      header: [
        { key: 'apikey', value: '{{supabase_anon_key}}' },
        ...(cuerpo ? [{ key: 'Content-Type', value: 'application/json' }] : []),
      ],
      url: {
        raw: `{{supabase_url}}/auth/v1/${ruta}`,
        host: ['{{supabase_url}}'],
        path: ['auth', 'v1', ...camino.split('/')],
        ...(consulta
          ? { query: consulta.split('&').map((q) => ({ key: q.split('=')[0], value: q.split('=')[1] })) }
          : {}),
      },
      description: descripcion,
    },
  };
  if (cuerpo) {
    item.request.body = {
      mode: 'raw',
      raw: JSON.stringify(cuerpo, null, 2),
      options: { raw: { language: 'json' } },
    };
  }
  if (guardaSesion) {
    item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: GUARDAR_SESION } }];
  }
  return item;
}

const carpetaSesion = {
  name: 'Sesión (Supabase Auth)',
  description: [
    'Registro, inicio de sesión, renovación, códigos y cambio de contraseña. **Los atiende Supabase Auth, no la API**: solo funcionan contra el proyecto real.',
    '',
    '- Completa las variables de colección `supabase_url` y `supabase_anon_key` (Supabase → Project Settings → API).',
    '- Iniciar sesión, renovar y verificar códigos guardan `token_sesion` y `refresh_token`. Sin el environment local, la colección usa `token_sesion` para todos los roles.',
    '- Para usar ese token con la API, esta debe correr contra el proyecto real (`npm run start:dev`).',
  ].join('\n'),
  item: [
    auth('Registro', 'POST', 'signup', {
      cuerpo: {
        email: 'persona@correo.com',
        password: 'Clave-segura-123',
        data: { nombres: 'Persona', apellidos: 'De Prueba', telefono: '3001234567', acepto_terminos: true },
      },
      descripcion:
        'Todo registro nace DONANTE (el rol nunca viaja en `data`). Si el proyecto exige confirmar el correo, la cuenta queda PENDIENTE hasta confirmarlo; sin teléfono también.',
      guardaSesion: true,
    }),
    auth('Iniciar sesión', 'POST', 'token?grant_type=password', {
      cuerpo: { email: 'admin@findfood.test', password: 'FindFood-Pruebas-2026' },
      descripcion:
        'Devuelve `access_token` (el Bearer de la API) y `refresh_token`, y los guarda. En el panel web, después llama a `Validar acceso al panel`.',
      guardaSesion: true,
    }),
    auth('Renovar el token', 'POST', 'token?grant_type=refresh_token', {
      cuerpo: { refresh_token: '{{refresh_token}}' },
      descripcion: 'Cuando vence el `access_token` (por defecto, 1 hora).',
      guardaSesion: true,
    }),
    auth('Pedir código OTP (móvil)', 'POST', 'otp', {
      cuerpo: { email: 'persona@correo.com' },
      descripcion: 'Envía al correo el código de 6 dígitos para entrar sin contraseña (app móvil).',
    }),
    auth('Verificar código OTP', 'POST', 'verify', {
      cuerpo: { type: 'email', email: 'persona@correo.com', token: '123456' },
      descripcion: 'Si el código es correcto, devuelve la sesión y la guarda.',
      guardaSesion: true,
    }),
    auth('Verificar código de recuperación (panel)', 'POST', 'verify', {
      cuerpo: { type: 'recovery', email: 'admin@findfood.test', token: '123456' },
      descripcion:
        'Canjea el código que envía `Enviar código de recuperación` (Panel web). Devuelve una sesión y la guarda; con ella, `Cambiar contraseña`.',
      guardaSesion: true,
    }),
    auth('Cambiar contraseña', 'PUT', 'user', {
      cuerpo: { password: 'Nueva-Clave-2026' },
      descripcion:
        'Con la sesión iniciada (`token_sesion`). Sirve para la recuperación y para cambiar la contraseña temporal del personal: al cambiarla, la API deja de exigir CAMBIAR_PASSWORD.',
      conSesion: true,
    }),
    auth('Cerrar sesión', 'POST', 'logout', {
      descripcion: 'Revoca el `refresh_token` de la sesión actual. El panel la llama si `Validar acceso al panel` responde 403.',
      conSesion: true,
    }),
  ],
};

const variablesColeccion = [
  { key: 'supabase_url', value: 'https://mlfesivdmpopsmqfvikq.supabase.co' },
  { key: 'supabase_anon_key', value: '' },
  ...['token_sesion', 'refresh_token'].map((key) => ({ key, value: '' })),
  ...[
    ...new Set([
      ...VARIABLE_POR_RECURSO.map(([, v]) => v),
      'donacion_item_id',
      'ruta_archivo',
      'url_subida',
    ]),
  ].map((key) => ({ key, value: '' })),
];

const coleccion = {
  info: {
    _postman_id: '6d0f3a52-8f1e-4c1b-9a77-f1ad00e0d901',
    name: 'FindFood API · todos los endpoints',
    description: [
      `Los ${total} endpoints de la API, agrupados por módulo, más la carpeta de sesión de Supabase Auth (registro, login, códigos). **Generada desde el código** con \`npm run postman:generar\`: no la edites a mano, regenérala cuando cambie un controlador o un DTO.`,
      '',
      'Para recorrer el flujo completo en orden (donación → recepción) usa `FindFood.postman_collection.json`; esta colección es el catálogo de referencia.',
      '',
      '**Local:** `npm run db:local`, `npm run datos:prueba`, `npm run start:local`, importa `postman/FindFood-local.postman_environment.json` y selecciónalo. Los tokens de cada rol se firman solos.',
      '',
      '**Proyecto real:** crea un environment con `base_url`, completa `supabase_anon_key` y ejecuta `Sesión (Supabase Auth) → Iniciar sesión`: guarda `token_sesion`, que se usa para todos los roles.',
      '',
      '- Cada petición usa el token del primer rol permitido; la descripción lista los demás.',
      '- Crear y listar guardan el `id` en variables de colección (`donacion_id`, `ruta_id`, `sede_id`…), que usan las rutas con `:id`.',
      '- Los parámetros de consulta vienen desactivados: actívalos según lo que quieras filtrar.',
      '- Errores en application/problem+json con un `type` estable.',
    ].join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [carpetaSesion, ...carpetas],
  event: [
    { listen: 'prerequest', script: { type: 'text/javascript', exec: preRequest } },
    {
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: ["pm.test('sin error del servidor', () => pm.expect(pm.response.code).to.be.below(500));"],
      },
    },
  ],
  variable: variablesColeccion,
};

writeFileSync(SALIDA, `${JSON.stringify(coleccion, null, 2)}\n`);
console.log(`Colección generada: postman/FindFood-endpoints.postman_collection.json (${total} endpoints en ${carpetas.length} carpetas)`);
