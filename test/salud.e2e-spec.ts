import { ContextoPruebas } from './utilidades/app-de-pruebas';

describe('Operación', () => {
  let ctx: ContextoPruebas;

  beforeAll(async () => {
    ctx = await ContextoPruebas.crear();
  });

  afterAll(async () => {
    await ctx.cerrar();
  });

  it('GET /health es público y comprueba la base de datos', async () => {
    const r = await ctx.http.get('/health').expect(200);
    expect(r.body.info.base_datos.status).toBe('up');
  });

  it('una ruta inexistente responde 404 en problem+json', async () => {
    const r = await ctx.http.get('/v1/health').expect(404);
    expect(r.headers['content-type']).toContain('application/problem+json');
    expect(r.body).toMatchObject({
      type: 'no-encontrado',
      status: 404,
      instance: '/v1/health',
    });
  });
});
