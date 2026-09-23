-- ============================================================================
--  SISTEMA DE GESTIÓN ALIMENTARIA PARA BANCO DE ALIMENTOS — DDL v3
--  PostgreSQL 15+ / PostGIS 3.x sobre Supabase
--
--  Esta migración es la FUENTE DE VERDAD del esquema. El cliente de Prisma se
--  genera por introspección (prisma db pull); nunca se migra desde Prisma.
--  Diseño completo y justificación: docs/arquitectura.md
--
--  CAMBIOS RESPECTO A LA v2 (detalle en docs/arquitectura.md §13)
--    1. [CRÍTICO] El rol y la contraseña temporal se leen de raw_app_meta_data
--       (solo escribible con la API de administración), no de
--       raw_user_meta_data (la controla el cliente en signUp). En la v2
--       cualquiera podía registrarse como ADMIN.
--    2. [CRÍTICO] RLS activado en todas las tablas de public, sin políticas
--       para anon/authenticated, y revocados sus privilegios. Supabase expone
--       public por PostgREST a la anon key que viaja en la app. El backend usa
--       el rol app_backend, con una política permisiva propia.
--    3. El alta de un DONANTE crea también su fila en donante.
--    4. fn_candidatos_donacion: filtros duros del motor de asignación con zona
--       horaria explícita y semántica de solapamiento de ventana.
--    5. Parámetros de pesos del puntaje, candidatos a Route Matrix y precisión GPS.
--    6. Columnas de ubicación reciente del voluntario y de precisión GPS /
--       confirmación manual en paradas y evidencias.
--    7. Notificación en tiempo real de cambios de estado de donación por
--       Supabase Realtime (broadcast privado) y políticas de canal.
--    8. Funciones propias sin EXECUTE para PUBLIC/anon/authenticated (PostgREST
--       las expondría como /rpc) y vistas con security_invoker.
--    9. tipo_almacenamiento solo admite SECO y REFRIGERADO (decisión del
--       equipo: el banco no opera almacenamiento congelado).
--
--  CÓMO EJECUTARLA
--    * Con la CLI, desde la raíz del repositorio del backend:  supabase db push
--    * En el SQL Editor: completa, en una sola corrida, sin texto seleccionado.
--    * Después, una sola vez y fuera del control de versiones, dar contraseña
--      al rol del backend:
--         ALTER ROLE app_backend WITH LOGIN PASSWORD '<gestor de secretos>';
--
--  CONVENCIONES DE NOMENCLATURA
--    * Tablas y columnas: snake_case, nombre en singular, sin prefijos.
--    * PK: siempre la columna "id".
--    * FK: "<tabla_referida>_id" (salvo roles semánticos: created_by, revisado_por...).
--    * Constraints: pk_, fk_, uq_, ck_, ix_ + tabla + columna.
--    * Fechas/horas: timestamptz (persistir en UTC, presentar en zona local).
--    * Pesos: numeric(n,2) SIEMPRE en kilogramos.
--    * Geografía: geography(Point,4326) → ST_DWithin/ST_Distance devuelven metros.
--    * Auditoría base: created_at, updated_at (+ created_by/updated_by en tablas
--      con escritura de usuario) y deleted_at donde aplica borrado lógico.
--
--  REGLAS DE OPERACIÓN QUE CONDICIONAN EL MODELO
--    * Existe UN SOLO banco de alimentos, con varias sedes físicas modeladas
--      como almacenes. Cada almacén tiene su propia ubicación y es el destino
--      logístico de donaciones, rutas y recepciones.
--    * El administrador solo da de alta usuarios del banco (rol ASESOR_BANCO),
--      con todos sus datos (teléfono incluido) y sin adjuntar archivos. Recibe
--      por correo una contraseña temporal que debe cambiar en el primer ingreso.
--    * El administrador NO crea donantes ni voluntarios.
--    * El teléfono es obligatorio para operar: una cuenta no llega a ACTIVO sin él.
--    * El registro desde la aplicación móvil siempre nace como DONANTE, persona
--      natural. El rol VOLUNTARIO se solicita después y queda inactivo hasta que
--      el administrador apruebe la verificación documental.
--    * Una donación publicada tiene PUBLICACION_TIMEOUT_MIN (30) minutos para
--      que algún voluntario acepte; cada oferta individual, ASIGNACION_TIMEOUT_MIN
--      (10). La oferta individual nunca vence después que la publicación.
--    * ADMIN y ASESOR_BANCO operan por el panel web; DONANTE y VOLUNTARIO por
--      la aplicación móvil. Los dos mundos son incompatibles en una misma cuenta.
--
--  IDENTIDAD DELEGADA EN SUPABASE AUTH
--    Credenciales, sesiones, refresh tokens y tokens de correo viven en el
--    esquema auth (GoTrue). public.usuario.id ES el mismo uuid de auth.users.id.
--    El esquema auth es de solo lectura para la aplicación: crear o eliminar
--    usuarios se hace por la API de administración de Supabase.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. EXTENSIONES
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS postgis;      -- tipos y funciones geoespaciales
CREATE EXTENSION IF NOT EXISTS citext;       -- email case-insensitive
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS btree_gin;    -- índices compuestos sobre jsonb/enum

-- ---------------------------------------------------------------------------
-- 1. TIPOS ENUMERADOS (máquinas de estado técnicas, controladas por código)
-- ---------------------------------------------------------------------------
-- PENDIENTE_CONFIRMACION: la cuenta existe pero el correo aún no se confirmó
-- (o falta el teléfono). No confundir con estado_verificacion, que es la
-- verificación documental del rol VOLUNTARIO.
CREATE TYPE estado_usuario            AS ENUM ('PENDIENTE_CONFIRMACION','ACTIVO','SUSPENDIDO','INACTIVO');
CREATE TYPE estado_verificacion       AS ENUM ('NO_INICIADA','PENDIENTE','APROBADA','RECHAZADA');
CREATE TYPE plataforma_dispositivo    AS ENUM ('ANDROID','IOS','WEB');

CREATE TYPE estado_donacion           AS ENUM ('BORRADOR','PUBLICADA','ASIGNADA','EN_RECOLECCION','EN_TRANSITO','ENTREGADA','RECIBIDA','RECHAZADA','CANCELADA','EXPIRADA');
CREATE TYPE modo_recoleccion          AS ENUM ('VOLUNTARIO','FLOTA_BANCO');
CREATE TYPE estado_asignacion         AS ENUM ('OFRECIDA','ACEPTADA','RECHAZADA','EXPIRADA','ABANDONADA','COMPLETADA','CANCELADA');
CREATE TYPE estado_ruta               AS ENUM ('PLANIFICADA','EN_CURSO','COMPLETADA','CANCELADA');
CREATE TYPE tipo_parada               AS ENUM ('RECOGIDA','ENTREGA');
CREATE TYPE estado_parada             AS ENUM ('PENDIENTE','EN_SITIO','COMPLETADA','FALLIDA','OMITIDA');
CREATE TYPE tipo_evidencia            AS ENUM ('PUBLICACION','RECOGIDA','ENTREGA','RECEPCION','INCIDENCIA');

CREATE TYPE estado_recepcion          AS ENUM ('PENDIENTE','ACEPTADA','ACEPTADA_PARCIAL','RECHAZADA');
-- Solo dos regímenes térmicos: el banco no opera almacenamiento congelado.
CREATE TYPE tipo_almacenamiento       AS ENUM ('SECO','REFRIGERADO');
CREATE TYPE estado_lote               AS ENUM ('DISPONIBLE','RESERVADO','AGOTADO','VENCIDO','DESCARTADO');
CREATE TYPE tipo_movimiento           AS ENUM ('ENTRADA','SALIDA','AJUSTE','MERMA','VENCIMIENTO','DEVOLUCION');
CREATE TYPE estado_distribucion       AS ENUM ('BORRADOR','CONFIRMADA','ANULADA');

CREATE TYPE estado_incidencia         AS ENUM ('ABIERTA','EN_REVISION','RESUELTA','CERRADA');
CREATE TYPE severidad                 AS ENUM ('BAJA','MEDIA','ALTA','CRITICA');

CREATE TYPE canal_notificacion        AS ENUM ('PUSH','EMAIL','IN_APP');
CREATE TYPE estado_envio              AS ENUM ('PENDIENTE','ENVIADA','FALLIDA','LEIDA');
CREATE TYPE ambito_entidad            AS ENUM ('DONACION','ASIGNACION','RUTA','PARADA','INCIDENCIA','LOTE');
CREATE TYPE ambito_motivo             AS ENUM ('RECHAZO_ASIGNACION','ABANDONO_ASIGNACION','CANCELACION_DONACION','RECHAZO_RECEPCION','RECHAZO_VERIFICACION');

-- ---------------------------------------------------------------------------
-- 2. FUNCIÓN DE AUDITORÍA updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- 3. CATÁLOGOS
-- ===========================================================================

-- ADMIN y ASESOR_BANCO son roles internos (panel web); DONANTE y VOLUNTARIO
-- operan por la aplicación móvil.
CREATE TABLE rol (
    id          smallint     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo      varchar(20)  NOT NULL,
    nombre      varchar(60)  NOT NULL,
    descripcion text,
    activo      boolean      NOT NULL DEFAULT true,
    created_at  timestamptz  NOT NULL DEFAULT now(),
    updated_at  timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_rol_codigo UNIQUE (codigo)
);

CREATE TABLE tipo_vehiculo (
    id                      smallint     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo                  varchar(30)  NOT NULL,
    nombre                  varchar(80)  NOT NULL,
    capacidad_referencia_kg numeric(8,2) NOT NULL,
    permite_refrigeracion   boolean      NOT NULL DEFAULT false,
    activo                  boolean      NOT NULL DEFAULT true,
    created_at              timestamptz  NOT NULL DEFAULT now(),
    updated_at              timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT uq_tipo_vehiculo_codigo UNIQUE (codigo),
    CONSTRAINT ck_tipo_vehiculo_capacidad CHECK (capacidad_referencia_kg > 0)
);

CREATE TABLE unidad_medida (
    id          smallint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo      varchar(10)   NOT NULL,
    nombre      varchar(40)   NOT NULL,
    factor_a_kg numeric(10,4),               -- NULL = no convertible automáticamente
    activo      boolean       NOT NULL DEFAULT true,
    created_at  timestamptz   NOT NULL DEFAULT now(),
    updated_at  timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_unidad_medida_codigo UNIQUE (codigo),
    CONSTRAINT ck_unidad_medida_factor CHECK (factor_a_kg IS NULL OR factor_a_kg > 0)
);

CREATE TABLE categoria_alimento (
    id                     smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo                 varchar(30) NOT NULL,
    nombre                 varchar(80) NOT NULL,
    requiere_refrigeracion boolean     NOT NULL DEFAULT false,
    vida_util_dias_ref     smallint,
    activo                 boolean     NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_categoria_alimento_codigo UNIQUE (codigo),
    CONSTRAINT ck_categoria_vida_util CHECK (vida_util_dias_ref IS NULL OR vida_util_dias_ref > 0)
);

CREATE TABLE tipo_alimento (
    id                     smallint            GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    categoria_alimento_id  smallint            NOT NULL,
    unidad_medida_id       smallint            NOT NULL,
    codigo                 varchar(40)         NOT NULL,
    nombre                 varchar(100)        NOT NULL,
    requiere_refrigeracion boolean             NOT NULL DEFAULT false,
    tipo_almacenamiento    tipo_almacenamiento NOT NULL DEFAULT 'SECO',
    perecedero             boolean             NOT NULL DEFAULT true,
    vida_util_dias         smallint,
    activo                 boolean             NOT NULL DEFAULT true,
    created_at             timestamptz         NOT NULL DEFAULT now(),
    updated_at             timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT uq_tipo_alimento_codigo UNIQUE (codigo),
    CONSTRAINT uq_tipo_alimento_nombre UNIQUE (categoria_alimento_id, nombre),
    CONSTRAINT fk_tipo_alimento_categoria FOREIGN KEY (categoria_alimento_id)
        REFERENCES categoria_alimento (id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT fk_tipo_alimento_unidad FOREIGN KEY (unidad_medida_id)
        REFERENCES unidad_medida (id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX ix_tipo_alimento_categoria ON tipo_alimento (categoria_alimento_id);

CREATE TABLE motivo (
    id         smallint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ambito     ambito_motivo  NOT NULL,
    codigo     varchar(40)    NOT NULL,
    nombre     varchar(120)   NOT NULL,
    requiere_comentario boolean NOT NULL DEFAULT false,
    activo     boolean        NOT NULL DEFAULT true,
    created_at timestamptz    NOT NULL DEFAULT now(),
    updated_at timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT uq_motivo_ambito_codigo UNIQUE (ambito, codigo)
);

CREATE TABLE tipo_incidencia (
    id                  smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo              varchar(40) NOT NULL,
    nombre              varchar(120) NOT NULL,
    severidad_default   severidad   NOT NULL DEFAULT 'MEDIA',
    bloquea_donacion    boolean     NOT NULL DEFAULT false,
    activo              boolean     NOT NULL DEFAULT true,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_tipo_incidencia_codigo UNIQUE (codigo)
);

CREATE TABLE tipo_notificacion (
    id               smallint            GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo           varchar(50)         NOT NULL,
    nombre           varchar(120)        NOT NULL,
    plantilla_titulo text                NOT NULL,
    plantilla_cuerpo text                NOT NULL,
    canal_default    canal_notificacion  NOT NULL DEFAULT 'PUSH',
    activo           boolean             NOT NULL DEFAULT true,
    created_at       timestamptz         NOT NULL DEFAULT now(),
    updated_at       timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT uq_tipo_notificacion_codigo UNIQUE (codigo)
);

CREATE TABLE tipo_destino_distribucion (
    id         smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    codigo     varchar(30) NOT NULL,
    nombre     varchar(80) NOT NULL,
    activo     boolean     NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_tipo_destino_codigo UNIQUE (codigo)
);

-- ===========================================================================
-- 4. IDENTIDAD Y AUTORIZACIÓN
-- ===========================================================================

-- Perfil de negocio de la persona. La identidad vive en auth.users.
CREATE TABLE usuario (
    id                  uuid           PRIMARY KEY,   -- = auth.users.id = claim "sub"
    email               citext         NOT NULL,      -- espejo de auth.users.email
    nombres             varchar(100)   NOT NULL,
    apellidos           varchar(100),
    telefono            varchar(20),
    url_foto            text,
    estado              estado_usuario NOT NULL DEFAULT 'PENDIENTE_CONFIRMACION',
    email_verificado_at timestamptz,                  -- espejo de auth.users.email_confirmed_at
    ultimo_acceso_at    timestamptz,                  -- lo actualiza el AuthGuard de la API
    -- Alta por el administrador: la cuenta no puede usar ningún endpoint salvo
    -- el de cambio de contraseña mientras esta marca siga activa.
    debe_cambiar_password boolean      NOT NULL DEFAULT false,
    idioma              varchar(5)     NOT NULL DEFAULT 'es',
    zona_horaria        varchar(50)    NOT NULL DEFAULT 'America/Bogota',
    acepto_terminos_at  timestamptz,
    created_at          timestamptz    NOT NULL DEFAULT now(),
    updated_at          timestamptz    NOT NULL DEFAULT now(),
    created_by          uuid,
    updated_by          uuid,
    deleted_at          timestamptz,
    CONSTRAINT fk_usuario_auth  FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE,
    CONSTRAINT uq_usuario_email UNIQUE (email),
    -- El teléfono es el único canal de contacto directo entre donante y
    -- voluntario. No se exige al insertar (el registro con Google crea la fila
    -- antes de que la persona complete su perfil), pero sí para llegar a ACTIVO.
    CONSTRAINT ck_usuario_telefono_activo CHECK (estado <> 'ACTIVO' OR telefono IS NOT NULL),
    CONSTRAINT ck_usuario_email_formato CHECK (email ~* '^[^@\s]+@[^@\s]+\.[a-z]{2,}$'),
    CONSTRAINT fk_usuario_created_by FOREIGN KEY (created_by) REFERENCES usuario (id) ON DELETE SET NULL,
    CONSTRAINT fk_usuario_updated_by FOREIGN KEY (updated_by) REFERENCES usuario (id) ON DELETE SET NULL
);
CREATE INDEX ix_usuario_estado  ON usuario (estado) WHERE deleted_at IS NULL;
CREATE INDEX ix_usuario_deleted ON usuario (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE usuario_rol (
    usuario_id   uuid        NOT NULL,
    rol_id       smallint    NOT NULL,
    asignado_at  timestamptz NOT NULL DEFAULT now(),
    asignado_por uuid,
    activo       boolean     NOT NULL DEFAULT true,
    CONSTRAINT pk_usuario_rol PRIMARY KEY (usuario_id, rol_id),
    CONSTRAINT fk_usuario_rol_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE CASCADE,
    CONSTRAINT fk_usuario_rol_rol     FOREIGN KEY (rol_id)     REFERENCES rol (id)     ON DELETE RESTRICT,
    CONSTRAINT fk_usuario_rol_asignado_por FOREIGN KEY (asignado_por) REFERENCES usuario (id) ON DELETE SET NULL
);
CREATE INDEX ix_usuario_rol_rol ON usuario_rol (rol_id);

-- Verificación documental. Aplica ÚNICAMENTE a la solicitud del rol VOLUNTARIO.
-- No se registra el número de documento: solo la imagen que revisa el admin.
-- Las columnas url_* guardan la RUTA del objeto en Storage, no una URL firmada.
CREATE TABLE verificacion_identidad (
    id                   uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id           uuid                NOT NULL,
    url_documento_frente text                NOT NULL,
    url_documento_reverso text,
    url_selfie           text,
    estado               estado_verificacion NOT NULL DEFAULT 'PENDIENTE',
    revisado_por         uuid,
    revisado_at          timestamptz,
    motivo_id            smallint,
    observacion          text,
    created_at           timestamptz         NOT NULL DEFAULT now(),
    updated_at           timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT fk_verificacion_usuario  FOREIGN KEY (usuario_id)   REFERENCES usuario (id) ON DELETE CASCADE,
    CONSTRAINT fk_verificacion_revisor  FOREIGN KEY (revisado_por) REFERENCES usuario (id) ON DELETE SET NULL,
    CONSTRAINT fk_verificacion_motivo   FOREIGN KEY (motivo_id)    REFERENCES motivo (id)  ON DELETE SET NULL,
    CONSTRAINT ck_verificacion_resuelta CHECK ((estado IN ('APROBADA','RECHAZADA')) = (revisado_at IS NOT NULL)),
    CONSTRAINT ck_verificacion_rechazo  CHECK (estado <> 'RECHAZADA' OR motivo_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_verificacion_pendiente
    ON verificacion_identidad (usuario_id) WHERE estado = 'PENDIENTE';
CREATE INDEX ix_verificacion_estado ON verificacion_identidad (estado, created_at);

CREATE TABLE suspension_cuenta (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id     uuid        NOT NULL,
    motivo_id      smallint,
    descripcion    text        NOT NULL,
    suspendido_por uuid        NOT NULL,
    inicio_at      timestamptz NOT NULL DEFAULT now(),
    fin_at         timestamptz,                       -- NULL = indefinida
    levantada_at   timestamptz,
    levantada_por  uuid,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_suspension_usuario   FOREIGN KEY (usuario_id)     REFERENCES usuario (id) ON DELETE CASCADE,
    CONSTRAINT fk_suspension_admin     FOREIGN KEY (suspendido_por) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT fk_suspension_levanta   FOREIGN KEY (levantada_por)  REFERENCES usuario (id) ON DELETE SET NULL,
    CONSTRAINT fk_suspension_motivo    FOREIGN KEY (motivo_id)      REFERENCES motivo (id)  ON DELETE SET NULL,
    CONSTRAINT ck_suspension_fechas    CHECK (fin_at IS NULL OR fin_at > inicio_at),
    CONSTRAINT ck_suspension_levantada CHECK (levantada_at IS NULL OR levantada_at >= inicio_at)
);
CREATE UNIQUE INDEX uq_suspension_activa
    ON suspension_cuenta (usuario_id) WHERE levantada_at IS NULL AND fin_at IS NULL;
-- IMPORTANTE: insertar aquí NO invalida la sesión en Supabase. El caso de uso
-- de suspensión debe cerrar las sesiones con la API de administración; entre
-- tanto, el AuthGuard de la API bloquea el acceso al comprobar usuario.estado.

CREATE TABLE dispositivo_push (
    id            uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id    uuid                   NOT NULL,
    token_push    text                   NOT NULL,
    plataforma    plataforma_dispositivo NOT NULL,
    modelo        varchar(80),
    version_app   varchar(20),
    activo        boolean                NOT NULL DEFAULT true,
    ultimo_uso_at timestamptz,
    created_at    timestamptz            NOT NULL DEFAULT now(),
    updated_at    timestamptz            NOT NULL DEFAULT now(),
    CONSTRAINT uq_dispositivo_token UNIQUE (token_push),
    CONSTRAINT fk_dispositivo_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE CASCADE
);
CREATE INDEX ix_dispositivo_usuario ON dispositivo_push (usuario_id) WHERE activo;

-- ===========================================================================
-- 5. ACTORES DEL DOMINIO
-- ===========================================================================

-- Perfil de donante: siempre PERSONA NATURAL. Nace con el alta desde la app
-- (disparador de la sección 16). Sin dirección fija: el punto de recogida se
-- elige en cada donación. Los donantes NO pasan por verificación documental.
CREATE TABLE donante (
    id                  uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id          uuid                 NOT NULL,
    total_donaciones    integer              NOT NULL DEFAULT 0,
    total_kg_donados    numeric(12,2)        NOT NULL DEFAULT 0,
    calificacion_promedio numeric(3,2),                  -- media de calificacion, 0 a 5
    total_calificaciones  integer            NOT NULL DEFAULT 0,
    activo              boolean              NOT NULL DEFAULT true,
    created_at          timestamptz          NOT NULL DEFAULT now(),
    updated_at          timestamptz          NOT NULL DEFAULT now(),
    deleted_at          timestamptz,
    CONSTRAINT uq_donante_usuario UNIQUE (usuario_id),
    CONSTRAINT fk_donante_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE RESTRICT,
    CONSTRAINT ck_donante_totales CHECK (total_donaciones >= 0 AND total_kg_donados >= 0),
    CONSTRAINT ck_donante_calificacion CHECK (calificacion_promedio IS NULL OR calificacion_promedio BETWEEN 0 AND 5),
    CONSTRAINT ck_donante_total_calif CHECK (total_calificaciones >= 0)
);

-- Perfil de voluntario. Nace cuando un donante solicita el rol. Hasta que el
-- administrador apruebe la verificación, el rol VOLUNTARIO sigue inactivo.
CREATE TABLE voluntario (
    id                    uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id            uuid                  NOT NULL,
    tipo_vehiculo_id      smallint              NOT NULL,
    fecha_nacimiento      date,
    es_grupo              boolean               NOT NULL DEFAULT false,
    organizacion          varchar(150),
    placa_vehiculo        varchar(15)           NOT NULL,
    url_foto_vehiculo     text                  NOT NULL,
    capacidad_carga_kg    numeric(8,2)          NOT NULL,
    capacidad_volumen_m3  numeric(6,2),
    tiene_refrigeracion   boolean               NOT NULL DEFAULT false,
    ubicacion_base        geography(Point,4326),
    -- v3: última posición conocida. El seguimiento en vivo viaja por Realtime
    -- (broadcast, sin persistir); aquí solo se guarda una muestra periódica.
    ultima_ubicacion      geography(Point,4326),
    ultima_ubicacion_at   timestamptz,
    radio_cobertura_km    numeric(5,2)          NOT NULL DEFAULT 10,
    disponible            boolean               NOT NULL DEFAULT false,
    estado_verificacion   estado_verificacion   NOT NULL DEFAULT 'NO_INICIADA',
    verificado_por        uuid,
    verificado_at         timestamptz,
    total_entregas        integer               NOT NULL DEFAULT 0,
    total_kg_transportados numeric(12,2)        NOT NULL DEFAULT 0,
    calificacion_promedio numeric(3,2),
    created_at            timestamptz           NOT NULL DEFAULT now(),
    updated_at            timestamptz           NOT NULL DEFAULT now(),
    deleted_at            timestamptz,
    CONSTRAINT uq_voluntario_usuario   UNIQUE (usuario_id),
    CONSTRAINT uq_voluntario_placa     UNIQUE (placa_vehiculo),
    CONSTRAINT fk_voluntario_usuario   FOREIGN KEY (usuario_id)       REFERENCES usuario (id)        ON DELETE RESTRICT,
    CONSTRAINT fk_voluntario_vehiculo  FOREIGN KEY (tipo_vehiculo_id) REFERENCES tipo_vehiculo (id)  ON DELETE RESTRICT,
    CONSTRAINT fk_voluntario_verificador FOREIGN KEY (verificado_por) REFERENCES usuario (id)        ON DELETE SET NULL,
    CONSTRAINT ck_voluntario_capacidad  CHECK (capacidad_carga_kg > 0),
    CONSTRAINT ck_voluntario_radio      CHECK (radio_cobertura_km > 0 AND radio_cobertura_km <= 100),
    CONSTRAINT ck_voluntario_calificacion CHECK (calificacion_promedio IS NULL OR calificacion_promedio BETWEEN 0 AND 5),
    CONSTRAINT ck_voluntario_grupo      CHECK (NOT es_grupo OR organizacion IS NOT NULL)
);
CREATE INDEX ix_voluntario_ubicacion  ON voluntario USING GIST (ubicacion_base);
CREATE INDEX ix_voluntario_candidato  ON voluntario (disponible, estado_verificacion, capacidad_carga_kg)
    WHERE deleted_at IS NULL;

-- Horario laboral del voluntario, en hora local de Bogotá. Es condición
-- necesaria de su disponibilidad junto con el interruptor voluntario.disponible.
CREATE TABLE voluntario_disponibilidad (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    voluntario_id uuid        NOT NULL,
    dia_semana    smallint    NOT NULL,          -- 0 = domingo ... 6 = sábado (como EXTRACT(DOW))
    hora_inicio   time        NOT NULL,
    hora_fin      time        NOT NULL,
    activo        boolean     NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_disponibilidad_franja UNIQUE (voluntario_id, dia_semana, hora_inicio),
    CONSTRAINT fk_disponibilidad_voluntario FOREIGN KEY (voluntario_id) REFERENCES voluntario (id) ON DELETE CASCADE,
    CONSTRAINT ck_disponibilidad_dia   CHECK (dia_semana BETWEEN 0 AND 6),
    CONSTRAINT ck_disponibilidad_horas CHECK (hora_fin > hora_inicio)
);
CREATE INDEX ix_disponibilidad_voluntario ON voluntario_disponibilidad (voluntario_id, dia_semana) WHERE activo;

CREATE TABLE banco_alimentos (
    id                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre             varchar(150)          NOT NULL,
    documento_fiscal   varchar(30),
    direccion          varchar(255)          NOT NULL,
    ciudad             varchar(80)           NOT NULL,
    ubicacion          geography(Point,4326) NOT NULL,
    telefono           varchar(20),
    email              citext,
    capacidad_total_kg numeric(12,2)         NOT NULL DEFAULT 0,
    radio_operacion_km numeric(6,2),
    tiene_flota_propia boolean               NOT NULL DEFAULT false,
    horario_recepcion  jsonb,
    activo             boolean               NOT NULL DEFAULT true,
    created_at         timestamptz           NOT NULL DEFAULT now(),
    updated_at         timestamptz           NOT NULL DEFAULT now(),
    deleted_at         timestamptz,
    CONSTRAINT uq_banco_nombre    UNIQUE (nombre),
    CONSTRAINT uq_banco_documento UNIQUE (documento_fiscal),
    CONSTRAINT ck_banco_capacidad CHECK (capacidad_total_kg >= 0)
);
CREATE INDEX ix_banco_ubicacion ON banco_alimentos USING GIST (ubicacion);
-- El sistema opera un único banco de alimentos; el motor lo hace cumplir.
CREATE UNIQUE INDEX uq_banco_unico ON banco_alimentos ((true)) WHERE deleted_at IS NULL;

-- Sede física del banco: destino de donaciones, rutas y recepciones. La
-- capacidad se declara por sede y régimen térmico.
CREATE TABLE almacen (
    id              uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    banco_id        uuid                NOT NULL,
    nombre          varchar(80)         NOT NULL,
    direccion       varchar(255)        NOT NULL,
    ciudad          varchar(80)         NOT NULL,
    ubicacion       geography(Point,4326) NOT NULL,
    telefono        varchar(20),
    horario_disponibilidad jsonb        NOT NULL,   -- franjas por día en que la sede recibe
    tipo            tipo_almacenamiento NOT NULL,
    capacidad_kg    numeric(12,2)       NOT NULL,
    temperatura_min numeric(4,1),
    temperatura_max numeric(4,1),
    activo          boolean             NOT NULL DEFAULT true,
    created_at      timestamptz         NOT NULL DEFAULT now(),
    updated_at      timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT uq_almacen_banco_nombre UNIQUE (banco_id, nombre),
    CONSTRAINT fk_almacen_banco FOREIGN KEY (banco_id) REFERENCES banco_alimentos (id) ON DELETE CASCADE,
    CONSTRAINT ck_almacen_capacidad CHECK (capacidad_kg > 0),
    CONSTRAINT ck_almacen_temperatura CHECK (temperatura_min IS NULL OR temperatura_max IS NULL OR temperatura_max >= temperatura_min)
);
CREATE INDEX ix_almacen_ubicacion ON almacen USING GIST (ubicacion);

CREATE TABLE banco_tipo_alimento (
    banco_id         uuid          NOT NULL,
    tipo_alimento_id smallint      NOT NULL,
    acepta           boolean       NOT NULL DEFAULT true,
    capacidad_max_kg numeric(12,2),
    stock_minimo_kg  numeric(12,2),
    created_at       timestamptz   NOT NULL DEFAULT now(),
    updated_at       timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT pk_banco_tipo_alimento PRIMARY KEY (banco_id, tipo_alimento_id),
    CONSTRAINT fk_bta_banco FOREIGN KEY (banco_id)         REFERENCES banco_alimentos (id) ON DELETE CASCADE,
    CONSTRAINT fk_bta_tipo  FOREIGN KEY (tipo_alimento_id) REFERENCES tipo_alimento (id)   ON DELETE RESTRICT,
    CONSTRAINT ck_bta_capacidad CHECK (capacidad_max_kg IS NULL OR capacidad_max_kg > 0)
);

-- ===========================================================================
-- 6. DONACIONES
-- ===========================================================================

CREATE TABLE donacion (
    id                      uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo                  varchar(20)           NOT NULL,
    donante_id              uuid                  NOT NULL,
    almacen_destino_id      uuid,                                        -- sede de entrega, se define al publicar
    estado                  estado_donacion       NOT NULL DEFAULT 'BORRADOR',
    modo_recoleccion        modo_recoleccion      NOT NULL DEFAULT 'VOLUNTARIO',
    titulo                  varchar(120),
    descripcion             text,
    peso_estimado_kg        numeric(10,2)         NOT NULL,
    peso_recogido_kg        numeric(10,2),
    peso_recibido_kg        numeric(10,2),
    requiere_refrigeracion  boolean               NOT NULL DEFAULT false,
    fecha_vencimiento_min   date,                                        -- MIN de donacion_item; lo mantiene la API
    ventana_recogida_inicio timestamptz           NOT NULL,
    ventana_recogida_fin    timestamptz           NOT NULL,
    direccion_recogida      varchar(255)          NOT NULL,
    referencia_recogida     text,
    ubicacion_recogida      geography(Point,4326) NOT NULL,
    -- Contacto alternativo, opcional. Si van nulos se usa el teléfono del donante.
    contacto_nombre         varchar(120),
    contacto_telefono       varchar(20),
    score_urgencia          numeric(6,3),
    publicada_at            timestamptz,
    -- publicada_at + PUBLICACION_TIMEOUT_MIN. Si vence sin aceptación: EXPIRADA.
    expira_publicacion_at   timestamptz,
    asignada_at             timestamptz,
    recogida_at             timestamptz,
    entregada_at            timestamptz,
    recibida_at             timestamptz,
    cancelada_at            timestamptz,
    cancelada_por           uuid,
    motivo_cancelacion_id   smallint,
    observacion_cancelacion text,
    created_at              timestamptz           NOT NULL DEFAULT now(),
    updated_at              timestamptz           NOT NULL DEFAULT now(),
    created_by              uuid                  NOT NULL,
    updated_by              uuid,
    CONSTRAINT uq_donacion_codigo UNIQUE (codigo),
    CONSTRAINT ck_donacion_expira CHECK (expira_publicacion_at IS NULL
                                         OR (publicada_at IS NOT NULL AND expira_publicacion_at > publicada_at)),
    CONSTRAINT fk_donacion_donante FOREIGN KEY (donante_id)       REFERENCES donante (id)         ON DELETE RESTRICT,
    CONSTRAINT fk_donacion_almacen FOREIGN KEY (almacen_destino_id) REFERENCES almacen (id)       ON DELETE RESTRICT,
    CONSTRAINT fk_donacion_cancela FOREIGN KEY (cancelada_por)    REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT fk_donacion_motivo  FOREIGN KEY (motivo_cancelacion_id) REFERENCES motivo (id)     ON DELETE SET NULL,
    CONSTRAINT fk_donacion_created FOREIGN KEY (created_by)       REFERENCES usuario (id)         ON DELETE RESTRICT,
    CONSTRAINT fk_donacion_updated FOREIGN KEY (updated_by)       REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT ck_donacion_peso    CHECK (peso_estimado_kg > 0),
    CONSTRAINT ck_donacion_peso_real CHECK (peso_recogido_kg IS NULL OR peso_recogido_kg >= 0),
    CONSTRAINT ck_donacion_ventana CHECK (ventana_recogida_fin > ventana_recogida_inicio),
    CONSTRAINT ck_donacion_cancelacion CHECK ((estado = 'CANCELADA') = (cancelada_at IS NOT NULL))
);
CREATE INDEX ix_donacion_donante   ON donacion (donante_id, created_at DESC);
CREATE INDEX ix_donacion_estado    ON donacion (estado, ventana_recogida_inicio);
CREATE INDEX ix_donacion_almacen   ON donacion (almacen_destino_id, estado) WHERE almacen_destino_id IS NOT NULL;
CREATE INDEX ix_donacion_expira    ON donacion (expira_publicacion_at) WHERE estado = 'PUBLICADA';
CREATE INDEX ix_donacion_ubicacion ON donacion USING GIST (ubicacion_recogida);
CREATE INDEX ix_donacion_abiertas  ON donacion (score_urgencia DESC, ventana_recogida_fin)
    WHERE estado = 'PUBLICADA';

CREATE TABLE donacion_item (
    id                     uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    donacion_id            uuid          NOT NULL,
    tipo_alimento_id       smallint      NOT NULL,
    unidad_medida_id       smallint      NOT NULL,
    descripcion            varchar(150),
    cantidad               numeric(10,2) NOT NULL,
    peso_estimado_kg       numeric(10,2) NOT NULL,
    peso_real_kg           numeric(10,2),
    fecha_vencimiento      date,
    requiere_refrigeracion boolean       NOT NULL DEFAULT false,
    -- Ruta del objeto en Supabase Storage (no URL firmada: caduca).
    ruta_foto              text,
    observaciones          text,
    created_at             timestamptz   NOT NULL DEFAULT now(),
    updated_at             timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT fk_item_donacion FOREIGN KEY (donacion_id)      REFERENCES donacion (id)      ON DELETE CASCADE,
    CONSTRAINT fk_item_tipo     FOREIGN KEY (tipo_alimento_id) REFERENCES tipo_alimento (id) ON DELETE RESTRICT,
    CONSTRAINT fk_item_unidad   FOREIGN KEY (unidad_medida_id) REFERENCES unidad_medida (id) ON DELETE RESTRICT,
    CONSTRAINT ck_item_cantidad CHECK (cantidad > 0),
    CONSTRAINT ck_item_peso     CHECK (peso_estimado_kg > 0),
    CONSTRAINT ck_item_peso_real CHECK (peso_real_kg IS NULL OR peso_real_kg >= 0)
);
CREATE INDEX ix_item_donacion    ON donacion_item (donacion_id);
CREATE INDEX ix_item_vencimiento ON donacion_item (fecha_vencimiento) WHERE fecha_vencimiento IS NOT NULL;

-- ===========================================================================
-- 7. RUTEO Y EJECUCIÓN
-- ===========================================================================

CREATE TABLE ruta (
    id                     uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo                 varchar(20)            NOT NULL,
    voluntario_id          uuid,                                    -- XOR con banco_ejecutor_id
    banco_ejecutor_id      uuid,
    almacen_destino_id     uuid                   NOT NULL,         -- sede de entrega
    estado                 estado_ruta            NOT NULL DEFAULT 'PLANIFICADA',
    fecha_programada       date                   NOT NULL,
    distancia_total_km     numeric(8,2),
    duracion_estimada_min  integer,
    duracion_real_min      integer,
    peso_total_estimado_kg numeric(10,2),
    geometria              geometry(LineString,4326),
    -- GOOGLE en operación; OSRM solo en benchmarks (docs/arquitectura.md §8.2).
    proveedor_ruteo        varchar(30),
    iniciada_at            timestamptz,
    finalizada_at          timestamptz,
    cancelada_at           timestamptz,
    motivo_cancelacion_id  smallint,
    created_at             timestamptz            NOT NULL DEFAULT now(),
    updated_at             timestamptz            NOT NULL DEFAULT now(),
    CONSTRAINT uq_ruta_codigo UNIQUE (codigo),
    CONSTRAINT fk_ruta_voluntario FOREIGN KEY (voluntario_id)     REFERENCES voluntario (id)      ON DELETE RESTRICT,
    CONSTRAINT fk_ruta_ejecutor   FOREIGN KEY (banco_ejecutor_id) REFERENCES banco_alimentos (id) ON DELETE RESTRICT,
    CONSTRAINT fk_ruta_destino    FOREIGN KEY (almacen_destino_id) REFERENCES almacen (id)        ON DELETE RESTRICT,
    CONSTRAINT fk_ruta_motivo     FOREIGN KEY (motivo_cancelacion_id) REFERENCES motivo (id)      ON DELETE SET NULL,
    CONSTRAINT ck_ruta_ejecutor   CHECK (num_nonnulls(voluntario_id, banco_ejecutor_id) = 1),
    CONSTRAINT ck_ruta_tiempos    CHECK (finalizada_at IS NULL OR iniciada_at IS NULL OR finalizada_at >= iniciada_at),
    CONSTRAINT ck_ruta_proveedor  CHECK (proveedor_ruteo IS NULL OR proveedor_ruteo IN ('GOOGLE','OSRM'))
);
CREATE INDEX ix_ruta_voluntario ON ruta (voluntario_id, fecha_programada DESC);
CREATE INDEX ix_ruta_estado     ON ruta (estado, fecha_programada);

CREATE TABLE parada_ruta (
    id                     uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    ruta_id                uuid                  NOT NULL,
    orden                  smallint              NOT NULL,
    tipo                   tipo_parada           NOT NULL,
    donacion_id            uuid,                                   -- obligatorio si tipo = RECOGIDA
    almacen_id             uuid,                                   -- obligatorio si tipo = ENTREGA
    direccion              varchar(255)          NOT NULL,
    ubicacion              geography(Point,4326) NOT NULL,
    estado                 estado_parada         NOT NULL DEFAULT 'PENDIENTE',
    hora_estimada_llegada  timestamptz,
    hora_real_llegada      timestamptz,
    peso_confirmado_kg     numeric(10,2),
    ubicacion_confirmacion geography(Point,4326),
    -- v3: precisión reportada por el GPS al confirmar, en metros. Si supera
    -- GPS_PRECISION_MIN_M, la app permite confirmar manualmente y lo marca.
    precision_confirmacion_m numeric(7,1),
    confirmacion_manual    boolean               NOT NULL DEFAULT false,
    confirmada_at          timestamptz,
    confirmada_por         uuid,
    observaciones          text,
    created_at             timestamptz           NOT NULL DEFAULT now(),
    updated_at             timestamptz           NOT NULL DEFAULT now(),
    CONSTRAINT uq_parada_orden    UNIQUE (ruta_id, orden),
    CONSTRAINT uq_parada_donacion UNIQUE (ruta_id, donacion_id),
    CONSTRAINT fk_parada_ruta     FOREIGN KEY (ruta_id)        REFERENCES ruta (id)            ON DELETE CASCADE,
    CONSTRAINT fk_parada_donacion FOREIGN KEY (donacion_id)    REFERENCES donacion (id)        ON DELETE RESTRICT,
    CONSTRAINT fk_parada_almacen  FOREIGN KEY (almacen_id)     REFERENCES almacen (id)         ON DELETE RESTRICT,
    CONSTRAINT fk_parada_confirma FOREIGN KEY (confirmada_por) REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT ck_parada_orden    CHECK (orden > 0),
    CONSTRAINT ck_parada_destino  CHECK (
        (tipo = 'RECOGIDA' AND donacion_id IS NOT NULL AND almacen_id IS NULL) OR
        (tipo = 'ENTREGA'  AND almacen_id IS NOT NULL AND donacion_id IS NULL)
    ),
    CONSTRAINT ck_parada_confirmacion CHECK ((estado = 'COMPLETADA') = (confirmada_at IS NOT NULL)),
    CONSTRAINT ck_parada_precision    CHECK (precision_confirmacion_m IS NULL OR precision_confirmacion_m >= 0)
);
CREATE INDEX ix_parada_ruta     ON parada_ruta (ruta_id, orden);
CREATE INDEX ix_parada_donacion ON parada_ruta (donacion_id) WHERE donacion_id IS NOT NULL;

-- ===========================================================================
-- 8. ASIGNACIÓN
-- ===========================================================================

-- Cada fila es UN intento de oferta. Rechazo o vencimiento cierran el intento
-- y el siguiente candidato recibe una fila nueva.
CREATE TABLE asignacion (
    id                  uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
    donacion_id         uuid              NOT NULL,
    voluntario_id       uuid,                                 -- XOR con banco_ejecutor_id
    banco_ejecutor_id   uuid,
    ruta_id             uuid,
    intento             smallint          NOT NULL DEFAULT 1,
    estado              estado_asignacion NOT NULL DEFAULT 'OFRECIDA',
    score               numeric(6,3),
    distancia_km        numeric(7,2),
    ofrecida_at         timestamptz       NOT NULL DEFAULT now(),
    -- min(ofrecida_at + ASIGNACION_TIMEOUT_MIN, donacion.expira_publicacion_at)
    expira_at           timestamptz       NOT NULL,
    respondida_at       timestamptz,
    aceptada_at         timestamptz,
    finalizada_at       timestamptz,
    abandonada_at       timestamptz,
    motivo_id           smallint,
    observacion         text,
    created_at          timestamptz       NOT NULL DEFAULT now(),
    updated_at          timestamptz       NOT NULL DEFAULT now(),
    CONSTRAINT uq_asignacion_intento UNIQUE (donacion_id, intento),
    CONSTRAINT fk_asignacion_donacion   FOREIGN KEY (donacion_id)       REFERENCES donacion (id)        ON DELETE CASCADE,
    CONSTRAINT fk_asignacion_voluntario FOREIGN KEY (voluntario_id)     REFERENCES voluntario (id)      ON DELETE RESTRICT,
    CONSTRAINT fk_asignacion_banco      FOREIGN KEY (banco_ejecutor_id) REFERENCES banco_alimentos (id) ON DELETE RESTRICT,
    CONSTRAINT fk_asignacion_ruta       FOREIGN KEY (ruta_id)           REFERENCES ruta (id)            ON DELETE SET NULL,
    CONSTRAINT fk_asignacion_motivo     FOREIGN KEY (motivo_id)         REFERENCES motivo (id)          ON DELETE SET NULL,
    CONSTRAINT ck_asignacion_ejecutor CHECK (num_nonnulls(voluntario_id, banco_ejecutor_id) = 1),
    CONSTRAINT ck_asignacion_timeout  CHECK (expira_at > ofrecida_at),
    CONSTRAINT ck_asignacion_intento  CHECK (intento > 0),
    CONSTRAINT ck_asignacion_aceptada CHECK (aceptada_at IS NULL OR aceptada_at >= ofrecida_at)
);
-- Invariante central del módulo: nunca dos ofertas vivas para una donación.
CREATE UNIQUE INDEX uq_asignacion_vigente
    ON asignacion (donacion_id) WHERE estado IN ('OFRECIDA','ACEPTADA');
CREATE INDEX ix_asignacion_voluntario ON asignacion (voluntario_id, estado, ofrecida_at DESC);
CREATE INDEX ix_asignacion_expira     ON asignacion (expira_at) WHERE estado = 'OFRECIDA';

-- Resultado del filtrado y del puntaje: explica por qué se ofreció a quien se
-- ofreció. Desechable: se purga a los 30–90 días.
CREATE TABLE candidato_asignacion (
    id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    donacion_id          uuid          NOT NULL,
    voluntario_id        uuid          NOT NULL,
    posicion             smallint      NOT NULL,
    score                numeric(6,3)  NOT NULL,
    distancia_km         numeric(7,2)  NOT NULL,
    cumple_capacidad     boolean       NOT NULL,
    cumple_horario       boolean       NOT NULL,
    cumple_refrigeracion boolean       NOT NULL,
    ofrecido             boolean       NOT NULL DEFAULT false,
    generado_at          timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_candidato UNIQUE (donacion_id, voluntario_id),
    CONSTRAINT fk_candidato_donacion   FOREIGN KEY (donacion_id)   REFERENCES donacion (id)   ON DELETE CASCADE,
    CONSTRAINT fk_candidato_voluntario FOREIGN KEY (voluntario_id) REFERENCES voluntario (id) ON DELETE CASCADE,
    CONSTRAINT ck_candidato_posicion   CHECK (posicion > 0)
);
CREATE INDEX ix_candidato_donacion ON candidato_asignacion (donacion_id, posicion);

-- ===========================================================================
-- 9. RECEPCIÓN E INVENTARIO DEL BANCO
-- ===========================================================================

CREATE TABLE recepcion_donacion (
    id                uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
    donacion_id       uuid             NOT NULL,
    almacen_id        uuid             NOT NULL,   -- sede que recibe
    parada_id         uuid,
    recibida_por      uuid             NOT NULL,
    estado            estado_recepcion NOT NULL DEFAULT 'PENDIENTE',
    peso_recibido_kg  numeric(10,2),
    peso_rechazado_kg numeric(10,2),
    motivo_id         smallint,
    observaciones     text,
    fecha_recepcion   timestamptz      NOT NULL DEFAULT now(),
    created_at        timestamptz      NOT NULL DEFAULT now(),
    updated_at        timestamptz      NOT NULL DEFAULT now(),
    CONSTRAINT uq_recepcion_donacion UNIQUE (donacion_id),
    CONSTRAINT fk_recepcion_donacion FOREIGN KEY (donacion_id)  REFERENCES donacion (id)        ON DELETE RESTRICT,
    CONSTRAINT fk_recepcion_almacen  FOREIGN KEY (almacen_id)   REFERENCES almacen (id)         ON DELETE RESTRICT,
    CONSTRAINT fk_recepcion_parada   FOREIGN KEY (parada_id)    REFERENCES parada_ruta (id)     ON DELETE SET NULL,
    CONSTRAINT fk_recepcion_usuario  FOREIGN KEY (recibida_por) REFERENCES usuario (id)         ON DELETE RESTRICT,
    CONSTRAINT fk_recepcion_motivo   FOREIGN KEY (motivo_id)    REFERENCES motivo (id)          ON DELETE SET NULL,
    CONSTRAINT ck_recepcion_pesos    CHECK (peso_recibido_kg IS NULL OR peso_recibido_kg >= 0),
    CONSTRAINT ck_recepcion_rechazo  CHECK (estado <> 'RECHAZADA' OR motivo_id IS NOT NULL)
);
CREATE INDEX ix_recepcion_almacen ON recepcion_donacion (almacen_id, fecha_recepcion DESC);

CREATE TABLE lote_inventario (
    id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_lote        varchar(30)   NOT NULL,
    banco_id           uuid          NOT NULL,
    almacen_id         uuid          NOT NULL,
    recepcion_id       uuid,
    donacion_item_id   uuid,
    tipo_alimento_id   smallint      NOT NULL,
    unidad_medida_id   smallint      NOT NULL,
    cantidad_inicial   numeric(12,2) NOT NULL,
    cantidad_disponible numeric(12,2) NOT NULL,
    peso_inicial_kg    numeric(12,2) NOT NULL,
    peso_disponible_kg numeric(12,2) NOT NULL,
    fecha_vencimiento  date,
    fecha_ingreso      timestamptz   NOT NULL DEFAULT now(),
    estado             estado_lote   NOT NULL DEFAULT 'DISPONIBLE',
    created_at         timestamptz   NOT NULL DEFAULT now(),
    updated_at         timestamptz   NOT NULL DEFAULT now(),
    created_by         uuid,
    CONSTRAINT uq_lote_codigo UNIQUE (banco_id, codigo_lote),
    CONSTRAINT fk_lote_banco     FOREIGN KEY (banco_id)         REFERENCES banco_alimentos (id)  ON DELETE RESTRICT,
    CONSTRAINT fk_lote_almacen   FOREIGN KEY (almacen_id)       REFERENCES almacen (id)          ON DELETE RESTRICT,
    CONSTRAINT fk_lote_recepcion FOREIGN KEY (recepcion_id)     REFERENCES recepcion_donacion (id) ON DELETE SET NULL,
    CONSTRAINT fk_lote_item      FOREIGN KEY (donacion_item_id) REFERENCES donacion_item (id)    ON DELETE SET NULL,
    CONSTRAINT fk_lote_tipo      FOREIGN KEY (tipo_alimento_id) REFERENCES tipo_alimento (id)    ON DELETE RESTRICT,
    CONSTRAINT fk_lote_unidad    FOREIGN KEY (unidad_medida_id) REFERENCES unidad_medida (id)    ON DELETE RESTRICT,
    CONSTRAINT fk_lote_created   FOREIGN KEY (created_by)       REFERENCES usuario (id)          ON DELETE SET NULL,
    CONSTRAINT ck_lote_cantidades CHECK (cantidad_inicial > 0 AND cantidad_disponible >= 0 AND cantidad_disponible <= cantidad_inicial),
    CONSTRAINT ck_lote_pesos      CHECK (peso_inicial_kg >= 0 AND peso_disponible_kg >= 0 AND peso_disponible_kg <= peso_inicial_kg)
);
-- Índice FEFO: primero en expirar, primero en salir; sin fecha, al final.
CREATE INDEX ix_lote_fefo ON lote_inventario (banco_id, tipo_alimento_id, fecha_vencimiento ASC NULLS LAST)
    WHERE estado = 'DISPONIBLE' AND cantidad_disponible > 0;
CREATE INDEX ix_lote_vencimiento ON lote_inventario (fecha_vencimiento)
    WHERE estado IN ('DISPONIBLE','RESERVADO');
CREATE INDEX ix_lote_almacen ON lote_inventario (almacen_id);

CREATE TABLE distribucion (
    id                       uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo                   varchar(20)         NOT NULL,
    banco_id                 uuid                NOT NULL,
    tipo_destino_id          smallint            NOT NULL,
    nombre_destino           varchar(150)        NOT NULL,
    documento_destino        varchar(30),
    contacto                 varchar(120),
    telefono                 varchar(20),
    numero_beneficiarios     integer,
    fecha_distribucion       timestamptz         NOT NULL DEFAULT now(),
    estado                   estado_distribucion NOT NULL DEFAULT 'BORRADOR',
    responsable_id           uuid                NOT NULL,
    observaciones            text,
    created_at               timestamptz         NOT NULL DEFAULT now(),
    updated_at               timestamptz         NOT NULL DEFAULT now(),
    CONSTRAINT uq_distribucion_codigo UNIQUE (codigo),
    CONSTRAINT fk_distribucion_banco  FOREIGN KEY (banco_id)        REFERENCES banco_alimentos (id)          ON DELETE RESTRICT,
    CONSTRAINT fk_distribucion_tipo   FOREIGN KEY (tipo_destino_id) REFERENCES tipo_destino_distribucion (id) ON DELETE RESTRICT,
    CONSTRAINT fk_distribucion_resp   FOREIGN KEY (responsable_id)  REFERENCES usuario (id)                  ON DELETE RESTRICT,
    CONSTRAINT ck_distribucion_benef  CHECK (numero_beneficiarios IS NULL OR numero_beneficiarios > 0)
);
CREATE INDEX ix_distribucion_banco ON distribucion (banco_id, fecha_distribucion DESC);

CREATE TABLE distribucion_detalle (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    distribucion_id uuid          NOT NULL,
    lote_id         uuid          NOT NULL,
    cantidad        numeric(12,2) NOT NULL,
    peso_kg         numeric(12,2) NOT NULL,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    CONSTRAINT uq_distribucion_detalle UNIQUE (distribucion_id, lote_id),
    CONSTRAINT fk_dd_distribucion FOREIGN KEY (distribucion_id) REFERENCES distribucion (id)    ON DELETE CASCADE,
    CONSTRAINT fk_dd_lote         FOREIGN KEY (lote_id)         REFERENCES lote_inventario (id) ON DELETE RESTRICT,
    CONSTRAINT ck_dd_cantidad     CHECK (cantidad > 0 AND peso_kg >= 0)
);

-- Libro mayor: lote_inventario.cantidad_disponible debe poder reconstruirse
-- exactamente desde aquí. Todo cambio de saldo va en la misma transacción que
-- el movimiento que lo explica.
CREATE TABLE movimiento_inventario (
    id                      bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    lote_id                 uuid            NOT NULL,
    tipo                    tipo_movimiento NOT NULL,
    cantidad                numeric(12,2)   NOT NULL,
    peso_kg                 numeric(12,2),
    saldo_cantidad          numeric(12,2)   NOT NULL,
    distribucion_detalle_id uuid,
    recepcion_id            uuid,
    motivo                  text,
    usuario_id              uuid            NOT NULL,
    created_at              timestamptz     NOT NULL DEFAULT now(),
    CONSTRAINT fk_movimiento_lote      FOREIGN KEY (lote_id)                 REFERENCES lote_inventario (id)      ON DELETE RESTRICT,
    CONSTRAINT fk_movimiento_detalle   FOREIGN KEY (distribucion_detalle_id) REFERENCES distribucion_detalle (id) ON DELETE SET NULL,
    CONSTRAINT fk_movimiento_recepcion FOREIGN KEY (recepcion_id)            REFERENCES recepcion_donacion (id)   ON DELETE SET NULL,
    CONSTRAINT fk_movimiento_usuario   FOREIGN KEY (usuario_id)              REFERENCES usuario (id)              ON DELETE RESTRICT,
    CONSTRAINT ck_movimiento_cantidad  CHECK (cantidad <> 0),
    CONSTRAINT ck_movimiento_saldo     CHECK (saldo_cantidad >= 0)
);
CREATE INDEX ix_movimiento_lote  ON movimiento_inventario (lote_id, created_at DESC);
CREATE INDEX ix_movimiento_fecha ON movimiento_inventario USING BRIN (created_at);

CREATE TABLE alerta_inventario (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    banco_id         uuid        NOT NULL,
    lote_id          uuid,
    tipo             varchar(30) NOT NULL,   -- PROXIMO_VENCIMIENTO | VENCIDO | CAPACIDAD | STOCK_MINIMO
    nivel            severidad   NOT NULL DEFAULT 'MEDIA',
    dias_para_vencer smallint,
    mensaje          text        NOT NULL,
    generada_at      timestamptz NOT NULL DEFAULT now(),
    atendida_at      timestamptz,
    atendida_por     uuid,
    accion_tomada    text,
    CONSTRAINT fk_alerta_banco   FOREIGN KEY (banco_id)     REFERENCES banco_alimentos (id) ON DELETE CASCADE,
    CONSTRAINT fk_alerta_lote    FOREIGN KEY (lote_id)      REFERENCES lote_inventario (id) ON DELETE CASCADE,
    CONSTRAINT fk_alerta_usuario FOREIGN KEY (atendida_por) REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT ck_alerta_tipo    CHECK (tipo IN ('PROXIMO_VENCIMIENTO','VENCIDO','CAPACIDAD','STOCK_MINIMO'))
);
CREATE UNIQUE INDEX uq_alerta_abierta ON alerta_inventario (lote_id, tipo)
    WHERE atendida_at IS NULL AND lote_id IS NOT NULL;
CREATE INDEX ix_alerta_banco ON alerta_inventario (banco_id, generada_at DESC) WHERE atendida_at IS NULL;

-- ===========================================================================
-- 10. INCIDENCIAS
-- ===========================================================================

CREATE TABLE incidencia (
    id                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo             varchar(20)           NOT NULL,
    tipo_incidencia_id smallint              NOT NULL,
    reportada_por      uuid                  NOT NULL,
    donacion_id        uuid,
    asignacion_id      uuid,
    parada_id          uuid,
    recepcion_id       uuid,
    descripcion        text                  NOT NULL,
    nivel              severidad             NOT NULL DEFAULT 'MEDIA',
    estado             estado_incidencia     NOT NULL DEFAULT 'ABIERTA',
    ubicacion          geography(Point,4326),
    asignada_a         uuid,
    resolucion         text,
    resuelta_at        timestamptz,
    resuelta_por       uuid,
    created_at         timestamptz           NOT NULL DEFAULT now(),
    updated_at         timestamptz           NOT NULL DEFAULT now(),
    CONSTRAINT uq_incidencia_codigo UNIQUE (codigo),
    CONSTRAINT fk_incidencia_tipo      FOREIGN KEY (tipo_incidencia_id) REFERENCES tipo_incidencia (id)    ON DELETE RESTRICT,
    CONSTRAINT fk_incidencia_reporta   FOREIGN KEY (reportada_por)      REFERENCES usuario (id)            ON DELETE RESTRICT,
    CONSTRAINT fk_incidencia_donacion  FOREIGN KEY (donacion_id)        REFERENCES donacion (id)           ON DELETE CASCADE,
    CONSTRAINT fk_incidencia_asignacion FOREIGN KEY (asignacion_id)     REFERENCES asignacion (id)         ON DELETE CASCADE,
    CONSTRAINT fk_incidencia_parada    FOREIGN KEY (parada_id)          REFERENCES parada_ruta (id)        ON DELETE CASCADE,
    CONSTRAINT fk_incidencia_recepcion FOREIGN KEY (recepcion_id)       REFERENCES recepcion_donacion (id) ON DELETE CASCADE,
    CONSTRAINT fk_incidencia_asignada  FOREIGN KEY (asignada_a)         REFERENCES usuario (id)            ON DELETE SET NULL,
    CONSTRAINT fk_incidencia_resuelve  FOREIGN KEY (resuelta_por)       REFERENCES usuario (id)            ON DELETE SET NULL,
    CONSTRAINT ck_incidencia_contexto  CHECK (num_nonnulls(donacion_id, asignacion_id, parada_id, recepcion_id) >= 1),
    CONSTRAINT ck_incidencia_resolucion CHECK (estado <> 'RESUELTA' OR (resolucion IS NOT NULL AND resuelta_at IS NOT NULL))
);
CREATE INDEX ix_incidencia_estado   ON incidencia (estado, nivel, created_at DESC);
CREATE INDEX ix_incidencia_donacion ON incidencia (donacion_id) WHERE donacion_id IS NOT NULL;

-- ===========================================================================
-- 11. EVIDENCIA FOTOGRÁFICA (una sola tabla, padre exclusivo por CHECK)
-- ===========================================================================

-- El id lo genera el cliente móvil: al reintentar una subida encolada sin
-- conexión, la API inserta con ON CONFLICT (id) DO NOTHING (idempotencia).
CREATE TABLE evidencia (
    id            uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
    tipo          tipo_evidencia        NOT NULL,
    url           text                  NOT NULL,   -- ruta del objeto en Storage
    donacion_id   uuid,
    parada_id     uuid,
    recepcion_id  uuid,
    incidencia_id uuid,
    capturada_at  timestamptz           NOT NULL DEFAULT now(),   -- reloj del dispositivo
    ubicacion     geography(Point,4326),
    precision_m   numeric(7,1),                                   -- v3: precisión del GPS
    hash_archivo  varchar(64),
    mime_type     varchar(50),
    tamano_bytes  integer,
    subida_por    uuid                  NOT NULL,
    created_at    timestamptz           NOT NULL DEFAULT now(),   -- reloj del servidor
    CONSTRAINT fk_evidencia_donacion   FOREIGN KEY (donacion_id)   REFERENCES donacion (id)           ON DELETE CASCADE,
    CONSTRAINT fk_evidencia_parada     FOREIGN KEY (parada_id)     REFERENCES parada_ruta (id)        ON DELETE CASCADE,
    CONSTRAINT fk_evidencia_recepcion  FOREIGN KEY (recepcion_id)  REFERENCES recepcion_donacion (id) ON DELETE CASCADE,
    CONSTRAINT fk_evidencia_incidencia FOREIGN KEY (incidencia_id) REFERENCES incidencia (id)         ON DELETE CASCADE,
    CONSTRAINT fk_evidencia_usuario    FOREIGN KEY (subida_por)    REFERENCES usuario (id)            ON DELETE RESTRICT,
    CONSTRAINT ck_evidencia_padre CHECK (num_nonnulls(donacion_id, parada_id, recepcion_id, incidencia_id) = 1),
    CONSTRAINT ck_evidencia_tamano CHECK (tamano_bytes IS NULL OR tamano_bytes > 0),
    CONSTRAINT ck_evidencia_precision CHECK (precision_m IS NULL OR precision_m >= 0)
);
CREATE INDEX ix_evidencia_donacion   ON evidencia (donacion_id)   WHERE donacion_id   IS NOT NULL;
CREATE INDEX ix_evidencia_parada     ON evidencia (parada_id)     WHERE parada_id     IS NOT NULL;
CREATE INDEX ix_evidencia_incidencia ON evidencia (incidencia_id) WHERE incidencia_id IS NOT NULL;

-- ===========================================================================
-- 12. TRAZABILIDAD, NOTIFICACIONES Y PARAMETRIZACIÓN
-- ===========================================================================

CREATE TABLE historial_estado (
    id              bigint                GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ambito          ambito_entidad        NOT NULL,
    donacion_id     uuid,
    asignacion_id   uuid,
    ruta_id         uuid,
    parada_id       uuid,
    incidencia_id   uuid,
    lote_id         uuid,
    estado_anterior varchar(40),
    estado_nuevo    varchar(40)           NOT NULL,
    usuario_id      uuid,
    motivo          text,
    metadata        jsonb,
    ubicacion       geography(Point,4326),
    created_at      timestamptz           NOT NULL DEFAULT now(),
    CONSTRAINT fk_historial_donacion   FOREIGN KEY (donacion_id)   REFERENCES donacion (id)        ON DELETE CASCADE,
    CONSTRAINT fk_historial_asignacion FOREIGN KEY (asignacion_id) REFERENCES asignacion (id)      ON DELETE CASCADE,
    CONSTRAINT fk_historial_ruta       FOREIGN KEY (ruta_id)       REFERENCES ruta (id)            ON DELETE CASCADE,
    CONSTRAINT fk_historial_parada     FOREIGN KEY (parada_id)     REFERENCES parada_ruta (id)     ON DELETE CASCADE,
    CONSTRAINT fk_historial_incidencia FOREIGN KEY (incidencia_id) REFERENCES incidencia (id)      ON DELETE CASCADE,
    CONSTRAINT fk_historial_lote       FOREIGN KEY (lote_id)       REFERENCES lote_inventario (id) ON DELETE CASCADE,
    CONSTRAINT fk_historial_usuario    FOREIGN KEY (usuario_id)    REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT ck_historial_padre CHECK (
        num_nonnulls(donacion_id, asignacion_id, ruta_id, parada_id, incidencia_id, lote_id) = 1)
);
CREATE INDEX ix_historial_donacion ON historial_estado (donacion_id, created_at) WHERE donacion_id IS NOT NULL;
CREATE INDEX ix_historial_fecha    ON historial_estado USING BRIN (created_at);

-- Además de la bandeja del usuario, esta tabla es la COLA de envío (outbox):
-- la tarea programada de la API toma las filas PENDIENTE con FOR UPDATE SKIP LOCKED.
CREATE TABLE notificacion (
    id                  uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id          uuid               NOT NULL,
    tipo_notificacion_id smallint          NOT NULL,
    canal               canal_notificacion NOT NULL DEFAULT 'PUSH',
    titulo              varchar(120)       NOT NULL,
    cuerpo              text               NOT NULL,
    data                jsonb,
    donacion_id         uuid,
    asignacion_id       uuid,
    dispositivo_push_id uuid,
    estado_envio        estado_envio       NOT NULL DEFAULT 'PENDIENTE',
    intentos            smallint           NOT NULL DEFAULT 0,
    enviada_at          timestamptz,
    leida_at            timestamptz,
    error               text,
    created_at          timestamptz        NOT NULL DEFAULT now(),
    CONSTRAINT fk_notificacion_usuario    FOREIGN KEY (usuario_id)           REFERENCES usuario (id)           ON DELETE CASCADE,
    CONSTRAINT fk_notificacion_tipo       FOREIGN KEY (tipo_notificacion_id) REFERENCES tipo_notificacion (id) ON DELETE RESTRICT,
    CONSTRAINT fk_notificacion_donacion   FOREIGN KEY (donacion_id)          REFERENCES donacion (id)          ON DELETE CASCADE,
    CONSTRAINT fk_notificacion_asignacion FOREIGN KEY (asignacion_id)        REFERENCES asignacion (id)        ON DELETE CASCADE,
    CONSTRAINT fk_notificacion_dispositivo FOREIGN KEY (dispositivo_push_id) REFERENCES dispositivo_push (id)  ON DELETE SET NULL,
    CONSTRAINT ck_notificacion_intentos CHECK (intentos >= 0)
);
CREATE INDEX ix_notificacion_no_leida ON notificacion (usuario_id, created_at DESC) WHERE leida_at IS NULL;
CREATE INDEX ix_notificacion_pendiente ON notificacion (estado_envio, created_at) WHERE estado_envio = 'PENDIENTE';

-- Calificación mutua tras cada asignación completada (0 a 5, comentario opcional).
CREATE TABLE calificacion (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    asignacion_id uuid        NOT NULL,
    calificador_id uuid       NOT NULL,
    calificado_id uuid        NOT NULL,
    puntaje       smallint    NOT NULL,
    comentario    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_calificacion UNIQUE (asignacion_id, calificador_id, calificado_id),
    CONSTRAINT fk_calificacion_asignacion FOREIGN KEY (asignacion_id)  REFERENCES asignacion (id) ON DELETE CASCADE,
    CONSTRAINT fk_calificacion_emisor     FOREIGN KEY (calificador_id) REFERENCES usuario (id)    ON DELETE CASCADE,
    CONSTRAINT fk_calificacion_receptor   FOREIGN KEY (calificado_id)  REFERENCES usuario (id)    ON DELETE CASCADE,
    CONSTRAINT ck_calificacion_puntaje CHECK (puntaje BETWEEN 0 AND 5),
    CONSTRAINT ck_calificacion_distinto CHECK (calificador_id <> calificado_id)
);
CREATE INDEX ix_calificacion_calificado ON calificacion (calificado_id, created_at DESC);

CREATE TABLE parametro_sistema (
    id          smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    clave       varchar(60) NOT NULL,
    valor       text        NOT NULL,
    tipo_dato   varchar(20) NOT NULL DEFAULT 'STRING',
    descripcion text,
    banco_id    uuid,                                   -- NULL = parámetro global
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid,
    CONSTRAINT fk_parametro_banco   FOREIGN KEY (banco_id)   REFERENCES banco_alimentos (id) ON DELETE CASCADE,
    CONSTRAINT fk_parametro_usuario FOREIGN KEY (updated_by) REFERENCES usuario (id)         ON DELETE SET NULL,
    CONSTRAINT ck_parametro_tipo CHECK (tipo_dato IN ('STRING','INT','DECIMAL','BOOLEAN','JSON'))
);
CREATE UNIQUE INDEX uq_parametro_banco  ON parametro_sistema (clave, banco_id) WHERE banco_id IS NOT NULL;
CREATE UNIQUE INDEX uq_parametro_global ON parametro_sistema (clave)           WHERE banco_id IS NULL;

-- Bitácora genérica, sin FK al registro auditado: sobrevive a su borrado.
CREATE TABLE auditoria (
    id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id         uuid,
    accion             varchar(20) NOT NULL,
    entidad            varchar(60) NOT NULL,
    entidad_id         text,
    valores_anteriores jsonb,
    valores_nuevos     jsonb,
    ip                 inet,
    user_agent         text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fk_auditoria_usuario FOREIGN KEY (usuario_id) REFERENCES usuario (id) ON DELETE SET NULL
);
CREATE INDEX ix_auditoria_entidad ON auditoria (entidad, entidad_id);
CREATE INDEX ix_auditoria_fecha   ON auditoria USING BRIN (created_at);

-- ===========================================================================
-- 13. TRIGGERS updated_at (aplicados a toda tabla que tenga la columna)
-- ===========================================================================
DO $$
DECLARE t record;
BEGIN
    FOR t IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND tb.table_type = 'BASE TABLE'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER tg_%s_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();',
            t.table_name, t.table_name);
    END LOOP;
END $$;

-- ===========================================================================
-- 14. VISTAS DE APOYO (KPIs / impacto)
--     security_invoker: la vista respeta los permisos y RLS de quien consulta,
--     no los de su dueño (sin esto, una vista expuesta saltaría el RLS).
-- ===========================================================================

CREATE OR REPLACE VIEW vw_inventario_fefo WITH (security_invoker = true) AS
SELECT l.banco_id,
       l.almacen_id,
       l.tipo_alimento_id,
       ta.nombre AS tipo_alimento,
       l.id AS lote_id,
       l.codigo_lote,
       l.cantidad_disponible,
       l.peso_disponible_kg,
       l.fecha_vencimiento,
       (l.fecha_vencimiento - CURRENT_DATE) AS dias_restantes
FROM lote_inventario l
JOIN tipo_alimento ta ON ta.id = l.tipo_alimento_id
WHERE l.estado = 'DISPONIBLE' AND l.cantidad_disponible > 0
ORDER BY l.banco_id, l.tipo_alimento_id, l.fecha_vencimiento ASC NULLS LAST, l.fecha_ingreso ASC;

CREATE OR REPLACE VIEW vw_impacto_donante WITH (security_invoker = true) AS
SELECT d.donante_id,
       count(*) FILTER (WHERE d.estado = 'RECIBIDA')            AS donaciones_entregadas,
       coalesce(sum(d.peso_recibido_kg), 0)                     AS kg_entregados,
       count(*) FILTER (WHERE d.estado = 'CANCELADA')           AS donaciones_canceladas,
       min(d.created_at)                                        AS primera_donacion,
       max(d.created_at)                                        AS ultima_donacion
FROM donacion d
GROUP BY d.donante_id;

-- ===========================================================================
-- 15. SEEDS MÍNIMOS DE CATÁLOGOS Y PARÁMETROS
-- ===========================================================================
INSERT INTO rol (codigo, nombre) VALUES
    ('DONANTE','Donante'), ('VOLUNTARIO','Voluntario'),
    ('ASESOR_BANCO','Asesor del banco de alimentos'), ('ADMIN','Administrador');

INSERT INTO tipo_vehiculo (codigo, nombre, capacidad_referencia_kg, permite_refrigeracion) VALUES
    ('MOTO','Motocicleta', 20, false),
    ('AUTOMOVIL','Automóvil', 150, false),
    ('CAMIONETA','Camioneta', 800, false),
    ('FURGON_REFRIGERADO','Furgón refrigerado', 3000, true);

INSERT INTO unidad_medida (codigo, nombre, factor_a_kg) VALUES
    ('KG','Kilogramo', 1), ('UN','Unidad', NULL),
    ('CAJA','Caja', NULL), ('L','Litro', 1), ('BULTO','Bulto', 50);

INSERT INTO categoria_alimento (codigo, nombre, requiere_refrigeracion, vida_util_dias_ref) VALUES
    ('FRUTAS_VERDURAS','Frutas y verduras', false, 7),
    ('LACTEOS','Lácteos', true, 10),
    ('CARNICOS','Cárnicos', true, 5),
    ('PANADERIA','Panadería', false, 3),
    ('NO_PERECEDEROS','No perecederos', false, 365),
    ('PREPARADOS','Alimentos preparados', true, 1);

INSERT INTO tipo_destino_distribucion (codigo, nombre) VALUES
    ('COMEDOR','Comedor comunitario'), ('FUNDACION','Fundación'),
    ('FAMILIA','Familia beneficiaria'), ('OTRO','Otro');

INSERT INTO motivo (ambito, codigo, nombre, requiere_comentario) VALUES
    ('RECHAZO_ASIGNACION','SIN_TIEMPO','No dispongo de tiempo', false),
    ('RECHAZO_ASIGNACION','MUY_LEJOS','El punto está muy lejos', false),
    ('RECHAZO_ASIGNACION','CAPACIDAD','Excede la capacidad de mi vehículo', false),
    ('ABANDONO_ASIGNACION','IMPREVISTO','Imprevisto personal', true),
    ('CANCELACION_DONACION','PRODUCTO_NO_DISPONIBLE','El producto ya no está disponible', false),
    ('RECHAZO_RECEPCION','MAL_ESTADO','Producto en mal estado', true),
    ('RECHAZO_RECEPCION','SIN_CAPACIDAD','Sin capacidad de almacenamiento', false),
    ('RECHAZO_VERIFICACION','DOC_ILEGIBLE','Documento ilegible', false);

INSERT INTO tipo_incidencia (codigo, nombre, severidad_default, bloquea_donacion) VALUES
    ('ALIMENTO_MAL_ESTADO','Alimento en mal estado','ALTA', true),
    ('DONANTE_AUSENTE','Donante no estaba en el punto','MEDIA', true),
    ('DIRECCION_INCORRECTA','Dirección incorrecta','MEDIA', false),
    ('PESO_NO_COINCIDE','Peso no coincide con lo publicado','BAJA', false),
    ('VEHICULO_AVERIA','Avería del vehículo','ALTA', true),
    ('OTRO','Otro','BAJA', false);

INSERT INTO tipo_notificacion (codigo, nombre, plantilla_titulo, plantilla_cuerpo, canal_default) VALUES
    ('ASIGNACION_OFRECIDA','Oferta de recolección','Nueva recolección disponible','Tienes {{minutos}} minutos para responder.','PUSH'),
    ('ASIGNACION_ACEPTADA','Voluntario asignado','Tu donación fue aceptada','{{voluntario}} recogerá tu donación.','PUSH'),
    ('DONACION_RECOGIDA','Donación recogida','Tu donación fue recogida','La donación va en camino al banco.','PUSH'),
    ('DONACION_EN_CAMINO','Donación en camino','Donación en tránsito','Una donación llegará pronto al banco.','PUSH'),
    ('DONACION_ENTREGADA','Donación entregada','Donación entregada','La donación llegó al banco de alimentos.','PUSH'),
    ('DONACION_EXPIRADA','Donación sin voluntario','Tu donación no encontró voluntario','Nadie aceptó a tiempo. Puedes publicarla de nuevo.','PUSH'),
    ('ALERTA_VENCIMIENTO','Alerta de vencimiento','Productos próximos a vencer','{{cantidad}} lotes vencen pronto.','IN_APP');

INSERT INTO parametro_sistema (clave, valor, tipo_dato, descripcion) VALUES
    ('PUBLICACION_TIMEOUT_MIN','30','INT','Minutos desde la publicación para que algún voluntario acepte la donación. Al vencer, la donación pasa a EXPIRADA'),
    ('ASIGNACION_TIMEOUT_MIN','10','INT','Minutos que tiene cada voluntario para responder su oferta dentro de la cascada. Nunca excede el plazo de la publicación'),
    ('RADIO_BUSQUEDA_KM_DEFAULT','10','DECIMAL','Radio inicial de búsqueda de voluntarios'),
    ('RADIO_BUSQUEDA_KM_MAX','25','DECIMAL','Radio máximo tras ampliación progresiva'),
    ('RADIO_BUSQUEDA_KM_PASOS','[10,15,25]','JSON','Radios que prueba el motor, en orden, hasta encontrar candidatos'),
    ('MAX_CANDIDATOS_MATRIX','10','INT','Candidatos más cercanos (distancia geodésica) que pasan a Google Route Matrix. Acota el costo'),
    ('PESO_PROXIMIDAD','0.35','DECIMAL','Peso w1 del puntaje. Los cuatro PESO_* deben sumar 1'),
    ('PESO_URGENCIA','0.25','DECIMAL','Peso w2: holgura temporal del voluntario frente al cierre de la ventana (ver docs/arquitectura.md §6)'),
    ('PESO_CONFIABILIDAD','0.25','DECIMAL','Peso w3: tasa de asignaciones completadas'),
    ('PESO_HOLGURA','0.15','DECIMAL','Peso w4: ajuste entre peso de la donación y capacidad del vehículo'),
    ('GPS_PRECISION_MIN_M','50','DECIMAL','Precisión GPS (metros) por encima de la cual se permite confirmación manual'),
    ('DIAS_ALERTA_VENCIMIENTO','3','INT','Días de anticipación para alerta FEFO'),
    ('MAX_PARADAS_POR_RUTA','5','INT','Máximo de recogidas agrupables en una ruta'),
    ('DISTANCIA_MAX_AGRUPACION_KM','3','DECIMAL','Distancia máxima entre donaciones para agruparlas'),
    ('DIAS_RETENCION_SIN_CONFIRMAR','7','INT','Días tras los cuales se eliminan las cuentas que nunca confirmaron el correo'),
    ('DIAS_RETENCION_CANDIDATOS','60','INT','Días tras los cuales se purga candidato_asignacion');

-- ===========================================================================
-- 16. INTEGRACIÓN CON SUPABASE AUTH
--     Ejecutar como el rol propietario del proyecto (postgres).
--
--     SEGURIDAD — de dónde sale cada dato:
--       raw_user_meta_data  la escribe el CLIENTE en signUp({ options: { data } }).
--                           Solo datos de perfil sin privilegio: nombres,
--                           apellidos, teléfono, aceptación de términos.
--       raw_app_meta_data   solo la escribe la API de administración
--                           (service role). Único origen válido para el rol
--                           interno y la marca de contraseña temporal.
-- ===========================================================================

-- 16.0 Aplica un rol interno (ADMIN / ASESOR_BANCO) declarado en app_metadata.
--      Idempotente: si el rol ya está activo no hace nada, de modo que una
--      actualización posterior de app_metadata no vuelve a encender
--      debe_cambiar_password. Desactiva primero los roles externos para
--      respetar la incompatibilidad de la sección 17.1.
CREATE OR REPLACE FUNCTION fn_aplicar_rol_interno(p_usuario_id uuid, p_app_meta jsonb)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_rol_codigo text := upper(nullif(p_app_meta ->> 'rol', ''));
    v_rol_id     smallint;
BEGIN
    IF v_rol_codigo IS NULL OR v_rol_codigo NOT IN ('ADMIN','ASESOR_BANCO') THEN
        RETURN;
    END IF;

    SELECT id INTO v_rol_id FROM public.rol WHERE codigo = v_rol_codigo AND activo;
    IF v_rol_id IS NULL THEN
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.usuario_rol
                WHERE usuario_id = p_usuario_id AND rol_id = v_rol_id AND activo) THEN
        RETURN;
    END IF;

    UPDATE public.usuario_rol ur
       SET activo = false
      FROM public.rol r
     WHERE r.id = ur.rol_id
       AND r.codigo IN ('DONANTE','VOLUNTARIO')
       AND ur.usuario_id = p_usuario_id
       AND ur.activo;
    UPDATE public.donante SET activo = false WHERE usuario_id = p_usuario_id AND activo;

    INSERT INTO public.usuario_rol (usuario_id, rol_id) VALUES (p_usuario_id, v_rol_id)
    ON CONFLICT (usuario_id, rol_id) DO UPDATE SET activo = true, asignado_at = now();

    IF COALESCE((p_app_meta ->> 'password_temporal')::boolean, false) THEN
        UPDATE public.usuario SET debe_cambiar_password = true WHERE id = p_usuario_id;
    END IF;
END $$;

-- 16.1 Alta: al crearse el usuario en auth.users se crea su perfil de negocio.
--      Todo registro propio (correo o Google) nace DONANTE, con su fila en
--      donante, diga lo que diga user_metadata. Un rol interno solo llega por
--      app_metadata, desde el endpoint de alta del administrador.
CREATE OR REPLACE FUNCTION fn_usuario_desde_auth()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_app_meta   jsonb := COALESCE(NEW.raw_app_meta_data, '{}'::jsonb);
    v_user_meta  jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_interno    boolean := upper(COALESCE(v_app_meta ->> 'rol', '')) IN ('ADMIN','ASESOR_BANCO');
    v_telefono   text := nullif(btrim(v_user_meta ->> 'telefono'), '');
BEGIN
    INSERT INTO public.usuario (id, email, nombres, apellidos, telefono, url_foto,
                                estado, email_verificado_at, acepto_terminos_at)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(nullif(v_user_meta ->> 'nombres', ''),
                 nullif(v_user_meta ->> 'full_name', ''),
                 nullif(v_user_meta ->> 'name', ''),
                 split_part(NEW.email, '@', 1)),
        v_user_meta ->> 'apellidos',
        v_telefono,
        v_user_meta ->> 'avatar_url',
        -- ACTIVO solo con correo confirmado Y teléfono. Con Google el correo
        -- llega confirmado pero sin teléfono: espera al endpoint de perfil.
        CASE WHEN NEW.email_confirmed_at IS NOT NULL AND v_telefono IS NOT NULL
             THEN 'ACTIVO'::estado_usuario
             ELSE 'PENDIENTE_CONFIRMACION'::estado_usuario END,
        NEW.email_confirmed_at,
        CASE WHEN COALESCE((v_user_meta ->> 'acepto_terminos')::boolean, false)
             THEN now() END
    );

    IF v_interno THEN
        PERFORM public.fn_aplicar_rol_interno(NEW.id, v_app_meta);
    ELSE
        INSERT INTO public.usuario_rol (usuario_id, rol_id)
        SELECT NEW.id, id FROM public.rol WHERE codigo = 'DONANTE' AND activo;
        INSERT INTO public.donante (usuario_id) VALUES (NEW.id)
        ON CONFLICT (usuario_id) DO NOTHING;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER tg_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION fn_usuario_desde_auth();

-- 16.2 Rol interno que llega después del INSERT. Según la versión de GoTrue,
--      app_metadata puede escribirse en un UPDATE posterior a la creación; este
--      disparador cubre ese caso con la misma función idempotente.
CREATE OR REPLACE FUNCTION fn_usuario_app_meta_cambiada()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public.fn_aplicar_rol_interno(NEW.id, COALESCE(NEW.raw_app_meta_data, '{}'::jsonb));
    RETURN NEW;
END $$;

CREATE TRIGGER tg_auth_user_app_meta
    AFTER UPDATE OF raw_app_meta_data ON auth.users
    FOR EACH ROW
    WHEN (NEW.raw_app_meta_data ->> 'rol' IS DISTINCT FROM OLD.raw_app_meta_data ->> 'rol')
    EXECUTE FUNCTION fn_usuario_app_meta_cambiada();

-- 16.3 Activación y espejo del correo. auth.users es la fuente de verdad: la
--      aplicación nunca escribe usuario.email ni usuario.email_verificado_at.
--      Respeta SUSPENDIDO e INACTIVO.
CREATE OR REPLACE FUNCTION fn_usuario_sincronizar_auth()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE public.usuario u
       SET email               = NEW.email,
           email_verificado_at = NEW.email_confirmed_at,
           estado              = CASE
                                   WHEN u.estado = 'PENDIENTE_CONFIRMACION'
                                        AND NEW.email_confirmed_at IS NOT NULL
                                        AND u.telefono IS NOT NULL
                                   THEN 'ACTIVO'::estado_usuario
                                   ELSE u.estado
                                 END
     WHERE u.id = NEW.id;
    RETURN NEW;
END $$;

CREATE TRIGGER tg_auth_user_sincronizado
    AFTER UPDATE OF email, email_confirmed_at ON auth.users
    FOR EACH ROW EXECUTE FUNCTION fn_usuario_sincronizar_auth();

-- 16.4 Cambio de contraseña: apaga la marca de contraseña temporal, sea por el
--      cambio obligatorio del primer ingreso o por un restablecimiento.
CREATE OR REPLACE FUNCTION fn_usuario_password_cambiada()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NEW.encrypted_password IS DISTINCT FROM OLD.encrypted_password THEN
        UPDATE public.usuario
           SET debe_cambiar_password = false
         WHERE id = NEW.id
           AND debe_cambiar_password;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tg_auth_user_password_cambiada
    AFTER UPDATE OF encrypted_password ON auth.users
    FOR EACH ROW EXECUTE FUNCTION fn_usuario_password_cambiada();

-- 16.5 Retención: cuentas que nunca confirmaron el correo. Devuelve candidatos;
--      el borrado real lo hace la API con la API de administración de Supabase
--      (un DELETE directo sobre auth.users omite la limpieza de sesiones).
--      SECURITY DEFINER para que app_backend no necesite permisos sobre auth.
CREATE OR REPLACE FUNCTION fn_cuentas_sin_confirmar(p_dias integer DEFAULT 7)
RETURNS TABLE (id uuid, email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT u.id, u.email::text, u.created_at
    FROM auth.users u
    WHERE u.email_confirmed_at IS NULL
      AND u.created_at < now() - make_interval(days => p_dias);
$$;

-- ===========================================================================
-- 17. REGLAS DE ROL
-- ===========================================================================

-- 17.1 Incompatibilidad de roles internos y externos (invariante: ningún
--      camino de escritura, ni siquiera una migración, debe poder violarlo).
CREATE OR REPLACE FUNCTION fn_validar_roles_compatibles()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_codigos text[];
BEGIN
    SELECT array_agg(r.codigo) INTO v_codigos
      FROM public.usuario_rol ur
      JOIN public.rol r ON r.id = ur.rol_id
     WHERE ur.usuario_id = NEW.usuario_id AND ur.activo;

    IF v_codigos && ARRAY['ADMIN','ASESOR_BANCO']
       AND v_codigos && ARRAY['DONANTE','VOLUNTARIO'] THEN
        RAISE EXCEPTION
            'Los roles internos (ADMIN, ASESOR_BANCO) son incompatibles con DONANTE y VOLUNTARIO (usuario %)',
            NEW.usuario_id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER tg_usuario_rol_compatible
    AFTER INSERT OR UPDATE ON usuario_rol
    FOR EACH ROW EXECUTE FUNCTION fn_validar_roles_compatibles();

-- 17.2 Activación del rol de voluntario al aprobarse la verificación. El rol
--      DONANTE nunca se toca: la persona sigue operando durante el proceso.
CREATE OR REPLACE FUNCTION fn_activar_rol_voluntario()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.estado = 'APROBADA' AND COALESCE(OLD.estado, 'PENDIENTE') <> 'APROBADA' THEN
        UPDATE public.usuario_rol ur
           SET activo = true
          FROM public.rol r
         WHERE r.id = ur.rol_id
           AND r.codigo = 'VOLUNTARIO'
           AND ur.usuario_id = NEW.usuario_id;

        UPDATE public.voluntario
           SET estado_verificacion = 'APROBADA',
               verificado_por = NEW.revisado_por,
               verificado_at  = NEW.revisado_at
         WHERE usuario_id = NEW.usuario_id;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER tg_verificacion_aprobada
    AFTER UPDATE OF estado ON verificacion_identidad
    FOR EACH ROW EXECUTE FUNCTION fn_activar_rol_voluntario();

-- ===========================================================================
-- 18. DISPONIBILIDAD Y FILTROS DUROS DEL MOTOR DE ASIGNACIÓN
-- ===========================================================================

-- 18.1 ¿Está disponible AHORA? Interruptor manual Y franja de su horario.
--      Útil para la pantalla del voluntario; el motor usa 18.2, que evalúa
--      la ventana de recogida y no el instante actual.
CREATE OR REPLACE FUNCTION fn_voluntario_disponible(
    p_voluntario_id uuid,
    p_momento       timestamptz DEFAULT now()
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT v.disponible
       AND EXISTS (
            SELECT 1
              FROM public.voluntario_disponibilidad d
             WHERE d.voluntario_id = v.id
               AND d.activo
               AND d.dia_semana  = EXTRACT(DOW FROM (p_momento AT TIME ZONE 'America/Bogota'))
               AND (p_momento AT TIME ZONE 'America/Bogota')::time
                   BETWEEN d.hora_inicio AND d.hora_fin
       )
    FROM public.voluntario v
    WHERE v.id = p_voluntario_id;
$$;

-- 18.2 Etapa 1 del motor de asignación: conjunto factible F(d).
--      Filtros duros: cuenta ACTIVA; rol VOLUNTARIO activo; verificación
--      APROBADA; interruptor encendido; capacidad >= peso estimado;
--      refrigeración si la donación la requiere; dentro del radio de búsqueda
--      Y del radio de cobertura del voluntario; y alguna franja de su horario
--      que SE SOLAPE con la ventana de recogida (anteproyecto §8.2).
--      Corrige dos errores de la consulta de la v2: extraía el día y la hora de
--      un timestamptz sin zona (en una sesión UTC da el día y la hora
--      equivocados) y exigía que la franja contuviera la ventana entera.
--      Se evalúa día a día en hora de Bogotá, así una ventana que cruza la
--      medianoche se compara con las franjas de ambos días.
--      Excluye al propio donante: nadie recoge su propia donación.
--      Objetivo de rendimiento: P95 <= 500 ms (anteproyecto §9.7) — medido
--      sobre ESTA función, antes de la llamada a Google.
CREATE OR REPLACE FUNCTION fn_candidatos_donacion(
    p_donacion_id uuid,
    p_radio_km    numeric
) RETURNS TABLE (
    voluntario_id          uuid,
    usuario_id             uuid,
    distancia_km           numeric,
    capacidad_carga_kg     numeric,
    total_entregas         integer,
    calificacion_promedio  numeric
)
LANGUAGE sql STABLE
AS $$
    WITH d AS (
        SELECT dn.id,
               dn.ubicacion_recogida,
               dn.peso_estimado_kg,
               dn.requiere_refrigeracion,
               (dn.ventana_recogida_inicio AT TIME ZONE 'America/Bogota') AS ini_local,
               (dn.ventana_recogida_fin    AT TIME ZONE 'America/Bogota') AS fin_local,
               don.usuario_id AS donante_usuario_id
          FROM public.donacion dn
          JOIN public.donante  don ON don.id = dn.donante_id
         WHERE dn.id = p_donacion_id
    )
    SELECT v.id,
           v.usuario_id,
           round((ST_Distance(v.ubicacion_base, d.ubicacion_recogida) / 1000)::numeric, 2),
           v.capacidad_carga_kg,
           v.total_entregas,
           v.calificacion_promedio
      FROM d
      JOIN public.voluntario v
        ON v.deleted_at IS NULL
       AND v.disponible
       AND v.estado_verificacion = 'APROBADA'
       AND v.capacidad_carga_kg >= d.peso_estimado_kg
       AND (NOT d.requiere_refrigeracion OR v.tiene_refrigeracion)
       AND v.usuario_id <> d.donante_usuario_id
       AND ST_DWithin(v.ubicacion_base, d.ubicacion_recogida, p_radio_km * 1000)
       AND ST_DWithin(v.ubicacion_base, d.ubicacion_recogida, v.radio_cobertura_km * 1000)
      JOIN public.usuario u
        ON u.id = v.usuario_id
       AND u.estado = 'ACTIVO'
       AND u.deleted_at IS NULL
     WHERE EXISTS (
             SELECT 1
               FROM public.usuario_rol ur
               JOIN public.rol r ON r.id = ur.rol_id
              WHERE ur.usuario_id = v.usuario_id
                AND ur.activo
                AND r.codigo = 'VOLUNTARIO')
       AND EXISTS (
             SELECT 1
               FROM generate_series(d.ini_local::date::timestamp, d.fin_local::date::timestamp, interval '1 day') AS dia
               JOIN public.voluntario_disponibilidad vd
                 ON vd.voluntario_id = v.id
                AND vd.activo
                AND vd.dia_semana = EXTRACT(DOW FROM dia)
              WHERE tsrange(dia::date + vd.hora_inicio, dia::date + vd.hora_fin)
                    && tsrange(d.ini_local, d.fin_local))
     ORDER BY 3;
$$;

-- ===========================================================================
-- 19. TIEMPO REAL (Supabase Realtime, broadcast privado)
--     El panel del banco no lee filas por PostgREST ni usa postgres_changes:
--     recibe un mensaje por cada cambio de estado de una donación en el
--     tópico privado 'banco:donaciones'. La ubicación en vivo del voluntario
--     viaja por el tópico 'ruta:<uuid>' sin tocar la base de datos.
-- ===========================================================================

-- 19.1 Emisión desde la base de datos. SECURITY DEFINER para que app_backend
--      no necesite permisos sobre el esquema realtime.
CREATE OR REPLACE FUNCTION fn_donacion_realtime()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM realtime.send(
        jsonb_build_object(
            'id',                 NEW.id,
            'codigo',             NEW.codigo,
            'estado',             NEW.estado,
            'estado_anterior',    CASE WHEN TG_OP = 'UPDATE' THEN OLD.estado END,
            'almacen_destino_id', NEW.almacen_destino_id,
            'peso_estimado_kg',   NEW.peso_estimado_kg,
            'ventana_recogida_inicio', NEW.ventana_recogida_inicio,
            'ventana_recogida_fin',    NEW.ventana_recogida_fin
        ),
        'donacion_estado',
        'banco:donaciones',
        true
    );
    RETURN NEW;
END $$;

CREATE TRIGGER tg_donacion_realtime_ins
    AFTER INSERT ON donacion
    FOR EACH ROW WHEN (NEW.estado <> 'BORRADOR')
    EXECUTE FUNCTION fn_donacion_realtime();

CREATE TRIGGER tg_donacion_realtime_upd
    AFTER UPDATE OF estado ON donacion
    FOR EACH ROW WHEN (NEW.estado IS DISTINCT FROM OLD.estado)
    EXECUTE FUNCTION fn_donacion_realtime();

-- 19.2 Funciones auxiliares de autorización de canales. Se evalúan con el JWT
--      del cliente conectado a Realtime (auth.uid()). No reciben el uuid como
--      parámetro: así, aunque se invoquen por /rpc, solo informan sobre quien
--      pregunta.
CREATE OR REPLACE FUNCTION fn_rt_es_personal()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.usuario_rol ur
          JOIN public.rol r     ON r.id = ur.rol_id
          JOIN public.usuario u ON u.id = ur.usuario_id
         WHERE ur.usuario_id = auth.uid()
           AND ur.activo
           AND r.codigo IN ('ADMIN','ASESOR_BANCO')
           AND u.estado = 'ACTIVO'
           AND NOT u.debe_cambiar_password);
$$;

CREATE OR REPLACE FUNCTION fn_rt_ruta_id(p_topic text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    IF p_topic ~ '^ruta:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN substr(p_topic, 6)::uuid;
    END IF;
    RETURN NULL;
END $$;

-- El voluntario de la ruta, mientras la ruta no haya terminado.
CREATE OR REPLACE FUNCTION fn_rt_es_voluntario_de_ruta(p_ruta_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.ruta r
          JOIN public.voluntario v ON v.id = r.voluntario_id
         WHERE r.id = p_ruta_id
           AND v.usuario_id = auth.uid()
           AND r.estado IN ('PLANIFICADA','EN_CURSO'));
$$;

-- El donante solo ve la ubicación mientras la ruta está EN_CURSO y su parada
-- aún no se completa (Ley 1581: finalidad y mínimo necesario).
CREATE OR REPLACE FUNCTION fn_rt_es_donante_de_ruta(p_ruta_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.ruta r
          JOIN public.parada_ruta p ON p.ruta_id = r.id
          JOIN public.donacion d    ON d.id = p.donacion_id
          JOIN public.donante dn    ON dn.id = d.donante_id
         WHERE r.id = p_ruta_id
           AND r.estado = 'EN_CURSO'
           AND p.estado IN ('PENDIENTE','EN_SITIO')
           AND dn.usuario_id = auth.uid());
$$;

-- 19.3 Políticas de los canales privados.
DROP POLICY IF EXISTS pol_rt_banco_leer  ON realtime.messages;
DROP POLICY IF EXISTS pol_rt_ruta_leer   ON realtime.messages;
DROP POLICY IF EXISTS pol_rt_ruta_emitir ON realtime.messages;

CREATE POLICY pol_rt_banco_leer ON realtime.messages
    FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast'
           AND realtime.topic() = 'banco:donaciones'
           AND public.fn_rt_es_personal());

CREATE POLICY pol_rt_ruta_leer ON realtime.messages
    FOR SELECT TO authenticated
    USING (realtime.messages.extension = 'broadcast'
           AND public.fn_rt_ruta_id(realtime.topic()) IS NOT NULL
           AND (public.fn_rt_es_personal()
                OR public.fn_rt_es_voluntario_de_ruta(public.fn_rt_ruta_id(realtime.topic()))
                OR public.fn_rt_es_donante_de_ruta(public.fn_rt_ruta_id(realtime.topic()))));

CREATE POLICY pol_rt_ruta_emitir ON realtime.messages
    FOR INSERT TO authenticated
    WITH CHECK (realtime.messages.extension = 'broadcast'
                AND public.fn_rt_es_voluntario_de_ruta(public.fn_rt_ruta_id(realtime.topic())));

-- ===========================================================================
-- 20. ROL DE APLICACIÓN, RLS Y PRIVILEGIOS
--
--     Supabase publica el esquema public por PostgREST y la anon key viaja
--     dentro de la aplicación móvil. Sin esta sección, cualquier persona con
--     la app instalada podría leer y escribir todas las tablas directamente.
--
--     Modelo:
--       * Los clientes (anon, authenticated) no tienen NINGÚN privilegio sobre
--         public; además RLS está activo en todas las tablas y sin políticas
--         para ellos. Doble barrera.
--       * El backend se conecta como app_backend: una política permisiva por
--         tabla, sin DELETE salvo en las tablas desechables.
--       * Las funciones propias no son ejecutables por PUBLIC (PostgREST las
--         expondría como /rpc). Excepción: las auxiliares de Realtime, que
--         necesita el rol authenticated para evaluar las políticas de 19.3.
--
--     La contraseña de app_backend se asigna aparte, fuera del repositorio:
--        ALTER ROLE app_backend WITH LOGIN PASSWORD '<gestor de secretos>';
--     Conexión por Supavisor (modo transacción): usuario app_backend.<ref>.
-- ===========================================================================

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_backend') THEN
        CREATE ROLE app_backend NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_backend;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_backend;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_backend;
-- Sin DELETE: borrado lógico y estados terminales. Excepción: tablas
-- desechables que se purgan por retención o que el usuario da de baja.
GRANT DELETE ON candidato_asignacion, notificacion, dispositivo_push TO app_backend;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

-- Migraciones futuras creadas por este mismo rol no vuelven a conceder nada a
-- los clientes; cada migración nueva debe igualmente activar RLS (ver doc).
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app_backend;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_backend;

-- RLS en todas las tablas propias + política permisiva para app_backend.
-- Se excluyen las tablas que pertenecen a extensiones (spatial_ref_sys).
DO $$
DECLARE t record;
BEGIN
    FOR t IN
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT EXISTS (SELECT 1 FROM pg_depend dep
                            WHERE dep.objid = c.oid AND dep.deptype = 'e')
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
        EXECUTE format('DROP POLICY IF EXISTS pol_app_backend ON public.%I', t.relname);
        EXECUTE format(
            'CREATE POLICY pol_app_backend ON public.%I TO app_backend USING (true) WITH CHECK (true)',
            t.relname);
    END LOOP;
END $$;

-- Funciones propias: nadie las ejecuta por defecto; el backend sí.
DO $$
DECLARE f record;
BEGIN
    FOR f IN
        SELECT p.oid::regprocedure AS firma
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname LIKE 'fn\_%'
           AND NOT EXISTS (SELECT 1 FROM pg_depend dep
                            WHERE dep.objid = p.oid AND dep.deptype = 'e')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.firma);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO app_backend', f.firma);
    END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION fn_rt_es_personal()               TO authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_ruta_id(text)               TO authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_es_voluntario_de_ruta(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fn_rt_es_donante_de_ruta(uuid)    TO authenticated;

-- FIN DEL DDL v3
