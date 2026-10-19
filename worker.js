/* Le&Beni — servidor
 *
 * Roda na Cloudflare. Guarda os dados no D1 e as fotos no Google Drive de uma
 * conta dedicada, cujo acesso vive aqui dentro, nunca na página.
 *
 * Quem abrir o site lê tudo sem login. Para gravar, o pedido precisa vir com o
 * login Google de um dos e-mails da lista ALLOWED_EMAILS.
 *
 * Variáveis que o Worker espera (ver LEIAME.md):
 *   DB                    binding do banco D1
 *   ALLOWED_EMAILS        e-mails que podem gravar, separados por vírgula
 *   GOOGLE_CLIENT_ID      client ID usado no botão de login do site
 *   DRIVE_CLIENT_ID       client ID da conta dona do Drive
 *   DRIVE_CLIENT_SECRET   segredo dessa conta
 *   DRIVE_REFRESH_TOKEN   refresh token dessa conta
 *   DRIVE_FOLDER_ID       (opcional) id de uma pasta já existente; sem isso o
 *                         Worker cria a pasta "Le&Beni — fotos" sozinho
 */

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function cors(extra) {
  return Object.assign({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400"
  }, extra || {});
}
function json(data, status) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: cors(JSON_HEADERS) });
}
function erro(msg, status) {
  return json({ erro: msg }, status || 400);
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/* ---------- quem está pedindo ---------- */

async function quemE(req, env) {
  const h = req.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!token) return null;

  let p;
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(token));
    if (!r.ok) return null;
    p = await r.json();
  } catch (e) { return null; }

  if (p.aud !== env.GOOGLE_CLIENT_ID) return null;
  const verificado = p.email_verified === true || p.email_verified === "true";
  if (!p.email || !verificado) return null;
  if (p.exp && Number(p.exp) * 1000 < Date.now()) return null;

  const email = String(p.email).toLowerCase();
  const lista = String(env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  if (lista.indexOf(email) < 0) return null;
  return email;
}

/* ---------- acesso ao Drive da conta dedicada ---------- */

let tokenCache = { valor: null, expira: 0 };

async function driveToken(env) {
  if (tokenCache.valor && Date.now() < tokenCache.expira - 60000) return tokenCache.valor;
  const body = new URLSearchParams({
    client_id: env.DRIVE_CLIENT_ID,
    client_secret: env.DRIVE_CLIENT_SECRET,
    refresh_token: env.DRIVE_REFRESH_TOKEN,
    grant_type: "refresh_token"
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!r.ok) throw new Error("Drive recusou o acesso: " + (await r.text()));
  const j = await r.json();
  tokenCache = { valor: j.access_token, expira: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.valor;
}

async function drivePasta(env) {
  if (env.DRIVE_FOLDER_ID) return env.DRIVE_FOLDER_ID;
  const row = await env.DB.prepare("select v from meta where k = 'folder'").first();
  if (row && row.v) return row.v;
  const t = await driveToken(env);
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Le&Beni — fotos", mimeType: "application/vnd.google-apps.folder" })
  });
  if (!r.ok) throw new Error("não deu para criar a pasta no Drive: " + (await r.text()));
  const j = await r.json();
  await env.DB.prepare("insert or replace into meta (k, v) values ('folder', ?)").bind(j.id).run();
  return j.id;
}

async function driveEnvia(env, bytes, mime, nome) {
  const t = await driveToken(env);
  const pasta = await drivePasta(env);
  const limite = "lebeni" + Math.random().toString(36).slice(2);
  const enc = new TextEncoder();
  const cabeca = enc.encode(
    "--" + limite + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify({ name: nome, parents: [pasta] }) +
    "\r\n--" + limite + "\r\nContent-Type: " + mime + "\r\n\r\n"
  );
  const cauda = enc.encode("\r\n--" + limite + "--\r\n");
  const corpo = new Uint8Array(cabeca.length + bytes.length + cauda.length);
  corpo.set(cabeca, 0);
  corpo.set(bytes, cabeca.length);
  corpo.set(cauda, cabeca.length + bytes.length);

  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + t, "Content-Type": "multipart/related; boundary=" + limite },
    body: corpo
  });
  if (!r.ok) throw new Error("o Drive recusou a foto: " + (await r.text()));
  return (await r.json()).id;
}

async function driveApaga(env, id) {
  if (!id) return;
  try {
    const t = await driveToken(env);
    await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + t }
    });
  } catch (e) { /* a linha do banco já saiu; um arquivo órfão não quebra nada */ }
}

/* ---------- leitura pública ---------- */

async function tudo(env) {
  const [f, e, p] = await Promise.all([
    env.DB.prepare("select * from folders order by created_at desc").all(),
    env.DB.prepare("select * from entries order by day desc, created_at desc").all(),
    env.DB.prepare("select * from photos order by entry_id, ord").all()
  ]);
  const porEntrada = {};
  (p.results || []).forEach(function (ph) {
    (porEntrada[ph.entry_id] = porEntrada[ph.entry_id] || []).push({
      id: ph.id, fileId: ph.file_id, thumbId: ph.thumb_id, ord: ph.ord
    });
  });
  return {
    folders: (f.results || []).map(function (x) {
      return { id: x.id, name: x.name, createdAt: x.created_at };
    }),
    entries: (e.results || []).map(function (x) {
      let pts = null;
      if (x.points) { try { pts = JSON.parse(x.points); } catch (err) { pts = null; } }
      return {
        id: x.id, type: x.type, folderId: x.folder_id, title: x.title,
        date: x.day || "", note: x.note || "",
        lat: x.lat, lng: x.lng, points: pts,
        startedAt: x.started_at, endedAt: x.ended_at,
        durationMs: x.duration_ms, distanceKm: x.distance_km,
        createdAt: x.created_at,
        photos: porEntrada[x.id] || []
      };
    })
  };
}

/* ---------- entrada do Worker ---------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const rota = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    /* --- foto (público, com cache na borda) --- */
    if (rota.startsWith("/p/")) {
      const id = rota.slice(3);
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return new Response("não encontrado", { status: 404, headers: cors() });
      const cache = caches.default;
      const guardada = await cache.match(req);
      if (guardada) return guardada;
      try {
        const t = await driveToken(env);
        const r = await fetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media", {
          headers: { Authorization: "Bearer " + t }
        });
        if (!r.ok) return new Response("não encontrado", { status: 404, headers: cors() });
        const res = new Response(r.body, {
          headers: cors({
            "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
            "Cache-Control": "public, max-age=31536000, immutable"
          })
        });
        ctx.waitUntil(cache.put(req, res.clone()));
        return res;
      } catch (e) {
        return new Response("indisponível", { status: 502, headers: cors() });
      }
    }

    /* --- leitura de tudo (público) --- */
    if (rota === "/api/data" && req.method === "GET") {
      try { return json(await tudo(env)); }
      catch (e) { return erro("não deu para ler os registros", 500); }
    }

    /* --- quem sou eu --- */
    if (rota === "/api/me" && req.method === "GET") {
      const email = await quemE(req, env);
      return json({ email: email, podeGravar: !!email });
    }

    /* --- daqui para baixo, só a whitelist --- */
    const email = await quemE(req, env);
    const precisaLogin = function () {
      return erro("Esta conta não pode gravar aqui.", 401);
    };

    /* acontecimentos */
    if (rota === "/api/folders" && req.method === "POST") {
      if (!email) return precisaLogin();
      const b = await req.json().catch(function () { return null; });
      if (!b || !b.name) return erro("falta o nome");
      const id = uid();
      await env.DB.prepare("insert into folders (id, name, created_at) values (?, ?, ?)")
        .bind(id, String(b.name).slice(0, 120), Date.now()).run();
      return json({ id: id });
    }
    if (rota.startsWith("/api/folders/") && req.method === "PUT") {
      if (!email) return precisaLogin();
      const id = rota.slice(13);
      const b = await req.json().catch(function () { return null; });
      if (!b || !b.name) return erro("falta o nome");
      await env.DB.prepare("update folders set name = ? where id = ?")
        .bind(String(b.name).slice(0, 120), id).run();
      return json({ ok: true });
    }
    if (rota.startsWith("/api/folders/") && req.method === "DELETE") {
      if (!email) return precisaLogin();
      const id = rota.slice(13);
      await env.DB.batch([
        env.DB.prepare("update entries set folder_id = null where folder_id = ?").bind(id),
        env.DB.prepare("delete from folders where id = ?").bind(id)
      ]);
      return json({ ok: true });
    }

    /* lugares e trajetos */
    if (rota === "/api/entries" && req.method === "POST") {
      if (!email) return precisaLogin();
      const b = await req.json().catch(function () { return null; });
      if (!b || !b.title || (b.type !== "place" && b.type !== "route")) return erro("registro incompleto");
      const id = uid();
      await env.DB.prepare(
        "insert into entries (id, type, folder_id, title, day, note, lat, lng, points, started_at, ended_at, duration_ms, distance_km, created_at, created_by)" +
        " values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id, b.type, b.folderId || null, String(b.title).slice(0, 200), b.date || null,
        String(b.note || "").slice(0, 4000),
        b.lat == null ? null : Number(b.lat), b.lng == null ? null : Number(b.lng),
        b.points ? JSON.stringify(b.points) : null,
        b.startedAt || null, b.endedAt || null, b.durationMs || null,
        b.distanceKm == null ? null : Number(b.distanceKm),
        Date.now(), email
      ).run();
      return json({ id: id });
    }
    if (rota.startsWith("/api/entries/") && req.method === "PUT") {
      if (!email) return precisaLogin();
      const id = rota.slice(13);
      const b = await req.json().catch(function () { return null; });
      if (!b) return erro("nada para mudar");
      await env.DB.prepare(
        "update entries set folder_id = ?, title = ?, day = ?, note = ?, lat = coalesce(?, lat), lng = coalesce(?, lng) where id = ?"
      ).bind(
        b.folderId || null, String(b.title || "").slice(0, 200), b.date || null,
        String(b.note || "").slice(0, 4000),
        b.lat == null ? null : Number(b.lat), b.lng == null ? null : Number(b.lng),
        id
      ).run();
      return json({ ok: true });
    }
    if (rota.startsWith("/api/entries/") && req.method === "DELETE") {
      if (!email) return precisaLogin();
      const id = rota.slice(13);
      const fotos = await env.DB.prepare("select file_id, thumb_id from photos where entry_id = ?").bind(id).all();
      await env.DB.batch([
        env.DB.prepare("delete from photos where entry_id = ?").bind(id),
        env.DB.prepare("delete from entries where id = ?").bind(id)
      ]);
      ctx.waitUntil((async function () {
        for (const f of (fotos.results || [])) {
          await driveApaga(env, f.file_id);
          await driveApaga(env, f.thumb_id);
        }
      })());
      return json({ ok: true });
    }

    /* fotos */
    if (rota === "/api/photos" && req.method === "POST") {
      if (!email) return precisaLogin();
      let form;
      try { form = await req.formData(); } catch (e) { return erro("envio inválido"); }
      const entryId = form.get("entryId");
      const cheia = form.get("full");
      const mini = form.get("thumb");
      const ord = Number(form.get("ord") || 0);
      if (!entryId || !cheia || !mini) return erro("faltou a foto");
      const dona = await env.DB.prepare("select id from entries where id = ?").bind(entryId).first();
      if (!dona) return erro("esse registro não existe");
      try {
        const base = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const fileId = await driveEnvia(env, new Uint8Array(await cheia.arrayBuffer()), "image/jpeg", base + ".jpg");
        const thumbId = await driveEnvia(env, new Uint8Array(await mini.arrayBuffer()), "image/jpeg", base + "-m.jpg");
        const id = uid();
        await env.DB.prepare(
          "insert into photos (id, entry_id, file_id, thumb_id, ord, created_at, created_by) values (?,?,?,?,?,?,?)"
        ).bind(id, entryId, fileId, thumbId, ord, Date.now(), email).run();
        return json({ id: id, fileId: fileId, thumbId: thumbId, ord: ord });
      } catch (e) {
        return erro(String(e.message || e), 502);
      }
    }
    if (rota.startsWith("/api/photos/") && req.method === "DELETE") {
      if (!email) return precisaLogin();
      const id = rota.slice(12);
      const f = await env.DB.prepare("select file_id, thumb_id from photos where id = ?").bind(id).first();
      await env.DB.prepare("delete from photos where id = ?").bind(id).run();
      if (f) ctx.waitUntil((async function () {
        await driveApaga(env, f.file_id);
        await driveApaga(env, f.thumb_id);
      })());
      return json({ ok: true });
    }

    return erro("rota desconhecida", 404);
  }
};
