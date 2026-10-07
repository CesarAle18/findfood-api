import { MotorAsignacionService } from '../src/modulos/asignacion/motor.service';
import { DonacionesService } from '../src/modulos/donaciones/donaciones.service';
import {
  type Cuenta,
  ContextoPruebas,
  ventana,
} from './utilidades/app-de-pruebas';
import {
  type Catalogos,
  catalogos,
  prepararBanco,
} from './utilidades/escenario';

type Voluntario = Cuenta & { voluntarioId: string };

/** Motor de asignación (§6): filtros duros, plazos, cascada e invariantes. */
describe('Asignación', () => {
  // Zona propia, lejos de las otras suites: sus voluntarios no son candidatos aquí.
  const ZONA = { lat: 5.5, lng: -73.5 };
  let ctx: ContextoPruebas;
  let admin: Cuenta;
  let asesor: Cuenta;
  let cat: Catalogos;
  let sedes: { seco: string; refrigerado: string };
  let motor: MotorAsignacionService;
  let donaciones: DonacionesService;

  const cerca = (d: number) => ({ lat: ZONA.lat + d, lng: ZONA.lng + d });

  async function crearDonacion(
    donante: Cuenta,
    opciones: {
      tipo?: string;
      peso?: number;
      horas?: number;
      ubicacion?: { lat: number; lng: number };
    } = {},
  ): Promise<string> {
    const r = await ctx
      .como(donante)
      .post('/v1/donaciones')
      .send({
        ...ventana(opciones.horas ?? 3),
        direccion_recogida: 'Calle 1 # 2-3',
        ubicacion_recogida: opciones.ubicacion ?? ZONA,
        items: [
          {
            tipo_alimento_id: cat.tipo(opciones.tipo ?? 'ARROZ'),
            cantidad: opciones.peso ?? 10,
            peso_estimado_kg: opciones.peso ?? 10,
          },
        ],
      })
      .expect(201);
    return r.body.id;
  }

  async function publicar(donante: Cuenta, id: string) {
    return (
      await ctx.como(donante).post(`/v1/donaciones/${id}/publicar`).expect(200)
    ).body;
  }

  async function ofertaVigente(donacionId: string) {
    const { rows } = await ctx.sql.query<{
      id: string;
      voluntario_id: string;
      estado: string;
    }>(
      `SELECT id, voluntario_id, estado::text FROM asignacion
        WHERE donacion_id = $1 AND estado IN ('OFRECIDA','ACEPTADA')`,
      [donacionId],
    );
    return rows;
  }

  async function apagarVoluntarios() {
    // Aísla cada caso: nadie más de esta suite compite por la donación.
    await ctx.sql.query(
      `UPDATE voluntario v SET disponible = false
         FROM usuario u WHERE u.id = v.usuario_id
          AND ST_DWithin(v.ubicacion_base, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography, 60000)`,
      [ZONA.lat, ZONA.lng],
    );
  }

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
    admin = await ctx.admin();
    asesor = await ctx.asesor();
    cat = await catalogos(ctx, admin);
    sedes = await prepararBanco(ctx, admin, ZONA);
    motor = ctx.app.get(MotorAsignacionService);
    donaciones = ctx.app.get(DonacionesService);
  });

  beforeEach(apagarVoluntarios);

  afterAll(async () => {
    await ctx.cerrar();
  });

  describe('Etapa 1: filtros duros', () => {
    it('cadena de frío: solo un vehículo refrigerado recibe una donación refrigerada', async () => {
      const seco = await ctx.voluntario(admin, cerca(0.001));
      const frio = await ctx.voluntario(admin, cerca(0.02), {
        tiene_refrigeracion: true,
      });
      const donante = await ctx.cuenta();
      const id = await crearDonacion(donante, { tipo: 'LECHE' });
      const d = await publicar(donante, id);
      expect(d.requiere_refrigeracion).toBe(true);
      expect(d.almacen_destino.id).toBe(sedes.refrigerado);
      const [oferta] = await ofertaVigente(id);
      expect(oferta.voluntario_id).toBe(frio.voluntarioId);
      expect(oferta.voluntario_id).not.toBe(seco.voluntarioId);
    });

    it('capacidad: no se ofrece a quien no puede cargar el peso', async () => {
      await ctx.voluntario(admin, cerca(0.001), { capacidad_carga_kg: 5 });
      const donante = await ctx.cuenta();
      const id = await crearDonacion(donante, { peso: 30 });
      const d = await publicar(donante, id);
      expect(d.oferta_en_curso).toBe(false);
    });

    it('conflicto de interés: nadie recibe su propia donación', async () => {
      const voluntario = await ctx.voluntario(admin, cerca(0.001));
      const id = await crearDonacion(voluntario);
      const d = await publicar(voluntario, id);
      expect(d.oferta_en_curso).toBe(false);
    });

    it('horario evaluado en hora de Bogotá: sin franja que se solape no hay oferta', async () => {
      const voluntario = await ctx.voluntario(admin, cerca(0.001));
      const diaLejano =
        (new Date(Date.now() - 5 * 3_600_000).getUTCDay() + 3) % 7;
      await ctx
        .como(voluntario)
        .put('/v1/voluntario/disponibilidad')
        .send({
          franjas: [
            { dia_semana: diaLejano, hora_inicio: '08:00', hora_fin: '12:00' },
          ],
        })
        .expect(200);
      await ctx
        .como(voluntario)
        .patch('/v1/voluntario/estado')
        .send({ disponible: true })
        .expect(200);
      const donante = await ctx.cuenta();
      const id = await crearDonacion(donante);
      expect((await publicar(donante, id)).oferta_en_curso).toBe(false);
    });

    it('sin sede activa del régimen requerido, la publicación se rechaza', async () => {
      const { body: sedesActivas } = await ctx
        .como(asesor)
        .get('/v1/almacenes')
        .expect(200);
      const refrigeradas = sedesActivas.filter(
        (s: { tipo: string; activo: boolean }) =>
          s.tipo === 'REFRIGERADO' && s.activo,
      );
      for (const s of refrigeradas) {
        await ctx
          .como(asesor)
          .patch(`/v1/almacenes/${s.id}`)
          .send({ activo: false })
          .expect(200);
      }
      try {
        const donante = await ctx.cuenta();
        const id = await crearDonacion(donante, { tipo: 'POLLO' });
        const r = await ctx
          .como(donante)
          .post(`/v1/donaciones/${id}/publicar`)
          .expect(409);
        expect(r.body.type).toBe('sin-almacen-disponible');
      } finally {
        for (const s of refrigeradas) {
          await ctx
            .como(asesor)
            .patch(`/v1/almacenes/${s.id}`)
            .send({ activo: true })
            .expect(200);
        }
      }
    });
  });

  describe('Plazos y cascada', () => {
    let v1: Voluntario;
    let v2: Voluntario;
    let donante: Cuenta;

    beforeEach(async () => {
      v1 = await ctx.voluntario(admin, cerca(0.001));
      v2 = await ctx.voluntario(admin, cerca(0.01));
      donante = await ctx.cuenta();
    });

    it('una oferta vencida no se acepta aunque el reloj no haya pasado; el reloj ofrece al siguiente', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      const [oferta] = await ofertaVigente(id);
      expect(oferta.voluntario_id).toBe(v1.voluntarioId);
      await ctx.sql.query(
        `UPDATE asignacion SET expira_at = ofrecida_at + interval '1 second' WHERE id = $1`,
        [oferta.id],
      );
      await new Promise((r) => setTimeout(r, 1100));

      const r = await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/aceptar`)
        .expect(409);
      expect(r.body.type).toBe('oferta-vencida');

      const resultado = await motor.vencerOfertas();
      expect(resultado.vencidas).toBeGreaterThanOrEqual(1);
      const [siguiente] = await ofertaVigente(id);
      expect(siguiente.voluntario_id).toBe(v2.voluntarioId);
    });

    it('al vencer la publicación la donación expira, se avisa al donante y se puede republicar', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      await ctx.sql.query(
        `UPDATE donacion SET publicada_at = now() - interval '31 minutes',
                             expira_publicacion_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );
      await donaciones.expirarPublicacionesVencidas();

      const d = await ctx.como(donante).get(`/v1/donaciones/${id}`).expect(200);
      expect(d.body.estado).toBe('EXPIRADA');
      expect(await ofertaVigente(id)).toEqual([]);
      const aviso = await ctx.sql.query(
        `SELECT 1 FROM notificacion n JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
          WHERE n.donacion_id = $1 AND t.codigo = 'DONACION_EXPIRADA'`,
        [id],
      );
      expect(aviso.rowCount).toBe(1);

      await ctx
        .como(donante)
        .patch(`/v1/donaciones/${id}`)
        .send(ventana(2))
        .expect(200);
      const otra = await publicar(donante, id);
      expect(otra.estado).toBe('PUBLICADA');
      expect(otra.oferta_en_curso).toBe(true);
    });

    it('[invariante] nunca dos ofertas vivas, aunque varios procesos compitan', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      await ctx.sql.query(
        `UPDATE asignacion SET estado = 'EXPIRADA', finalizada_at = now() WHERE donacion_id = $1`,
        [id],
      );
      const ofertas = await Promise.all(
        Array.from({ length: 6 }, () => motor.ofrecerSiguiente(id)),
      );
      expect(ofertas.filter(Boolean)).toHaveLength(1);
      expect(await ofertaVigente(id)).toHaveLength(1);
    });

    it('abandonar con margen republica la donación y la ofrece a otro', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      const [oferta] = await ofertaVigente(id);
      await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/aceptar`)
        .expect(200);
      const r = await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/abandonar`)
        .send({ motivo_id: cat.motivo('ABANDONO_ASIGNACION', 'VEHICULO') })
        .expect(200);
      expect(r.body.donacion_republicada).toBe(true);
      const [siguiente] = await ofertaVigente(id);
      expect(siguiente).toMatchObject({
        estado: 'OFRECIDA',
        voluntario_id: v2.voluntarioId,
      });
    });

    it('abandonar sin margen expira la donación y abre una incidencia', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      const [oferta] = await ofertaVigente(id);
      await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/aceptar`)
        .expect(200);
      await ctx.sql.query(
        `UPDATE donacion SET ventana_recogida_inicio = now() - interval '1 hour',
                             ventana_recogida_fin = now() + interval '5 minutes' WHERE id = $1`,
        [id],
      );
      const sinComentario = await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/abandonar`)
        .send({ motivo_id: cat.motivo('ABANDONO_ASIGNACION', 'IMPREVISTO') })
        .expect(422);
      expect(sinComentario.body.type).toBe('comentario-requerido');

      const r = await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/abandonar`)
        .send({
          motivo_id: cat.motivo('ABANDONO_ASIGNACION', 'IMPREVISTO'),
          observacion: 'Emergencia familiar',
        })
        .expect(200);
      expect(r.body.donacion_republicada).toBe(false);
      const d = await ctx.como(donante).get(`/v1/donaciones/${id}`).expect(200);
      expect(d.body.estado).toBe('EXPIRADA');
      const incidencias = await ctx
        .como(asesor)
        .get(`/v1/incidencias?donacion_id=${id}`)
        .expect(200);
      expect(incidencias.body.datos).toHaveLength(1);
    });

    it('cancelar una donación asignada cierra la asignación y avisa al voluntario', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      const [oferta] = await ofertaVigente(id);
      await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/aceptar`)
        .expect(200);
      await ctx
        .como(donante)
        .post(`/v1/donaciones/${id}/cancelar`)
        .send({
          motivo_id: cat.motivo('CANCELACION_DONACION', 'CAMBIO_DE_PLANES'),
        })
        .expect(200);
      expect(await ofertaVigente(id)).toEqual([]);
      const aviso = await ctx.sql.query(
        `SELECT 1 FROM notificacion n JOIN tipo_notificacion t ON t.id = n.tipo_notificacion_id
          WHERE n.usuario_id = $1 AND t.codigo = 'DONACION_CANCELADA'`,
        [v1.id],
      );
      expect(aviso.rowCount).toBe(1);
      // Otro donante no puede cancelarla ni verla.
      const otro = await ctx.cuenta();
      await ctx.como(otro).get(`/v1/donaciones/${id}`).expect(404);
    });

    it('el personal puede retirar la asignación y reiniciar la cascada', async () => {
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      const [oferta] = await ofertaVigente(id);
      await ctx
        .como(v1)
        .post(`/v1/asignaciones/${oferta.id}/aceptar`)
        .expect(200);
      const r = await ctx
        .como(asesor)
        .post(`/v1/donaciones/${id}/reasignar`)
        .send({})
        .expect(200);
      expect(r.body.estado).toBe('PUBLICADA');
      expect(r.body.oferta_en_curso).toBe(true);
      const [nueva] = await ofertaVigente(id);
      // v1 ya fue intentado en esta publicación: la oferta va a v2.
      expect(nueva.voluntario_id).toBe(v2.voluntarioId);
    });
  });

  describe('Flota del banco', () => {
    it('un asesor recoge con la flota una donación que expiró', async () => {
      const donante = await ctx.cuenta();
      const id = await crearDonacion(donante);
      await publicar(donante, id);
      await ctx.sql.query(
        `UPDATE donacion SET publicada_at = now() - interval '31 minutes',
                             expira_publicacion_at = now() - interval '1 minute' WHERE id = $1`,
        [id],
      );
      await donaciones.expirarPublicacionesVencidas();

      // Desde la sede del banco (a ~100 km) no se alcanza la ventana: la ruta sería infactible.
      const lejos = await ctx
        .como(asesor)
        .post('/v1/rutas')
        .send({ donacion_ids: [id] })
        .expect(422);
      expect(lejos.body.type).toBe('ruta-infactible');
      const ruta = await ctx
        .como(asesor)
        .post('/v1/rutas')
        .send({ donacion_ids: [id], origen: cerca(0.005) })
        .expect(201);
      expect(ruta.body.flota_banco).toBe(true);
      const d = await ctx.como(donante).get(`/v1/donaciones/${id}`).expect(200);
      expect(d.body).toMatchObject({
        estado: 'ASIGNADA',
        modo_recoleccion: 'FLOTA_BANCO',
      });
      expect(d.body.asignacion.flota_banco).toBe(true);
    });
  });

  describe('Parámetros del puntaje', () => {
    it('rechaza pesos que no suman 1 y valores con el tipo equivocado', async () => {
      const r = await ctx
        .como(admin)
        .put('/v1/admin/parametros/PESO_PROXIMIDAD')
        .send({ valor: '0.5' })
        .expect(422);
      expect(r.body.type).toBe('pesos-no-suman-uno');
      await ctx
        .como(admin)
        .put('/v1/admin/parametros/MAX_PARADAS_POR_RUTA')
        .send({ valor: 'cinco' })
        .expect(422);
      const ok = await ctx
        .como(admin)
        .put('/v1/admin/parametros/MAX_PARADAS_POR_RUTA')
        .send({ valor: '5' })
        .expect(200);
      expect(ok.body.valor).toBe('5');
    });

    it('limita las paradas por ruta a 1–5', async () => {
      for (const valor of ['0', '6']) {
        const r = await ctx
          .como(admin)
          .put('/v1/admin/parametros/MAX_PARADAS_POR_RUTA')
          .send({ valor })
          .expect(422);
        expect(r.body.type).toBe('paradas-fuera-de-rango');
      }
    });

    it('solo expone lo que configura el panel web', async () => {
      const lista = await ctx.como(admin).get('/v1/admin/parametros').expect(200);
      expect(
        (lista.body as { clave: string }[]).map((p) => p.clave).sort(),
      ).toEqual([
        'MAX_PARADAS_POR_RUTA',
        'PESO_CONFIABILIDAD',
        'PESO_HOLGURA',
        'PESO_PROXIMIDAD',
        'PESO_URGENCIA',
      ]);
      await ctx
        .como(admin)
        .put('/v1/admin/parametros/ASIGNACION_TIMEOUT_MIN')
        .send({ valor: '10' })
        .expect(404);
    });
  });
});
