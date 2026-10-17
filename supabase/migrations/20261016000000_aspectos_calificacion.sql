-- ============================================================================
--  ASPECTOS DE CALIFICACIÓN (F-12)
--
--  La pantalla de calificación de la app móvil pide, además del puntaje y el
--  comentario, marcar aspectos (puntualidad, amabilidad, cuidado, ...). Los
--  aspectos son un catálogo por rol calificado: el donante califica al
--  VOLUNTARIO y el voluntario al DONANTE (por ahora sin aspectos propios).
--
--  - aspecto_calificacion: catálogo administrable (activo / inactivo).
--  - calificacion_aspecto: aspectos marcados en cada calificación. Se borran
--    con la calificación (ON DELETE CASCADE).
--
--  Tablas nuevas: RLS + pol_app_backend (§13.1). Los privilegios de
--  app_backend llegan por ALTER DEFAULT PRIVILEGES del esquema inicial; se
--  conceden también de forma explícita para no depender del rol que migra.
-- ============================================================================

CREATE TABLE aspecto_calificacion (
    id             smallint    GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rol_calificado varchar(20) NOT NULL,
    codigo         varchar(40) NOT NULL,
    nombre         varchar(80) NOT NULL,
    activo         boolean     NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_aspecto_calificacion_rol_codigo UNIQUE (rol_calificado, codigo),
    CONSTRAINT ck_aspecto_calificacion_rol CHECK (rol_calificado IN ('DONANTE','VOLUNTARIO'))
);

CREATE TRIGGER tg_aspecto_calificacion_updated_at BEFORE UPDATE ON aspecto_calificacion
    FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

CREATE TABLE calificacion_aspecto (
    calificacion_id uuid     NOT NULL,
    aspecto_id      smallint NOT NULL,
    CONSTRAINT pk_calificacion_aspecto PRIMARY KEY (calificacion_id, aspecto_id),
    CONSTRAINT fk_calificacion_aspecto_calificacion FOREIGN KEY (calificacion_id) REFERENCES calificacion (id)         ON DELETE CASCADE,
    CONSTRAINT fk_calificacion_aspecto_aspecto      FOREIGN KEY (aspecto_id)      REFERENCES aspecto_calificacion (id) ON DELETE RESTRICT
);
CREATE INDEX ix_calificacion_aspecto_aspecto ON calificacion_aspecto (aspecto_id);

ALTER TABLE aspecto_calificacion ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_app_backend ON aspecto_calificacion TO app_backend USING (true) WITH CHECK (true);
ALTER TABLE calificacion_aspecto ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_app_backend ON calificacion_aspecto TO app_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON aspecto_calificacion, calificacion_aspecto TO app_backend;
REVOKE ALL ON aspecto_calificacion, calificacion_aspecto FROM anon, authenticated;

INSERT INTO aspecto_calificacion (rol_calificado, codigo, nombre) VALUES
    ('VOLUNTARIO', 'PUNTUALIDAD', 'Puntualidad'),
    ('VOLUNTARIO', 'AMABILIDAD', 'Amabilidad'),
    ('VOLUNTARIO', 'CUIDADO', 'Cuidado de los alimentos'),
    ('VOLUNTARIO', 'COMUNICACION', 'Comunicación'),
    ('VOLUNTARIO', 'PRESENTACION', 'Presentación')
ON CONFLICT (rol_calificado, codigo) DO NOTHING;
