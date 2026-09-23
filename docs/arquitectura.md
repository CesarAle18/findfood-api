# FindFood — Documento de arquitectura

**Sistema de gestión y trazabilidad de donaciones de alimentos con asignación optimizada de voluntarios**

| | |
|---|---|
| Versión | 1.1: backend en NestJS, como define el anteproyecto |
| Fecha | 22 de septiembre de 2026 |
| Alcance | Backend NestJS (repositorio propio), base de datos y servicios externos. La app móvil y el panel web aparecen solo como consumidores del contrato de la API. |
| Fuentes | Anteproyecto de grado · `modelo_datos_banco_alimentosv2.md` · `schema_banco_alimentosv2.sql` |
| Esquema vigente | `supabase/migrations/20260922000000_esquema_inicial.sql` (DDL v3). Por ahora vive en `packages/database/supabase/migrations/` del repositorio `findfood_api` y se mueve al repositorio del backend en la Fase 1 (§20). |
| Estándar de referencia | IEEE Std 1016-2009. El documento se organiza por vistas: contexto, composición, interacción, datos, despliegue y seguridad. |

> **Cómo leer este documento.** Las secciones 2 a 5 dan la visión de conjunto. Las secciones 6 a 10 explican los mecanismos difíciles: asignación, plazos, ruteo, tiempo real e inventario. La 11 es el contrato de la API. La 14 enumera los problemas que la revisión encontró en el modelo v2 y cómo los corrige el DDL v3. Cuando este documento y el modelo v2 discrepan, **manda el DDL v3**.

---

## 1. Propósito y alcance

Este documento describe **cómo se construye** el sistema definido en el anteproyecto. Sus insumos son el modelo de datos y el DDL que el equipo ya elaboró. Cubre:

- los componentes, su responsabilidad y cómo se comunican;
- el diseño detallado de los mecanismos con reglas de negocio no triviales: asignación en cascada, plazos, ruteo, trazabilidad en tiempo real y FEFO;
- el contrato de la API que consumen la app móvil y el panel web;
- las decisiones de diseño, sus alternativas descartadas y qué cuestan;
- los hallazgos de la revisión del modelo v2 y su corrección en el DDL v3.

**Fuera de alcance**, igual que en el anteproyecto (§5.2): navegación con indicaciones de voz (la app abre un navegador externo), facturación electrónica, gestión de beneficiarios finales, iOS y operación fuera de Bogotá.

---

## 2. Decisión principal: monolito modular en NestJS (ADR-01)

**Contexto.** El anteproyecto (§5.1, §9.3, §9.8) define el backend como un monolito modular en **NestJS**, desplegado en Railway. El repositorio `findfood_api` se había creado desde la plantilla **next-forge** (Next.js en Vercel), y la versión 1.0 de este documento proponía quedarse con ella. El equipo confirmó NestJS.

**Decisión.**
- El backend es una aplicación **NestJS** en un **repositorio nuevo y propio**, desplegada como un **proceso persistente en Railway**.
- `findfood_api` deja de ser el backend. Solo aloja este documento y las migraciones hasta que se muevan (§20).

| Lo que pide el anteproyecto | Cómo se implementa |
|---|---|
| Monolito modular con módulos de autenticación, donaciones, asignación, ruteo, inventario y notificaciones | Un módulo de NestJS por dominio, en un único despliegue (§5). |
| Guard que valida rol y estado en cada petición | `AuthGuard` global + `RolesGuard` con el decorador `@Roles()` (§5.2). |
| Trabajos programados (plazos de 10 y 30 minutos) | Tareas en el mismo proceso con `@nestjs/schedule` (§7). |
| Actualización en vivo del panel sin recargar | Supabase Realtime (§9) |
| Pruebas con Jest y Supertest | Las que trae NestJS por defecto |

**Por qué NestJS y no la plantilla Next.js.**
1. **Es lo que aprobó el anteproyecto**, así que no hay desviación que justificar ante la tutora.
2. **Tiene un proceso vivo.** Los temporizadores de la cascada corren dentro de la aplicación, sin un reloj externo ni un endpoint público para dispararlo. Las conexiones a la base de datos se reutilizan y no hay límites de duración por invocación.
3. **La estructura modular viene de serie:** módulos, inyección de dependencias, guards, pipes de validación y filtros de excepciones. Es justo lo que el diseño necesita.
4. **La plantilla next-forge trae de más:** siete aplicaciones y una veintena de paquetes orientados a un SaaS con Next.js (Clerk, Stripe, CMS), que habría que retirar.

**Costos que se aceptan.**
- Hay un servidor que operar y pagar: Railway, ya presupuestado.
- Se descarta la configuración del repositorio `findfood_api`: validación de entorno, Sentry y CI. Hay que montarla de nuevo en el repositorio NestJS.

---

## 3. Requisitos

### 3.1 Funcionales (resumen por módulo)

| Módulo | Responsabilidad |
|---|---|
| Identidad | Registro móvil como donante (código OTP), alta de asesores por el administrador con contraseña temporal, solicitud y verificación del rol voluntario, suspensión, dispositivos push |
| Donaciones | Borrador con productos, publicación, cancelación, historial de estados |
| Asignación | Filtros duros, puntaje multicriterio, oferta en cascada con plazos, aceptación, rechazo y abandono |
| Ruteo | Agrupación de recogidas, orden de paradas, confirmación con foto, peso, GPS y hora, modo sin conexión |
| Inventario | Recepción (total, parcial o rechazo), lotes por producto, salida FEFO, alertas de vencimiento, distribución |
| Notificaciones | Push, bandeja dentro de la app y actualización en vivo del panel |
| Transversal | Incidencias, evidencia fotográfica, calificaciones, parámetros, auditoría, indicadores |

### 3.2 No funcionales (anteproyecto §9.7), con su frontera de medición

| Atributo (ISO/IEC 25010) | Criterio | Qué se mide exactamente |
|---|---|---|
| Eficiencia de desempeño | P95 ≤ 500 ms al filtrar candidatos, sobre ≥ 100 solicitudes | Solo la **etapa 1** (`fn_candidatos_donacion`), sin la llamada a Google. Esta excluye la latencia de red de un tercero, que no controlamos (§6.3). |
| Adecuación funcional | ≥ 90 % de asignaciones con candidato válido y **0** asignaciones que violen un filtro duro | Lo garantiza la etapa 1. El 90 % depende de que existan voluntarios factibles en los datos de prueba. |
| Calidad de ruta | ≤ 10 % sobre el óptimo en rutas de 2 a 5 paradas | Vecino más cercano + 2-opt frente a fuerza bruta, con la misma matriz de duraciones (§8). |
| FEFO | 100 % de las selecciones automáticas respetan FEFO | Consulta de salida de §10.2. |
| Flujo completo | 100 % de los casos de prueba completan creación → recepción con su trazabilidad | Prueba de integración de extremo a extremo. |
| Seguridad | Control de acceso por rol verificado con pruebas automáticas | Pruebas de los guards (Jest + Supertest) más las comprobaciones de privilegios del DDL (§13). |

### 3.3 Restricciones

- Cinco personas × 15 h/semana × 12 semanas, en seis iteraciones Scrum.
- Presupuesto desembolsable de unos 994.400 COP. **Es la restricción que más condiciona el uso de Google Maps** (§15.2).
- App móvil solo para Android. Operación solo en Bogotá (zona horaria única: `America/Bogota`).
- Ley 1581 de 2012: consentimiento, finalidad y retención de datos personales.
- Pruebas con datos ficticios si no hay un banco aliado.

---

## 4. Vista de contexto y componentes

```
   ┌─────────────────────────┐          ┌─────────────────────────┐
   │ App móvil (Expo)        │          │ Panel web (React + Vite)│
   │ Android · DONANTE,      │          │ ADMIN, ASESOR_BANCO     │
   │ VOLUNTARIO              │          │                         │
   └──┬──────────┬───────┬───┘          └───┬─────────┬───────┬───┘
      │ (1) login│OTP    │(3) broadcast     │(1) login│       │(3) canal
      │          │       │ ruta:<id>        │         │       │ banco:donaciones
      ▼          │       ▼                  ▼         │       ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │ SUPABASE (misma región que la API)                                   │
 │  ┌────────────┐ ┌──────────────────────────┐ ┌──────────┐ ┌────────┐ │
 │  │ Auth       │ │ Postgres 15+ / PostGIS   │ │ Realtime │ │Storage │ │
 │  │ (GoTrue)   │─┤ esquemas auth + public   │─┤ canales  │ │buckets │ │
 │  │ JWT, OTP   │ │ RLS en todas las tablas  │ │ privados │ │privados│ │
 │  └────────────┘ └──────────────────────────┘ └──────────┘ └───▲────┘ │
 └────────────────────▲──────────────────────────────────────────┼──────┘
                      │                                          │ (4) subida
       (5) SQL como   │                                          │ con URL
       app_backend    │                                          │ firmada
       (Supavisor)    │  ┌────────────────────────────────┐      │
                      └──┤ API NestJS (proceso persistente│◄─────┴── (2) REST /v1
                         │ en Railway)                    │     Bearer JWT desde
                         │ guards · módulos · scheduler   │     móvil y web
                         └────┬───────────────────┬───────┘
                              │ (6)               │ (7)
                              ▼                   ▼
                     ┌──────────────────┐  ┌──────────────────┐
                     │ Google Routes API│  │ Expo Push / FCM  │
                     │ Route Matrix,    │  │                  │
                     │ Compute Routes   │  │                  │
                     └──────────────────┘  └──────────────────┘
```

| # | Interacción | Detalle |
|---|---|---|
| 1 | Cliente ↔ Supabase Auth | Inicio de sesión, código OTP de 6 dígitos (móvil), restablecimiento con `token_hash` (web) y refresh token. **La API nunca ve contraseñas.** |
| 2 | Cliente → API | Toda operación de negocio. JWT de Supabase en `Authorization: Bearer`. |
| 3 | Cliente ↔ Realtime | Solo canales *broadcast* privados autorizados por políticas (§9). Los clientes **no** consultan tablas por PostgREST. |
| 4 | Cliente → Storage | Subida directa de fotos con una URL firmada que emite la API. La base de datos guarda la ruta del objeto. |
| 5 | API → Postgres | Rol `app_backend` con un *pool* de conexiones persistente a través de Supavisor en modo sesión (§12.2). |
| 6 | API → Google | Etapa 2 del motor de asignación y cálculo de rutas. Siempre con *fallback* (§6.3). |
| 7 | API → push | Envío desde la bandeja de salida `notificacion` (§7). |

**Regiones.** La API y Supabase deben estar **en la misma región**. La latencia API ↔ base de datos se paga varias veces por petición; la de cliente (Bogotá) ↔ API, una sola vez. Railway no ofrece región en Sudamérica, así que se recomienda **este de EE. UU. (Virginia) para ambos**: Railway US East y Supabase `us-east-1`. Desde Bogotá esa región suele estar más cerca, en latencia, que São Paulo. Hay que confirmarlo en el panel de cada proveedor antes de crear el proyecto de Supabase, porque su región no se puede cambiar después.

---

## 5. Vista de composición: la aplicación NestJS

### 5.1 Estructura del repositorio

```
findfood-backend/                      (nombre a elegir)
├── supabase/
│   └── migrations/                    DDL v3 y siguientes: fuente de verdad del esquema (§12)
├── prisma/
│   └── schema.prisma                  generado con `prisma db pull`, nunca editado a mano
├── src/
│   ├── main.ts                        ValidationPipe global, filtro problem+json, prefijo /v1
│   ├── app.module.ts
│   ├── config/                        validación de variables de entorno al arrancar
│   ├── comun/
│   │   ├── auth/                      AuthGuard, RolesGuard, @Roles(), @PermitirPendiente(),
│   │   │                              @UsuarioActual(), verificación JWT (JWKS)
│   │   ├── http/                      filtro de excepciones problem+json, idempotencia
│   │   ├── prisma/                    PrismaService (pool persistente, transacciones)
│   │   └── supabase/                  cliente con service role: administración de Auth y Storage
│   └── modulos/
│       ├── identidad/                 /me, dispositivos, solicitud de voluntario, disponibilidad
│       ├── admin/                     asesores, verificaciones, suspensiones, parámetros
│       ├── donaciones/                borrador, publicación, cancelación, historial
│       ├── asignacion/                filtros, puntaje, cascada, aceptar/rechazar/abandonar
│       ├── ruteo/                     agrupación, vecino más cercano + 2-opt, cliente de Google
│       ├── evidencias/                URLs firmadas, registro
│       ├── incidencias/
│       ├── inventario/                recepción, lotes FEFO, ajustes, distribución, alertas
│       ├── notificaciones/            bandeja de salida, envío push
│       ├── parametros/                lectura tipada de parametro_sistema (con caché corta)
│       └── tareas/                    @Cron: vencimientos, cascada, envío, alertas, retención (§7)
└── test/                              e2e con Jest + Supertest
```

**Regla de dependencia.**
- Los controladores solo reciben el DTO ya validado, llaman a un servicio y devuelven la respuesta.
- Los servicios contienen las reglas y abren las transacciones.
- Un módulo usa a otro solo a través de los servicios que ese módulo **exporta**. Por ejemplo, `asignacion` importa `NotificacionesModule` para encolar avisos, pero nunca toca sus tablas directamente.
- Las dependencias entre módulos quedan declaradas en cada `@Module({ imports })`, así que se ven en el código.

### 5.2 Guards: autenticación y roles

Dos guards globales (`APP_GUARD`) se ejecutan en todas las rutas, en este orden:

```
petición ─► AuthGuard
            1. ¿Trae Bearer? ────────────── no ─► 401
               (salvo rutas marcadas @Publica(), p. ej. /health)
            2. Verificar firma del JWT con el JWKS de Supabase (sin llamar a Auth)
               y leer el claim sub ──────── inválido o vencido ─► 401
            3. SELECT usuario + usuario_rol activos WHERE id = sub (1 consulta)
            4. ¿usuario.estado = ACTIVO? ─── SUSPENDIDO/INACTIVO ─► 403
                                             PENDIENTE ─► solo rutas @PermitirPendiente()
                                             (GET/PATCH /v1/me)
            5. ¿debe_cambiar_password? ──── sí ─► solo GET /v1/me (el cliente
                                             redirige a la pantalla de cambio;
                                             el cambio ocurre en Supabase Auth)
            6. Deja usuario y roles en la petición → @UsuarioActual()
        ─► RolesGuard
            7. roles del usuario ∩ @Roles(...) del endpoint ≠ ∅ ── no ─► 403
        ─► controlador
```

Ejemplo de uso:

```ts
@Post(':id/aceptar')
@Roles('VOLUNTARIO')
aceptar(@Param('id', ParseUUIDPipe) id: string, @UsuarioActual() usuario: UsuarioAutenticado) {
  return this.asignacion.aceptar(id, usuario);
}
```

- El paso 3 consulta la base de datos en cada petición. Es deliberado: **una suspensión o un retiro de rol surten efecto en la siguiente petición**, sin esperar a que venza el token (modelo v2, §9, punto 20).
- La verificación del JWT es local (JWKS en caché). Si el proyecto aún usa el secreto HS256 heredado, se verifica con ese secreto.
- El paso 7 **interseca conjuntos**: una persona puede ser DONANTE y VOLUNTARIO a la vez.
- **Como los guards son globales, una ruta nueva nace protegida.** Olvidar un decorador la deja cerrada, no abierta. Una ruta sin `@Roles()` exige autenticación pero no un rol concreto.

### 5.3 Convenciones transversales

- **Errores:** un filtro de excepciones global responde `application/problem+json` (RFC 9457), con un `type` estable por regla de negocio (por ejemplo `oferta-vencida` u `oferta-ya-respondida`) para que la app muestre mensajes precisos.
- **Validación:** DTOs con `class-validator` y un `ValidationPipe` global con `whitelist` y `forbidNonWhitelisted`. Los campos que no declara el DTO se rechazan, así nadie puede colar `estado` o `donante_id`. Los mismos DTOs alimentan la documentación OpenAPI (`@nestjs/swagger`).
- **Idempotencia:** toda mutación que la app móvil pueda reintentar sin conexión lleva `Idempotency-Key` o un `id` generado en el cliente (§8.4).
- **Transacciones:** toda transición de estado escribe en la misma transacción la fila de `historial_estado` y, si corresponde, la de `notificacion` (`prisma.$transaction`). Así nunca hay un cambio de estado sin trazabilidad ni un aviso sin cambio.

---

## 6. Motor de asignación

### 6.1 Flujo completo

```
POST /v1/donaciones/{id}/publicar  (DONANTE dueño, donación en BORRADOR)
  │ transacción
  ├─ validar productos, pesos y ventana (fin > inicio, inicio en el futuro)
  ├─ requiere_refrigeracion y fecha_vencimiento_min ← agregados de donacion_item
  ├─ score_urgencia ← fórmula de §6.5
  ├─ almacen_destino_id ← §6.6
  ├─ estado PUBLICADA · publicada_at = now()
  │  expira_publicacion_at = now() + PUBLICACION_TIMEOUT_MIN
  └─ historial_estado
  │ fuera de la transacción (no retener conexiones mientras se llama a Google)
  ├─ ETAPA 1  fn_candidatos_donacion(id, radio)  para radio en RADIO_BUSQUEDA_KM_PASOS,
  │           hasta obtener candidatos
  ├─ ETAPA 2  Route Matrix sobre los MAX_CANDIDATOS_MATRIX más cercanos
  ├─ PUNTAJE  s(v,d); candidato_asignacion con posición
  └─ OFERTA 1 (transacción): asignacion intento=1 + notificacion ASIGNACION_OFRECIDA
```

Si ningún radio produce candidatos, la donación queda PUBLICADA sin oferta viva. La tarea `vencer_ofertas` la reintenta cada minuto (§7), porque algún voluntario puede entrar en su franja o encender su interruptor. Si llega a `expira_publicacion_at`, pasa a EXPIRADA y se avisa al donante.

### 6.2 Etapa 1: filtros duros en la base de datos

`fn_candidatos_donacion(p_donacion_id, p_radio_km)` (DDL v3, §18.2) devuelve el conjunto factible F(d). Un voluntario es factible solo si cumple **todas** estas condiciones:

| Filtro | Condición |
|---|---|
| Cuenta | `usuario.estado = 'ACTIVO'`, sin borrado lógico |
| Rol | `usuario_rol` VOLUNTARIO **activo** (una solicitud pendiente no cuenta) |
| Verificación | `voluntario.estado_verificacion = 'APROBADA'` |
| Intención | `voluntario.disponible` (interruptor) |
| Capacidad | `capacidad_carga_kg ≥ peso_estimado_kg` |
| Cadena de frío | si la donación requiere refrigeración, `tiene_refrigeracion` |
| Cercanía | `ST_DWithin` con el radio de búsqueda **y** con el `radio_cobertura_km` del voluntario (usa el índice GiST) |
| Horario | alguna franja activa **se solapa** con la ventana de recogida, evaluada en hora de Bogotá, día a día (una ventana que cruza la medianoche se compara con ambos días) |
| Conflicto de interés | el voluntario no es el propio donante |

**Por qué hay una función nueva.** La consulta de la v2 (modelo §7.1) tenía dos errores. Con la sesión en UTC (así corre Supabase), `EXTRACT(DOW …)` y `::time` sobre un `timestamptz` calculan el día y la hora en UTC: una recogida a las 08:00 de Bogotá se evaluaba como si fuera a las 13:00. Además exigía que la franja *contuviera* toda la ventana, cuando el anteproyecto (§8.2) define *solapamiento*. La prueba P3 del DDL reproduce el error de la v2 y verifica la corrección (§14).

### 6.3 Etapa 2: tiempos reales con Google Route Matrix

- Se toman los `MAX_CANDIDATOS_MATRIX` (10) candidatos más cercanos por distancia geodésica. Con uno solo, no se llama a Google.
- La llamada es `computeRouteMatrix` con orígenes = `ubicacion_base` de los candidatos y destino = punto de recogida. Devuelve la distancia y la duración reales de cada candidato.
- **Plazo de 2 s y *fallback*.** Si Google falla, tarda o se agota la cuota, el puntaje usa la distancia geodésica y una velocidad urbana de referencia. La asignación **nunca** se bloquea por un tercero.
- Se usa `ubicacion_base` (declarada), no la posición en vivo. Esto coincide con la decisión del modelo v2 (§8.4.5) y es lo menos invasivo en privacidad.

### 6.4 Puntaje: `s(v,d) = w₁·proximidad + w₂·urgencia + w₃·confiabilidad + w₄·holgura_carga`

Los pesos son los parámetros `PESO_PROXIMIDAD`, `PESO_URGENCIA`, `PESO_CONFIABILIDAD` y `PESO_HOLGURA`. Los valores iniciales son 0,35 / 0,25 / 0,25 / 0,15, y la API rechaza una configuración cuya suma no sea 1.

**Hallazgo: la urgencia, tal como está definida, no ordena voluntarios.** El anteproyecto define la urgencia como las horas hasta el vencimiento más próximo de la donación. Ese valor es **el mismo para todos los candidatos** de una donación. Con la normalización min–max dentro de F(d), `x_máx = x_mín` y el término vale lo mismo para todos, así que w₂ no influye en el orden. La urgencia sí es útil, pero para otra cosa: **priorizar donaciones entre sí** (§6.5).

Propuesta para mantener cuatro criterios que sí distinguen entre voluntarios:

| Criterio | Valor crudo por voluntario v | Sentido |
|---|---|---|
| Proximidad | duración de viaje de la etapa 2 (o distancia geodésica en *fallback*) | costo |
| Urgencia → **holgura temporal** | `ventana_recogida_fin − (ahora + ETA_v)`, en minutos. Si es negativa, v no alcanza a llegar y **se descarta** como filtro duro. | beneficio |
| Confiabilidad | **tasa** con valor previo: `(completadas + α·p₀) / (aceptadas + α)`, con p₀ = 0,8 y α = 5 | beneficio |
| Holgura de carga | `1 − |r − r*| / max(r*, 1 − r*)` con `r = peso / capacidad` y `r* = 0,6`. Penaliza tanto la sobreutilización como la subutilización, como pide el anteproyecto. | beneficio |

Notas de la propuesta:
- **Confiabilidad como tasa y no como conteo.** Un conteo de entregas favorece siempre a los veteranos. El valor previo evita que un voluntario nuevo empiece en 0 o en 1. Los rechazos **no** la reducen, porque rechazar está permitido; los abandonos después de aceptar, sí.
- **Normalización.** Se conserva la min–max dentro de F(d) del anteproyecto, con dos salvedades documentadas. Si `x_máx = x_mín`, x′ = 1 para todos. Con F(d) pequeño, la min–max exagera diferencias mínimas (0,1 km se convierte en "0 contra 1"). El anteproyecto mismo describe la proximidad "relativa al radio máximo", que es una normalización con referencia fija (`1 − d/radio`), más estable. **Se recomienda usar referencia fija en proximidad** y dejar que el equipo lo decida.

Cada candidato se guarda en `candidato_asignacion` con su posición y su puntaje. Eso responde a la pregunta "¿por qué me llegó esta oferta a mí y no a otro?".

### 6.5 Urgencia de la donación (`donacion.score_urgencia`)

Ordena la cola de donaciones publicadas (índice `ix_donacion_abiertas`) y sirve para priorizar reintentos. La fórmula propuesta combina los tres factores del marco conceptual del anteproyecto (§8.2) con referencias fijas, para que sea comparable entre donaciones:

```
u_d = 0,6 · (1 − min(1, horas_hasta_vencimiento_min / 72))
    + 0,2 · [requiere_refrigeracion]
    + 0,2 · (1 − min(1, minutos_hasta_fin_de_ventana / 240))
```

Los coeficientes son un punto de partida y deben validarse con el banco. Si no hay fecha de vencimiento (no perecederos), el primer término vale 0.

### 6.6 Selección de la sede destino

1. Se toman los almacenes activos cuyo `tipo` corresponde al régimen de la donación. **Solo existen dos regímenes: SECO y REFRIGERADO** (decisión del equipo; el DDL v3 no admite CONGELADO). Si algún producto requiere refrigeración (`donacion.requiere_refrigeracion`), la donación va a un almacén REFRIGERADO; si no, a uno SECO.
2. Entre ellos, gana el más cercano al punto de recogida.

Si no queda ningún almacén activo del régimen requerido, la publicación se rechaza con `409 sin-almacen-disponible`. Así el donante se entera en el momento y no cuando nadie pueda recibir la donación.

**El sistema no calcula la capacidad libre de los almacenes.** La gestionan las personas del banco de alimentos:
- Cuando una sede está llena, un asesor la desactiva (`almacen.activo = false`) con `PATCH /v1/almacenes/{id}`, y el motor deja de dirigirle donaciones. Al liberarse espacio, la reactiva.
- Si aun así llega una donación que no cabe, la recepción puede rechazarla con el motivo `SIN_CAPACIDAD`, que ya existe en el catálogo.
- `almacen.capacidad_kg` queda como dato informativo de la sede. No interviene en la selección.

> **Consecuencia de quitar CONGELADO.** El marco conceptual del anteproyecto (§8.2, "Régimen térmico") nombra tres regímenes: seco, refrigerado y congelado. Con dos, un producto congelado solo puede declararse como refrigerado, y el banco no tiene dónde mantenerlo congelado. Conviene definir en el catálogo `tipo_alimento` que el banco **no recibe congelados**, o que los recibe como refrigerados para distribución inmediata, y ajustar el texto del marco conceptual en el documento final.

> **Pregunta abierta de modelo.** En la v2 cada `almacen` es a la vez una **sede** (tiene ubicación) y una **cámara** de un solo régimen térmico (tiene `tipo`). Una sede real con bodega seca y cuarto frío tendría que registrarse dos veces con la misma dirección. Y una donación mixta (seca + refrigerada) solo puede tener un destino. Esto funciona si cada sede es de un solo régimen. Si no, conviene separar `sede` y `almacen` antes de cargar datos (§19).

### 6.7 Oferta en cascada y concurrencia

**Plazos.** Cada oferta vence en `min(ofrecida_at + ASIGNACION_TIMEOUT_MIN, expira_publicacion_at)`. Con 10 y 30 minutos caben tres ofertas completas. Una cuarta, si se crea, vence junto con la publicación: el plazo global siempre manda.

**Aceptar** es una sola sentencia condicional dentro de una transacción:

```sql
BEGIN;
UPDATE asignacion
   SET estado = 'ACEPTADA', aceptada_at = now(), respondida_at = now()
 WHERE id = $oferta AND voluntario_id = $yo
   AND estado = 'OFRECIDA' AND expira_at > now()
RETURNING donacion_id;                         -- 0 filas → 409 oferta-vencida / ya-respondida
UPDATE donacion SET estado = 'ASIGNADA', asignada_at = now()
 WHERE id = $donacion AND estado = 'PUBLICADA'; -- 0 filas → ROLLBACK, 409 donacion-no-disponible
INSERT INTO historial_estado …;  INSERT INTO notificacion … ;   -- al donante
COMMIT;
```

**Por qué no hay carreras:**
- La condición `expira_at > now()` la evalúa la base de datos. Aunque la tarea programada se retrase, una oferta vencida nunca se acepta.
- Si la tarea programada y la aceptación compiten por la misma fila, el bloqueo de fila hace que una de las dos vea el estado ya cambiado y no haga nada.
- El índice único parcial `uq_asignacion_vigente` impide a nivel de motor que existan dos ofertas vivas. Si dos procesos intentan crear la siguiente oferta a la vez, uno falla y se descarta sin efecto.

**Rechazar** cierra el intento con su motivo y crea **en la misma petición** la oferta al siguiente candidato, sin esperar a la tarea programada. **Abandonar** tras aceptar cierra la asignación (ABANDONADA), devuelve la donación a PUBLICADA si queda plazo y reanuda la cascada. Si la ventana ya no permite otra recogida, abre una incidencia.

---

## 7. Reloj y trabajos programados

El proceso de NestJS es persistente, así que el reloj vive **dentro de la aplicación**. El módulo `tareas` usa `@nestjs/schedule` con decoradores `@Cron`:
- **Las tareas diarias** declaran `timeZone: 'America/Bogota'`.
- **La lógica vive en los servicios de cada módulo**, en TypeScript y con pruebas. Esto respeta la decisión del modelo v2 de no poner reglas de negocio en `plpgsql` (§6.3 del modelo). El módulo `tareas` solo dispara.
- **Sin reloj externo.** No hace falta `pg_cron`, ni `pg_net`, ni un endpoint público para dispararlo.

| Tarea | Cadencia | Qué hace |
|---|---|---|
| `vencer_ofertas` | 1 min | OFRECIDA con `expira_at ≤ now()` → EXPIRADA; ofrece la donación al siguiente candidato si la publicación sigue vigente, y reintenta el matching de las publicadas sin oferta viva |
| `expirar_publicaciones` | 1 min | PUBLICADA con `expira_publicacion_at ≤ now()` → EXPIRADA, cierra su oferta viva y avisa al donante (`DONACION_EXPIRADA`) |
| `enviar_notificaciones` | 1 min | Envía las filas `PENDIENTE` de `notificacion` por lotes. Reintenta con espera creciente y marca FALLIDA al quinto intento. Si el proveedor responde que el token no existe, desactiva el `dispositivo_push`. |
| `alertas_vencimiento` | diaria, 06:00 hora de Bogotá | Genera `alerta_inventario` para los lotes que vencen dentro de `DIAS_ALERTA_VENCIMIENTO`. El índice único `uq_alerta_abierta` impide duplicados. |
| `cuentas_sin_confirmar` | diaria | Elimina con la API de administración las cuentas de `fn_cuentas_sin_confirmar(DIAS_RETENCION_SIN_CONFIRMAR)` |
| `purgar_candidatos` | diaria | Borra `candidato_asignacion` con más de `DIAS_RETENCION_CANDIDATOS` días |

**Reglas de todas las tareas:**
- Toman sus filas con `FOR UPDATE SKIP LOCKED` y en lotes acotados. Si una ejecución se solapa con la anterior, o si algún día hay **varias réplicas** de la API ejecutando el mismo `@Cron`, cada una procesa filas distintas y ninguna procesa dos veces.
- Son idempotentes: ejecutarlas dos veces no cambia el resultado.
- Se basan en marcas de tiempo guardadas en la base (`expira_at`, `expira_publicacion_at`), no en temporizadores en memoria. Si el proceso se reinicia (un despliegue, una caída), la primera ejecución tras el arranque procesa lo que venció mientras tanto. No se pierde nada.
- Una ejecución no espera a la anterior: si una tarea tarda más que su cadencia, se omite ese ciclo con un registro en el log.

**Railway debe mantener el proceso siempre encendido.** Hay que desactivar la opción que duerme los servicios inactivos. Si el proceso duerme, no hay reloj. La ruta `/health` sirve para que Railway reinicie el servicio si deja de responder.

**Resolución.** Con un ciclo por minuto, una oferta puede quedar "vencida pero sin cerrar" hasta unos 60 s. Esto no afecta la corrección, porque aceptar exige `expira_at > now()`. Solo retrasa la oferta al siguiente candidato, algo aceptable frente a plazos de 10 minutos. Si se quiere menos, basta con bajar la cadencia a 30 s.

**Sobre Supabase Queues.** El anteproyecto lo nombra. Aquí la propia tabla `notificacion`, con su índice parcial sobre PENDIENTE, ya funciona como cola transaccional: el aviso se encola en la misma transacción que el cambio de estado que lo provoca, sin coordinar dos sistemas. Queues (pgmq) queda disponible si aparece un trabajo que no encaje en una tabla existente.

---

## 8. Ruteo y trabajo en calle

### 8.1 Agrupación

Un voluntario con varias asignaciones ACEPTADAS del mismo día puede agruparlas en una ruta (`POST /v1/rutas`). La agrupación es válida si se cumplen tres condiciones:
- como máximo `MAX_PARADAS_POR_RUTA` recogidas;
- cada donación está a menos de `DISTANCIA_MAX_AGRUPACION_KM` de al menos otra del grupo;
- la **suma** de pesos estimados cabe en `capacidad_carga_kg` (regla que el modelo v2 dejó pendiente en §9.11).

La ruta resultante tiene N paradas RECOGIDA y una parada ENTREGA en el `almacen_destino_id`.

### 8.2 Orden de paradas

1. Una sola Route Matrix de (N + 2)² elementos (voluntario, recogidas, sede). Con N ≤ 5 son como máximo 49.
2. **Vecino más cercano** por duración, empezando en la ubicación del voluntario y terminando en la sede.
3. **2-opt** hasta que ningún intercambio mejore.
4. **Validación:** cada llegada estimada cae dentro de su ventana, y la carga acumulada nunca supera la capacidad. Si una ventana se incumple, se prueba la mejor permutación factible. Con N ≤ 5 son como máximo 120 permutaciones, un cálculo trivial.
5. `computeRoutes` con el orden final: la polilínea se guarda en `ruta.geometria`, junto con la distancia y la duración estimadas, y `proveedor_ruteo = 'GOOGLE'`.

**Benchmark (§9.7).** La fuerza bruta sobre la misma matriz da el óptimo. Se reportan la desviación media, el peor caso y el tiempo de cada método. Usar la misma matriz para ambos aísla la calidad del algoritmo de la variabilidad del tráfico.

**Decisión: un motor por uso (ADR-08).**

| Uso | Motor | Motivo |
|---|---|---|
| Operación: etapa 2 del motor de asignación, orden de paradas y polilínea de la ruta | **Google Routes API** (`computeRouteMatrix`, `computeRoutes`) | Tiempos con tráfico real de Bogotá. Es lo presupuestado. |
| *Benchmarks* masivos de calidad de ruta (§9.7) | **OSRM** en contenedor, con el extracto de OpenStreetMap de Colombia de Geofabrik [27] | Permite miles de instancias sin consumir cuota de Google |

- OSRM **no** se despliega en producción ni es *fallback* de la operación: si Google falla, el *fallback* es la distancia geodésica (§6.3).
- El campo `ruta.proveedor_ruteo` (`GOOGLE` u `OSRM`) indica qué motor calculó cada ruta, así las rutas de un *benchmark* nunca se confunden con las reales.

> **Corrección al anteproyecto.** §9.5 dice "en la instancia de motor de rutas de Google Maps, en un contenedor con el mapa de Colombia [27]", y mezcla los dos motores. Google Routes es un servicio en la nube y no corre en un contenedor. El contenedor con el mapa de Colombia es OSRM. El documento final debería separarlos como en la tabla anterior.

### 8.3 Confirmación en la parada

`POST /v1/paradas/{id}/confirmar` recibe:
- el peso real;
- la ubicación y su precisión (`precision_confirmacion_m`);
- la hora del dispositivo;
- las evidencias ya subidas (§8.5).

Si la precisión del GPS es peor que `GPS_PRECISION_MIN_M`, la app ofrece la **confirmación manual**, que queda marcada en `confirmacion_manual = true` para auditoría (anteproyecto §9.5). La API registra en la misma transacción:
- el cambio de estado de la parada;
- el `historial_estado` con la ubicación;
- `donacion.peso_recogido_kg` y el paso a EN_RECOLECCION o EN_TRANSITO;
- la notificación al donante.

### 8.4 Modo sin conexión

Si se pierde la señal, la app encola las acciones y las envía al recuperarla (anteproyecto §9.5). Para que el reenvío sea seguro:
- **Cada acción lleva un identificador generado en el móvil**: el `id` (UUID) de la evidencia o la cabecera `Idempotency-Key` de la confirmación. Un reenvío produce la misma respuesta y ningún efecto duplicado (`INSERT … ON CONFLICT (id) DO NOTHING`).
- **Se conservan dos relojes.** `capturada_at` es la hora del dispositivo, la que importa para la trazabilidad. `created_at` es la hora del servidor, la que importa para detectar reenvíos tardíos.
- **Las transiciones se validan contra el estado actual.** Una confirmación que llega después de que la parada se cerró por otra vía responde 409 y la app la descarta con aviso.

### 8.5 Evidencia fotográfica

1. `POST /v1/evidencias/upload-url` devuelve una **URL firmada de subida** a un bucket privado, con una ruta que decide la API: `evidencias/<usuario>/<uuid>.jpg`.
2. La app sube el archivo directamente a Storage. El binario no pasa por la API, lo que no ocupa memoria ni ancho de banda del servidor.
3. `POST /v1/evidencias` registra la ruta, el hash SHA-256, la ubicación, su precisión y la hora. La API comprueba que el objeto existe y pertenece a quien lo registra.

La base de datos guarda **rutas, nunca URLs firmadas**, porque estas caducan. Para mostrar una foto, la API genera una URL firmada de corta duración al leer.

---

## 9. Tiempo real y notificaciones

### 9.1 Bandeja del banco sin recargar (anteproyecto §9.3)

Un disparador sobre `donacion` (DDL v3, §19.1) emite un mensaje *broadcast* al tópico privado `banco:donaciones` en cada cambio de estado. El mensaje lleva el id, el código, el estado nuevo y el anterior, la sede, el peso y la ventana. El panel se suscribe al canal y, si necesita más detalle, lo pide a la API.

**Se prefirió *broadcast* sobre `postgres_changes`.** `postgres_changes` obligaría a abrir SELECT sobre `donacion` al rol `authenticated` mediante políticas RLS finas. Con *broadcast*, el cliente nunca lee tablas, el mensaje contiene solo los campos elegidos, y la autorización es una política pequeña sobre `realtime.messages`: solo el personal ACTIVO y sin contraseña temporal pendiente.

### 9.2 Ubicación del voluntario en tiempo real (objetivo general del anteproyecto)

- Durante una ruta, la app del voluntario emite su posición por *broadcast* en el tópico `ruta:<id>` cada pocos segundos. **Estas posiciones no se guardan en la base de datos.**
- Pueden escuchar el canal el personal y el donante, este último **solo** mientras la ruta está EN_CURSO y su parada no se ha completado. Es el principio de finalidad de la Ley 1581: el donante ve llegar al voluntario, no lo sigue después.
- Solo el voluntario de la ruta puede emitir.
- Cada pocos minutos la app llama a `POST /v1/voluntario/ubicacion` y se guarda una muestra en `voluntario.ultima_ubicacion`, útil para soporte e incidencias.

### 9.3 Push

- Los tokens de Expo/FCM se registran en `dispositivo_push` (varios por persona).
- Toda notificación nace como fila `PENDIENTE` en `notificacion`, dentro de la transacción del hecho que la provoca, y la envía la tarea `enviar_notificaciones` (§7). La misma fila es la entrada de la bandeja dentro de la app (`leida_at`).
- Las plantillas viven en `tipo_notificacion`.

---

## 10. Recepción e inventario FEFO

### 10.1 Recepción

`POST /v1/recepciones` (ASESOR_BANCO), en una sola transacción:
1. Crea `recepcion_donacion`: ACEPTADA, ACEPTADA_PARCIAL o RECHAZADA. El rechazo lleva un motivo del catálogo; la aceptación parcial registra el peso recibido y el rechazado.
2. Por cada producto aceptado crea un `lote_inventario` con su fecha de vencimiento y su `donacion_item_id`. Esa referencia es la cadena de trazabilidad lote → producto → donación → donante.
3. Registra un `movimiento_inventario` de tipo ENTRADA por lote, con su saldo.
4. Pasa la donación a RECIBIDA (o RECHAZADA), actualiza `peso_recibido_kg` y los contadores de impacto del donante y del voluntario, y agrega `historial_estado` y la notificación.

### 10.2 Salida FEFO

```sql
SELECT id, cantidad_disponible, fecha_vencimiento
  FROM lote_inventario
 WHERE banco_id = $1 AND tipo_alimento_id = $2
   AND estado = 'DISPONIBLE' AND cantidad_disponible > 0
 ORDER BY fecha_vencimiento ASC NULLS LAST, fecha_ingreso ASC
 FOR UPDATE SKIP LOCKED;
```

- `NULLS LAST` envía los no perecederos al final.
- `fecha_ingreso` desempata.
- `SKIP LOCKED` evita que dos operarios despachen el mismo lote.

La API consume lotes en ese orden hasta cubrir la cantidad pedida. Cada descuento del saldo y su `movimiento_inventario` (SALIDA) van en la misma transacción, de modo que el saldo siempre se puede reconstruir desde el libro mayor. Para el 100 % de cumplimiento FEFO de §9.7, una prueba compara cada selección automática contra `vw_inventario_fefo`.

> El anteproyecto (§5.2) deja fuera "la trazabilidad posterior a quién se entrega". El modelo conserva `distribucion` como **registro de salida del inventario**, sin gestión de beneficiarios, lo cual es coherente.

---

## 11. Contrato de la API (`/v1`)

Todas las rutas usan JSON, exigen JWT (salvo las indicadas) y devuelven errores `problem+json`. La columna **Roles** es el `@Roles()` del endpoint, que verifica `RolesGuard` (§5.2).

### Identidad y cuentas

| Método y ruta | Roles | Descripción |
|---|---|---|
| `GET /v1/me` | cualquier cuenta autenticada, incluso PENDIENTE o con contraseña temporal | Perfil, roles activos y banderas (`debe_cambiar_password`, estado). La app decide a qué pantalla ir. |
| `PATCH /v1/me` | cualquier cuenta autenticada, incluso PENDIENTE | Completar el perfil: teléfono, nombres. Activa la cuenta si ya tiene correo confirmado (registro con Google). |
| `GET /v1/me/impacto` | DONANTE, VOLUNTARIO | Pantalla "Mi impacto" |
| `POST /v1/me/dispositivos` · `DELETE /v1/me/dispositivos/{id}` | DONANTE, VOLUNTARIO | Registro y baja del token push |
| `POST /v1/voluntario/solicitud` | DONANTE | Crea `voluntario`, rol VOLUNTARIO inactivo y `verificacion_identidad` PENDIENTE (con las rutas de las fotos ya subidas) |
| `PUT /v1/voluntario/disponibilidad` | VOLUNTARIO | Reemplaza las franjas semanales |
| `PATCH /v1/voluntario/estado` | VOLUNTARIO | Interruptor `disponible` |
| `POST /v1/voluntario/ubicacion` | VOLUNTARIO | Muestra periódica de `ultima_ubicacion` |

### Administración

| Método y ruta | Roles | Descripción |
|---|---|---|
| `POST /v1/admin/asesores` | ADMIN | Crea la cuenta con la API de administración de Supabase: `email_confirm: true`, `app_metadata: { rol: 'ASESOR_BANCO', password_temporal: true }` y `user_metadata` con nombres y teléfono (obligatorio). |
| `GET /v1/admin/verificaciones` · `POST …/{id}/aprobar` · `POST …/{id}/rechazar` | ADMIN | Bandeja de verificación. Aprobar activa el rol por disparador (DDL v3, §17.2). Los documentos se ven con URL firmada de 60 s. |
| `POST /v1/admin/usuarios/{id}/suspender` · `…/reactivar` | ADMIN | `suspension_cuenta` + estado + cierre de sesiones con la API de administración |
| `GET /v1/admin/parametros` · `PUT /v1/admin/parametros/{clave}` | ADMIN | Valida el tipo y que los `PESO_*` sumen 1 |

### Donaciones y asignación

| Método y ruta | Roles | Descripción |
|---|---|---|
| `POST /v1/donaciones` | DONANTE | Borrador con productos |
| `GET /v1/donaciones` · `GET /v1/donaciones/{id}` | DONANTE (las suyas), ADMIN, ASESOR_BANCO | Listado y detalle |
| `PATCH /v1/donaciones/{id}` | DONANTE | Solo en BORRADOR |
| `POST /v1/donaciones/{id}/publicar` | DONANTE | §6.1 |
| `POST /v1/donaciones/{id}/cancelar` | DONANTE, ADMIN | Con motivo. Cierra la oferta viva. |
| `GET /v1/donaciones/{id}/historial` | dueño, ADMIN, ASESOR_BANCO | Trazabilidad completa |
| `GET /v1/donaciones/{id}/candidatos` | ADMIN, ASESOR_BANCO | Auditoría del matching (`candidato_asignacion`) |
| `GET /v1/asignaciones/ofertas` | VOLUNTARIO | Ofertas vivas y aceptadas propias |
| `POST /v1/asignaciones/{id}/aceptar` · `…/rechazar` · `…/abandonar` | VOLUNTARIO | §6.7. Rechazar y abandonar exigen motivo. |
| `POST /v1/asignaciones/{id}/calificacion` | DONANTE, VOLUNTARIO | Una vez por parte, tras COMPLETADA |

### Ruteo, evidencia e incidencias

| Método y ruta | Roles | Descripción |
|---|---|---|
| `POST /v1/rutas` · `GET /v1/rutas/{id}` | VOLUNTARIO, ASESOR_BANCO | Agrupar y ordenar (§8.1–8.2) |
| `POST /v1/rutas/{id}/iniciar` | VOLUNTARIO | PLANIFICADA → EN_CURSO |
| `POST /v1/paradas/{id}/llegada` · `POST /v1/paradas/{id}/confirmar` | VOLUNTARIO (ASESOR_BANCO en la ENTREGA) | §8.3. Idempotentes. |
| `POST /v1/evidencias/upload-url` · `POST /v1/evidencias` | cualquier rol operativo | §8.5 |
| `POST /v1/incidencias` · `GET /v1/incidencias` · `POST /v1/incidencias/{id}/resolver` | reportar: todos; resolver: ADMIN | Tipos como donante ausente o alimento en mal estado. Algunas bloquean la donación (`tipo_incidencia.bloquea_donacion`). |

### Inventario

| Método y ruta | Roles | Descripción |
|---|---|---|
| `POST /v1/recepciones` | ASESOR_BANCO | §10.1 |
| `GET /v1/almacenes` · `PATCH /v1/almacenes/{id}` | ASESOR_BANCO, ADMIN | Listar sedes y activarlas o desactivarlas para recibir donaciones (§6.6) |
| `GET /v1/inventario/lotes` | ASESOR_BANCO, ADMIN | Vista FEFO por sede y tipo |
| `POST /v1/inventario/lotes/{id}/ajuste` | ASESOR_BANCO | AJUSTE, MERMA o VENCIMIENTO con motivo |
| `POST /v1/distribuciones` · `POST /v1/distribuciones/{id}/confirmar` | ASESOR_BANCO | Salida FEFO (§10.2) |
| `GET /v1/alertas` · `POST /v1/alertas/{id}/atender` | ASESOR_BANCO | Alertas de vencimiento y capacidad |
| `GET /v1/kpis/…` | ASESOR_BANCO, ADMIN | Kilos recuperados, tiempos del ciclo, merma, zonas, tasa de aceptación |

### Operación

| Método y ruta | Autenticación | Descripción |
|---|---|---|
| `GET /health` | ninguna (`@Publica()`) | Comprobación de vida para Railway (`@nestjs/terminus`), incluye la base de datos |
| `GET /docs` | ninguna en desarrollo; deshabilitada en producción | Documentación OpenAPI generada desde los DTOs |

---

## 12. Vista de datos y acceso

### 12.1 SQL primero, Prisma para leer y escribir

- **Fuente de verdad:** las migraciones SQL en `supabase/migrations/` del repositorio del backend, aplicadas con la CLI de Supabase (`supabase db push`). El esquema depende de cosas que Prisma no sabe expresar: PostGIS, disparadores sobre `auth.users`, índices únicos parciales, disparadores de restricción, RLS y políticas de Realtime.
- **Cliente tipado:** `prisma db pull` introspecciona la base y genera `prisma/schema.prisma` y el cliente, que usa `PrismaService` (§5.1). Las columnas `geography`/`geometry` aparecen como `Unsupported(...)`, así que toda operación geográfica, el motor de asignación y la consulta FEFO con `SKIP LOCKED` van por `$queryRaw` o por funciones SQL (`fn_candidatos_donacion`).
- **Nunca `prisma migrate` ni `prisma db push`.** Prisma no conoce los objetos del DDL que no sabe expresar y los borraría o los ignoraría. El flujo es: nueva migración SQL → `supabase db push` → `prisma db pull` → `prisma generate`.
- **Solo lectura sobre `auth`.** La llave foránea `usuario.id → auth.users.id` obliga a que la introspección vea el esquema `auth` (`schemas = ["public", "auth"]` en el `datasource`). El código nunca escribe en él: las cuentas se crean y eliminan con la API de administración de Supabase.

### 12.2 Conexión

- La API se conecta como **`app_backend`** con un *pool* persistente (`@prisma/adapter-pg`), a través de **Supavisor en modo sesión** (puerto 5432 del *pooler*, usuario `app_backend.<ref-del-proyecto>`).
  - El modo sesión encaja con un proceso de larga vida: admite sentencias preparadas.
  - El tamaño del *pool* se fija pequeño (unas 10 conexiones), porque el plan de Supabase limita el total de conexiones.
- La contraseña se asigna fuera del repositorio: `ALTER ROLE app_backend WITH LOGIN PASSWORD …`.
- Las migraciones corren con el rol `postgres`.
- Ninguna consulta depende de la zona horaria de la sesión: las que la necesitan la fijan explícitamente, como hace `fn_candidatos_donacion`.

### 12.3 Denormalizaciones y quién las mantiene

| Campo | Fuente de verdad | Lo actualiza |
|---|---|---|
| `donacion.fecha_vencimiento_min`, `requiere_refrigeracion` | `donacion_item` | servicio de donaciones, al guardar el borrador y al publicar |
| `lote_inventario.cantidad_disponible`, `peso_disponible_kg` | `movimiento_inventario` | servicio de inventario, en la misma transacción que el movimiento |
| contadores y `calificacion_promedio` de `donante`/`voluntario` | `donacion`, `asignacion`, `calificacion` | servicios al completar la recepción o al calificar |
| `usuario.email`, `email_verificado_at` | `auth.users` | disparador `tg_auth_user_sincronizado` (la API nunca los escribe) |

Cada una tiene una prueba que recalcula el agregado desde la fuente y lo compara.

---

## 13. Seguridad

### 13.1 Superficie expuesta de Supabase (hallazgo crítico)

Supabase publica el esquema `public` como API REST (PostgREST), y la **anon key viaja dentro de la app móvil**: no es un secreto. El modelo v2 (§6.3) consideraba RLS como "defensa en profundidad" porque la API se conecta con su propio rol. **Pero PostgREST no pasa por la API.** Con el DDL v2 tal cual, cualquier persona con la app instalada podía leer `usuario`, `verificacion_identidad` y el resto, y escribir en ellas.

El DDL v3 (§20) aplica tres barreras independientes:
1. `REVOKE ALL` sobre tablas, vistas y secuencias de `public` para `anon` y `authenticated`, más privilegios por defecto para que las migraciones futuras no los devuelvan.
2. RLS activo en **las 39 tablas**, sin políticas para los clientes. `app_backend` tiene su propia política permisiva.
3. Las funciones propias no son ejecutables por PUBLIC (PostgREST las publica como `/rpc`). `fn_cuentas_sin_confirmar`, por ejemplo, devolvía correos de `auth.users`. Las vistas usan `security_invoker`. La única excepción son las cuatro funciones auxiliares de Realtime, que solo informan sobre quien pregunta.

**Regla para migraciones futuras:** toda tabla nueva debe crearse con `ENABLE ROW LEVEL SECURITY` y su política `pol_app_backend`. Una prueba automática (la P5 del arnés, llevada al CI) lo comprueba.

### 13.2 Identidad y roles

- **El rol nunca sale de lo que escribe el cliente.** `raw_user_meta_data` lo controla quien se registra (`signUp({ options: { data } })`). El v2 leía de ahí el rol, así que **cualquiera podía registrarse como ADMIN**. En la v3 el rol interno solo llega por `raw_app_meta_data`, que únicamente escribe la API de administración con la *service role key*. Esa llave vive solo en el servidor.
- Todo registro propio, por correo o Google, nace DONANTE y crea su fila en `donante`.
- **El teléfono es obligatorio para todas las cuentas.** Es el único canal de contacto directo entre donante y voluntario. Se exige en tres puntos:

  | Cómo nace la cuenta | Dónde se pide el teléfono |
  |---|---|
  | Registro móvil con correo | Campo **obligatorio** del formulario. Viaja en `user_metadata.telefono` del `signUp`. |
  | Registro móvil con Google | Pantalla de completar perfil, obligatoria antes de operar: `PATCH /v1/me` |
  | Alta de asesor por el administrador | Campo obligatorio de `POST /v1/admin/asesores` |

  - La API lo valida en los DTOs: 10 dígitos, con prefijo `+57` opcional, y lo guarda normalizado.
  - En la base de datos la columna `usuario.telefono` admite nulo, porque el registro con Google crea la fila antes de que la persona escriba su teléfono. Pero `ck_usuario_telefono_activo` impide que una cuenta llegue a ACTIVO sin él.
  - Una cuenta sin teléfono se queda en PENDIENTE, y `AuthGuard` solo le deja usar `GET/PATCH /v1/me` (§5.2). Aunque alguien llame a `signUp` saltándose la app, no puede operar hasta registrar el teléfono.
- ADMIN/ASESOR_BANCO y DONANTE/VOLUNTARIO no pueden coexistir activos en una cuenta: lo impide un disparador de restricción (DDL §17.1).
- **Suspensión:** además de marcar el estado, la API cierra las sesiones de la persona con la API de administración. `AuthGuard` bloquea desde la siguiente petición (§5.2).

### 13.3 Archivos

Los buckets `donaciones`, `evidencias` y `documentos-identidad` son **privados**. `storage.objects` no tiene políticas para clientes: se sube con URL firmada emitida por la API y se lee con URL firmada de corta duración. Los documentos de identidad solo los ve el ADMIN, con URLs de 60 s.

### 13.4 Secretos

| Secreto | Dónde vive |
|---|---|
| *Service role key*, cadena de conexión de `app_backend`, llave de Google del servidor, credenciales push | Variables del servicio en Railway, validadas al arrancar (`src/config/`). Si falta una, la API no inicia. |
| Llave de Google del cliente (mapas en la app) | Distinta de la del servidor, restringida por paquete Android y por API |

### 13.5 Ley 1581 de 2012

- Consentimiento: `acepto_terminos_at`.
- Finalidad: la ubicación en vivo no se persiste y el donante solo la ve durante su recogida.
- Retención: purga de cuentas sin confirmar y de candidatos. **Falta decidir** el plazo para los documentos de identidad tras la verificación (§19).
- Al cerrar una cuenta, se elimina en `auth.users` por la API de administración y el borrado se propaga al perfil. Las donaciones históricas conservan el registro porque las llaves foráneas usan RESTRICT: al perfil se le aplica borrado lógico, no físico.

---

## 14. Hallazgos de la revisión y cambios del DDL v3

Cada cambio se verificó cargando la migración v3 **sin modificar** en PostgreSQL 16 + PostGIS 3.4, con el esquema `auth` y Realtime simulados y la sesión en UTC.

| # | Gravedad | Hallazgo en v2 | Corrección en v3 | Prueba |
|---|---|---|---|---|
| 1 | **Crítica** | El disparador de alta tomaba `rol` y `password_temporal` de `raw_user_meta_data`, que controla el cliente: cualquiera podía registrarse como ADMIN | Rol interno solo desde `raw_app_meta_data`, en el INSERT o en un UPDATE posterior (`fn_aplicar_rol_interno`, idempotente). El registro propio siempre es DONANTE. | P1, P2a, P2b |
| 2 | **Crítica** | Tablas, vistas y funciones de `public` expuestas por PostgREST a la anon key, sin RLS | Tres barreras de §13.1 | P5, P6 |
| 3 | Alta | El alta asignaba el rol DONANTE pero no creaba la fila en `donante`: la primera donación no tenía a qué `donante_id` apuntar, y nadie tenía asignado crearla | Se crea en el alta | P1 |
| 4 | Alta | La consulta de candidatos calculaba el día y la hora en la zona de la sesión (UTC) y exigía que la franja contuviera la ventana | `fn_candidatos_donacion`: hora de Bogotá, solapamiento día a día, rol VOLUNTARIO activo, exclusión del propio donante | P3 |
| 5 | Media | La urgencia no distingue entre voluntarios de una misma donación (§6.4) | Propuesta de holgura temporal y parámetros `PESO_*` | — (diseño) |
| 6 | Media | Faltaban la ubicación reciente del voluntario y la precisión GPS / confirmación manual que pide el anteproyecto §9.5 | `voluntario.ultima_ubicacion(_at)`, `parada_ruta.precision_confirmacion_m`, `confirmacion_manual`, `evidencia.precision_m` | carga |
| 7 | Media | La actualización en vivo del panel no tenía mecanismo definido | Disparador `realtime.send` + políticas de canal | P7 |
| 8 | Baja | Faltaban parámetros para el motor y la retención | `RADIO_BUSQUEDA_KM_PASOS`, `MAX_CANDIDATOS_MATRIX`, `PESO_*`, `GPS_PRECISION_MIN_M`, `DIAS_RETENCION_*`, tipo de notificación `DONACION_EXPIRADA` | carga |
| 9 | Baja | La invariante "nunca dos ofertas vivas" dependía de la aplicación | Ya estaba en v2 (`uq_asignacion_vigente`); se verificó | P4 |
| 10 | Decisión | `tipo_almacenamiento` admitía CONGELADO | Solo SECO y REFRIGERADO: el banco no opera almacenamiento congelado (§6.6) | carga |

**Señalado, sin cambio en el DDL:**
- **Teléfono.** Decidido: obligatorio en todos los formularios de alta (§13.2). El modelo v2 (§3.B, "Datos que pide el formulario de registro") todavía dice "teléfono (opcional)" y debe corregirse.
- **Sede y cámara en `almacen`** (§6.6).
- **Desfase entre el modelo v2 y su DDL.** El `.md` menciona `tipo_donante`, `ix_donante_ubicacion`, `numero_documento` en `verificacion_identidad` y `banco_id` en `parada_ruta` y `recepcion_donacion`. Ninguno existe en el DDL, que usa `almacen_id`. El `.md` debería actualizarse o marcarse como histórico.
- **Motor de rutas.** Decidido: Google para operar y OSRM solo para *benchmarks* (§8.2). Falta corregir el texto de §9.5 del anteproyecto.

---

## 15. Escala, costo y confiabilidad

### 15.1 Carga estimada (piloto en Bogotá)

| Magnitud | Supuesto | Consecuencia |
|---|---|---|
| Donaciones publicadas | ~200/día, picos de ~30/hora | Decenas de escrituras por minuto: trivial para una instancia de Postgres |
| Voluntarios / personal | ~500 / ~20 | Una consulta GiST sobre 500 filas cabe holgadamente en el P95 de 500 ms |
| Mensajes en tiempo real | Ubicación cada ~5 s por ruta activa | Unos pocos mensajes por segundo en el pico, dentro del plan gratuito de Realtime |
| Crecimiento de tablas | `notificacion`, `historial_estado`, `auditoria` crecen más rápido | Índices BRIN y parciales ya en el DDL. El particionamiento queda para cuando haga falta (§18). |

**La carga no es la restricción: el presupuesto sí.**

### 15.2 Costo de Google Maps

```
elementos Route Matrix / mes ≈ donaciones_con_≥2_candidatos × MAX_CANDIDATOS_MATRIX × 30
                             + rutas × (paradas + 2)²
llamadas Compute Routes / mes ≈ rutas
```

Ejemplo: 200 × 10 × 30 = **60.000 elementos al mes** solo en asignación. Esa cifra debe compararse con el límite gratuito mensual de cada SKU y su precio **vigente** (Google cambió su modelo de facturación en marzo de 2025, referencia [6] del anteproyecto; **verificar antes de fijar parámetros**).

Palancas, sin tocar código:
- bajar `MAX_CANDIDATOS_MATRIX`;
- usar el nivel sin tráfico (más barato) durante las pruebas;
- omitir la llamada con un solo candidato;
- en *benchmarks* masivos, el motor OSRM (§8.2).

Con datos ficticios el volumen real de las pruebas será mucho menor, pero un script de carga mal configurado puede agotar la cuota en una tarde. **Las pruebas de carga del P95 deben medir solo la etapa 1**, que no consume Google.

### 15.3 Modos de falla

| Falla | Efecto | Respuesta del diseño |
|---|---|---|
| Google no responde o no hay cuota | Sin tiempos reales | *Fallback* geodésico (§6.3). La asignación continúa. |
| El proceso de la API se cae o se reinicia | Sin API ni reloj mientras tanto: las ofertas vencidas no avanzan y no salen los push | Railway lo reinicia al fallar `/health`. Al arrancar, las tareas procesan lo que venció entre tanto, porque se basan en marcas de tiempo de la base (§7). Aceptar sigue siendo seguro (valida `expira_at`). |
| Proveedor push caído | Avisos retrasados | Reintentos con espera creciente. La bandeja dentro de la app sigue mostrando la notificación. |
| Móvil sin conexión | Confirmaciones pendientes | Cola local + idempotencia (§8.4) |
| Supabase caído | Todo el sistema | Riesgo aceptado para un prototipo: un solo proveedor de datos. Respaldos diarios de Supabase. |
| Una tarea programada falla repetidamente | Su trabajo se acumula | Alerta si la última ejecución exitosa de una tarea por minuto tiene más de 3 min (§16) |

---

## 16. Observabilidad

Errores con Sentry (`@sentry/nestjs`) y logs estructurados en JSON (`nestjs-pino`), con el id de la petición y del usuario en cada línea. Railway conserva los logs del servicio.

| Señal | Para qué |
|---|---|
| Latencia de `fn_candidatos_donacion` (histograma) | Criterio P95 ≤ 500 ms |
| % de asignaciones con candidato; ofertas por donación; % de donaciones EXPIRADA | Calidad de la asignación |
| Desviación de la ruta frente al óptimo (media y peor caso), tiempo por método | Calidad de ruta |
| Violaciones FEFO detectadas por la prueba de consistencia | Criterio FEFO al 100 % |
| Hora de la última ejecución exitosa de cada tarea; filas procesadas y atrasadas | Salud del reloj |
| Tasa de fallas de Google y del proveedor push | Dependencias externas |
| Elementos de Route Matrix consumidos al día | Presupuesto |

---

## 17. Registro de decisiones

| ADR | Decisión | Alternativa descartada | Costo aceptado |
|---|---|---|---|
| 01 | Monolito modular en NestJS, repositorio propio, proceso persistente en Railway (como el anteproyecto) | Next.js en Vercel (plantilla next-forge de `findfood_api`) | Servidor que operar y pagar; montar de nuevo entorno, Sentry y CI |
| 02 | Migraciones SQL como fuente de verdad + Prisma por introspección | Prisma schema-first | Geografía por SQL crudo; dos herramientas |
| 03 | Reloj dentro del proceso (`@nestjs/schedule`), idempotente con `SKIP LOCKED` | `pg_cron` + endpoint HTTP; lógica en `plpgsql` | Resolución de ~60 s; el proceso debe estar siempre encendido |
| 04 | `notificacion` como bandeja de salida | Supabase Queues (pgmq) | Cola sin prioridades ni DLQ nativas (se resuelven con columnas) |
| 05 | Realtime *broadcast* privado emitido desde la base | `postgres_changes` con RLS fino | Un disparador más; el esquema del mensaje es un contrato |
| 06 | RLS activo sin políticas de cliente + rol `app_backend` | RLS "solo como defensa en profundidad" (v2) | Cada tabla nueva necesita su política (verificado en CI) |
| 07 | Rol interno solo por `app_metadata` | Rol en `user_metadata` (v2) | El alta de asesores depende de la API de administración |
| 08 | Google Routes para la operación, con *fallback* geodésico y N acotado. OSRM en contenedor **solo** para *benchmarks* | OSRM como motor de operación | Costo por uso de Google, vigilado en §16. Mantener el contenedor OSRM para las pruebas. |
| 09 | Posición en vivo por *broadcast* efímero | Tabla de posiciones | Sin historial de recorrido (solo la muestra periódica) |
| 10 | Sin DELETE para `app_backend` salvo tablas desechables | DELETE general | Correcciones por estado, no por borrado |

---

## 18. Qué revisar cuando el sistema crezca

- **Varios bancos.** Hoy un índice único impide más de uno. Para varios bancos habría que quitarlo, añadir `banco_id` donde falte y convertir RLS en aislamiento real por banco (modelo v2, §9.17).
- **Volumen.** Particionar por mes `notificacion`, `auditoria` e `historial_estado` cuando superen algunos millones de filas. Mover los KPI a vistas materializadas.
- **Réplicas y trabajos.** Varias réplicas de la API ya son seguras gracias a `SKIP LOCKED`, pero cada una dispararía las mismas tareas. Si se escala, conviene separar el módulo `tareas` en un proceso *worker* propio (la misma imagen con otro punto de entrada) y, si aparecen trabajos de otra naturaleza, usar Supabase Queues (pgmq).
- **Matching.** Con historial suficiente, aprender los pesos o predecir la aceptación, en la línea de Shi *et al.* [15][16] citados en el anteproyecto. `candidato_asignacion` y `asignacion` ya guardan los datos necesarios.
- **Donantes con varias sedes** (modelo v2, §9.2) y separación sede/cámara (§6.6).

---

## 19. Preguntas abiertas para el equipo

1. **Urgencia:** ¿se adopta la holgura temporal por voluntario (§6.4) y la fórmula de `score_urgencia` (§6.5)? ¿Normalización fija o min–max en proximidad?
2. **Almacén:** ¿una sede puede tener más de un régimen térmico? Si es así, separar `sede` de `almacen` **antes** de cargar datos.
3. **Retención** de documentos de identidad tras la verificación (Ley 1581).
4. **Proveedor push:** Expo Push o FCM directo (modelo v2, §9.21).
5. **Proveedor SMTP** propio antes de pruebas con usuarios reales (modelo v2, §9.22).
6. **Peso en la parada:** ¿total de la parada o por producto? Ambos existen en el modelo (§8.4.2 del modelo v2).
7. **Recepción parcial:** ¿los kilos rechazados generan incidencia, merma o devolución? (§9.13 del modelo v2).

---

## 20. Siguiente paso: Fase 1 en el repositorio del backend

Alineado con las semanas 3–4 del cronograma del anteproyecto:

1. Crear el repositorio NestJS (`nest new`) con la estructura de §5.1: configuración validada, `PrismaService`, filtro problem+json, `ValidationPipe` global, `/health` y Sentry.
2. Mover desde `findfood_api` este documento (`docs/`) y la migración (`supabase/migrations/`). Aplicarla al proyecto de Supabase (creado en la región de §4) y dar contraseña a `app_backend`.
3. `prisma db pull` con `schemas = ["public", "auth"]` y `prisma generate` (§12.1).
4. `AuthGuard` + `RolesGuard` + decoradores, con pruebas e2e por rol (Jest + Supertest).
5. Módulos `identidad` y `donaciones`: registro, `/me`, borrador, publicación y emisión al canal del banco.
6. Llevar el arnés de pruebas del DDL (P1–P7: PostGIS en contenedor con `auth` y Realtime simulados) al CI del nuevo repositorio.
7. Configurar el servicio en Railway: región, variables, *healthcheck* en `/health` y **sin suspensión por inactividad** (§7).
8. Archivar `findfood_api` o dejarlo solo como histórico. Su plantilla Next.js no se usa.
