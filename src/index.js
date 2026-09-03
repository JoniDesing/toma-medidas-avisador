import { buildPushPayload } from '@block65/webcrypto-web-push';

// ── Toma de Medidas MARMOLCOR — avisador diario ─────────────────
// Corre todos los días a la mañana (ver wrangler.toml) y manda una
// notificación push si hay:
//   1) Visitas agendadas para HOY
//   2) Pedidos pendientes (sin agendar) hace más de 2 días
//
// No manda dos veces el mismo tipo de aviso el mismo día (usa la
// tabla push_log en Supabase como "ya avisé esto hoy").

const SUPABASE_URL = 'https://ddvrhrmcswmtovawsjig.supabase.co';

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_KEY,
    Authorization: 'Bearer ' + env.SUPABASE_KEY,
    'Content-Type': 'application/json',
  };
}

function hoyArgentina() {
  // Argentina es UTC-3 todo el año (sin horario de verano)
  const ahora = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return ahora.toISOString().slice(0, 10);
}

async function sbFetch(env, path, options) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...sbHeaders(env), ...(options?.headers || {}) },
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} en ${path}: ${texto}`);
  }
  return res;
}

async function yaAvisadoHoy(env, tipo, fecha) {
  const res = await sbFetch(env, `push_log?fecha=eq.${fecha}&tipo=eq.${tipo}&select=id`);
  const rows = await res.json();
  return rows.length > 0;
}

async function marcarAvisadoHoy(env, tipo, fecha) {
  await sbFetch(env, `push_log`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ fecha, tipo }),
  });
}

async function obtenerSuscripciones(env) {
  const res = await sbFetch(env, `push_subscriptions?select=*`);
  return res.json();
}

async function eliminarSuscripcion(env, endpoint) {
  await sbFetch(env, `push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' });
}

async function enviarATodos(env, payload) {
  const subs = await obtenerSuscripciones(env);
  const vapid = {
    subject: 'mailto:contacto@marmolcor.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  const resultados = [];
  await Promise.all(
    subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        const message = await buildPushPayload({ data: JSON.stringify(payload) }, subscription, vapid);
        const res = await fetch(subscription.endpoint, message);
        resultados.push({ endpoint: s.endpoint.slice(-12), status: res.status });
        if (res.status === 404 || res.status === 410) {
          await eliminarSuscripcion(env, s.endpoint); // suscripción vencida, la limpiamos
        }
      } catch (e) {
        resultados.push({ endpoint: s.endpoint.slice(-12), error: String(e) });
      }
    })
  );
  return resultados;
}

async function revisarYAvisar(env, forzar) {
  const fecha = hoyArgentina();
  const log = { fecha, agendados_hoy: null, pendientes_atrasados: null };

  // 1) Visitas agendadas para hoy
  if (forzar || !(await yaAvisadoHoy(env, 'agendados_hoy', fecha))) {
    const res = await sbFetch(env, `tomas_medidas?estado=eq.agendado&fecha_agendada=eq.${fecha}&eliminado=eq.false&select=cliente_nombre,cliente_apellido`);
    const rows = await res.json();
    log.agendados_hoy = { encontrados: rows.length };
    if (rows.length) {
      const nombres = rows.map((r) => `${r.cliente_nombre || ''} ${r.cliente_apellido || ''}`.trim()).join(', ');
      log.agendados_hoy.envio = await enviarATodos(env, {
        title: '🎾 Hay cosas que hacer hoy, NADA DE PADEL!',
        body: rows.length === 1 ? `Hoy tenés que tomar medidas en lo de ${nombres}` : `Hoy tenés ${rows.length} visitas agendadas: ${nombres}`,
        url: './',
      });
    }
    if (!forzar) await marcarAvisadoHoy(env, 'agendados_hoy', fecha);
  } else {
    log.agendados_hoy = { yaAvisado: true };
  }

  // 2) Pedidos pendientes (sin agendar) hace más de 2 días
  if (forzar || !(await yaAvisadoHoy(env, 'pendientes_atrasados', fecha))) {
    const limite = new Date(Date.now() - 3 * 60 * 60 * 1000 - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await sbFetch(env, `tomas_medidas?estado=eq.pendiente&fecha_pedido=lte.${limite}&eliminado=eq.false&select=cliente_nombre`);
    const rows = await res.json();
    log.pendientes_atrasados = { encontrados: rows.length };
    if (rows.length) {
      log.pendientes_atrasados.envio = await enviarATodos(env, {
        title: '¿ANDÁS SIN GANAS DE LABURAR?',
        body: 'SOLTÁ EL PADEL, TENÉS MEDIDAS PENDIENTES DE TOMAR',
        url: './',
      });
    }
    if (!forzar) await marcarAvisadoHoy(env, 'pendientes_atrasados', fecha);
  } else {
    log.pendientes_atrasados = { yaAvisado: true };
  }

  return log;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisarYAvisar(env, false));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // Permite forzar una revisión manual visitando la URL del worker (útil para probar).
    // ?forzar=1 ignora si ya se avisó hoy y reenvía igual (solo para pruebas).
    if (url.pathname === '/revisar-ahora') {
      try {
        const forzar = url.searchParams.get('forzar') === '1';
        const resultado = await revisarYAvisar(env, forzar);
        return new Response(JSON.stringify(resultado, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response('ERROR: ' + String(e), { status: 500 });
      }
    }

    // Diagnóstico: confirma que las claves están cargadas y que se puede hablar con Supabase,
    // sin mandar ninguna notificación.
    if (url.pathname === '/diagnostico') {
      const claves = {
        SUPABASE_KEY: !!env.SUPABASE_KEY,
        VAPID_PUBLIC_KEY: !!env.VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY: !!env.VAPID_PRIVATE_KEY,
        NOTIF_TOKEN: !!env.NOTIF_TOKEN,
      };
      let supabaseOk = false;
      let suscripciones = null;
      let error = null;
      try {
        const res = await sbFetch(env, 'push_subscriptions?select=id');
        const rows = await res.json();
        supabaseOk = true;
        suscripciones = rows.length;
      } catch (e) {
        error = String(e);
      }
      return new Response(JSON.stringify({ claves, supabaseOk, suscripciones, error }, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // La app llama a esto apenas se guarda un pedido nuevo, para avisar al instante
    // (no espera al chequeo diario). Requiere el token compartido para evitar spam.
    if (url.pathname === '/aviso-nuevo-pedido' && request.method === 'POST') {
      if (request.headers.get('x-app-token') !== env.NOTIF_TOKEN) {
        return new Response('No autorizado', { status: 401 });
      }
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const nombre = (body.nombre || 'un cliente').trim() || 'un cliente';
      try {
        const envio = await enviarATodos(env, {
          title: '👑 Tenés laburo Rey',
          body: `Se cargó un pedido de medidas para ${nombre}`,
          url: './',
        });
        return new Response(JSON.stringify({ ok: true, envio }), { headers: { 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response('ERROR: ' + String(e), { status: 500 });
      }
    }

    return new Response('Toma de Medidas — avisador. Este worker corre solo, no hace falta visitarlo.');
  },
};
