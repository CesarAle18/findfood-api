#!/usr/bin/env bash
# Base de datos local para desarrollo y pruebas e2e: PostgreSQL 16 + PostGIS 3.4
# en un contenedor, con auth y realtime simulados (db/local/simulacion_supabase.sql)
# y todas las migraciones de supabase/migrations/ aplicadas sin modificar.
#
# Crea dos bases: findfood (desarrollo) y findfood_test (pruebas e2e).
#
#   scripts/db-local.sh subir       crea el contenedor y aplica las migraciones
#   scripts/db-local.sh bajar       elimina el contenedor
#   scripts/db-local.sh reiniciar   bajar + subir
#   scripts/db-local.sh psql [db]   consola SQL como postgres
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTENEDOR="${FINDFOOD_DB_CONTENEDOR:-findfood-db}"
PUERTO="${FINDFOOD_DB_PUERTO:-54329}"
IMAGEN="${FINDFOOD_DB_IMAGEN:-docker.io/postgis/postgis:16-3.4}"
PASSWORD_APP="${FINDFOOD_DB_PASSWORD_APP:-app_backend_local}"
MOTOR="$(command -v podman || command -v docker || true)"

if [[ -z "$MOTOR" ]]; then
    echo "Se necesita podman o docker." >&2
    exit 1
fi

psql_en() {
    local db="$1"
    shift
    "$MOTOR" exec -i -e PGOPTIONS="-c client_min_messages=warning" "$CONTENEDOR" psql -q -v ON_ERROR_STOP=1 -U postgres -d "$db" "$@"
}

preparar_base() {
    local db="$1"
    echo "→ Base $db"
    psql_en postgres -c "DROP DATABASE IF EXISTS $db" >/dev/null
    psql_en postgres -c "CREATE DATABASE $db" >/dev/null
    psql_en "$db" --single-transaction < "$RAIZ/db/local/simulacion_supabase.sql" >/dev/null
    for migracion in "$RAIZ"/supabase/migrations/*.sql; do
        echo "  aplicando $(basename "$migracion")"
        psql_en "$db" --single-transaction < "$migracion" >/dev/null
    done
}

subir() {
    if ! "$MOTOR" container exists "$CONTENEDOR" 2>/dev/null \
        && ! "$MOTOR" inspect "$CONTENEDOR" >/dev/null 2>&1; then
        "$MOTOR" run -d --name "$CONTENEDOR" \
            -e POSTGRES_PASSWORD=postgres \
            -e TZ=UTC -e PGTZ=UTC \
            -p "127.0.0.1:${PUERTO}:5432" \
            "$IMAGEN" >/dev/null
    else
        "$MOTOR" start "$CONTENEDOR" >/dev/null
    fi

    # La imagen arranca un servidor temporal para inicializar PostGIS y luego lo
    # reinicia: hay que esperar al mensaje de fin de inicialización.
    echo -n "Esperando a PostgreSQL"
    for _ in $(seq 1 90); do
        if "$MOTOR" logs "$CONTENEDOR" 2>&1 \
                | grep -qE 'PostgreSQL init process complete|Skipping initialization' \
            && "$MOTOR" exec "$CONTENEDOR" pg_isready -U postgres -q 2>/dev/null \
            && psql_en postgres -c 'SELECT 1' >/dev/null 2>&1; then
            echo " listo"
            break
        fi
        echo -n "."
        sleep 1
    done

    preparar_base findfood
    preparar_base findfood_test
    # El rol es de todo el clúster: basta con darle contraseña una vez.
    psql_en postgres -c "ALTER ROLE app_backend WITH LOGIN PASSWORD '${PASSWORD_APP}'" >/dev/null

    cat <<EOF

Base local lista en 127.0.0.1:${PUERTO}
  API (app_backend): postgresql://app_backend:${PASSWORD_APP}@127.0.0.1:${PUERTO}/findfood
  Introspección:     postgresql://postgres:postgres@127.0.0.1:${PUERTO}/findfood
  Pruebas e2e:       postgresql://app_backend:${PASSWORD_APP}@127.0.0.1:${PUERTO}/findfood_test
EOF
}

bajar() {
    "$MOTOR" rm -f "$CONTENEDOR" >/dev/null 2>&1 || true
    echo "Contenedor $CONTENEDOR eliminado."
}

case "${1:-subir}" in
    subir) subir ;;
    bajar) bajar ;;
    reiniciar) bajar; subir ;;
    psql) shift; "$MOTOR" exec -it "$CONTENEDOR" psql -U postgres -d "${1:-findfood}" ;;
    *) echo "Uso: $0 {subir|bajar|reiniciar|psql [db]}" >&2; exit 1 ;;
esac
