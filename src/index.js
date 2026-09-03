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

async function yaAvisadoHoy(env, tipo, fecha) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/push_log?fecha=eq.${fecha}&tipo=eq.${tipo}&select=id`,
    { headers: sbHeaders(env) }
  );
  const rows = await res.json();
  return rows.length > 0;
}

async function marcarAvisadoHoy(env, tipo, fecha) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_log`, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ fecha, tipo }),
  });
}

async function obtenerSuscripciones(env) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?select=*`, {
    headers: sbHeaders(env),
  });
  return res.json();
}

async function eliminarSuscripcion(env, endpoint) {
  await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: 'DELETE',
    headers: sbHeaders(env),
  });
}

async function enviarATodos(env, payload) {
  const subs = await obtenerSuscripciones(env);
  const vapid = {
    subject: 'mailto:contacto@marmolcor.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };

  await Promise.all(
    subs.map(async (s) => {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        const message = await buildPushPayload({ data: JSON.stringify(payload) }, subscription, vapid);
        const res = await fetch(subscription.endpoint, message);
        if (res.status === 404 || res.status === 410) {
          await eliminarSuscripcion(env, s.endpoint); // suscripción vencida, la limpiamos
        }
      } catch (e) {
        console.error('Error enviando push:', e);
      }
    })
  );
}

async function revisarYAvisar(env) {
  const fecha = hoyArgentina();

  // 1) Visitas agendadas para hoy
  if (!(await yaAvisadoHoy(env, 'agendados_hoy', fecha))) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tomas_medidas?estado=eq.agendado&fecha_agendada=eq.${fecha}&eliminado=eq.false&select=cliente_nombre,cliente_apellido`,
      { headers: sbHeaders(env) }
    );
    const rows = await res.json();
    if (rows.length) {
      const nombres = rows.map((r) => `${r.cliente_nombre || ''} ${r.cliente_apellido || ''}`.trim()).join(', ');
      await enviarATodos(env, {
        title: '📐 Toma de medidas hoy',
        body: rows.length === 1 ? `Hoy tenés que tomar medidas en lo de ${nombres}` : `Hoy tenés ${rows.length} visitas agendadas: ${nombres}`,
        url: './',
      });
    }
    await marcarAvisadoHoy(env, 'agendados_hoy', fecha);
  }

  // 2) Pedidos pendientes (sin agendar) hace más de 2 días
  if (!(await yaAvisadoHoy(env, 'pendientes_atrasados', fecha))) {
    const limite = new Date(Date.now() - 3 * 60 * 60 * 1000 - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tomas_medidas?estado=eq.pendiente&fecha_pedido=lte.${limite}&eliminado=eq.false&select=cliente_nombre`,
      { headers: sbHeaders(env) }
    );
    const rows = await res.json();
    if (rows.length) {
      await enviarATodos(env, {
        title: '😤 ¿ANDÁS SIN GANAS DE LABURAR?',
        body: 'SOLTÁ EL PADEL, TENÉS MEDIDAS PENDIENTES DE TOMAR',
        url: './',
      });
    }
    await marcarAvisadoHoy(env, 'pendientes_atrasados', fecha);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisarYAvisar(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);

    // Permite forzar una revisión manual visitando la URL del worker (útil para probar)
    if (url.pathname === '/revisar-ahora') {
      await revisarYAvisar(env);
      return new Response('OK — revisado');
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
      await enviarATodos(env, {
        title: '🆕 Nueva toma de medidas pendiente',
        body: `Se cargó un pedido para ${nombre}`,
        url: './',
      });
      return new Response('OK — avisado');
    }

    return new Response('Toma de Medidas — avisador. Este worker corre solo, no hace falta visitarlo.');
  },
};
