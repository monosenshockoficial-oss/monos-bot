// Bot de WhatsApp de Monos en Shock (WhatsApp Cloud API + Claude)
// Sin dependencias: Node 20+ (fetch y http nativos).
import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";

const {
  PORT = 10000,
  WHATSAPP_TOKEN,            // token de acceso de Meta (usuario del sistema)
  PHONE_NUMBER_ID,           // identificador del número (1576775808841430)
  WABA_ID,                   // identificador de la cuenta de WhatsApp (1171283212430270)
  VERIFY_TOKEN,              // palabra secreta para el webhook (la inventas tú)
  ANTHROPIC_API_KEY,         // clave de la consola de Claude
  PANEL_PASSWORD,            // contraseña del panel web
  REGISTER_PIN,              // PIN de 6 dígitos para activar el número (solo la primera vez)
  UPSTASH_REDIS_REST_URL,    // base de datos gratis para que los chats no se borren
  UPSTASH_REDIS_REST_TOKEN,
  CLAUDE_MODEL = "claude-sonnet-5-5",
  ASESOR_WA = "573134374718",  // asesor: recibe aviso de envíos, garantías y chats que el bot le pasa
  DUENO_WA = "573137553704",   // Andrés Vargas: recibe aviso cuando un cliente manda comprobante de pago
  ALERT_TEMPLATE,              // (opcional) plantilla aprobada para avisos fuera de la ventana de 24 h
  ALERT_TEMPLATE_LANG = "es",
  GRAPH_VERSION = "v25.0",
} = process.env;

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
// los datos de pago van en la variable PAGOS_INFO de Render (no en GitHub, que es público)
const KNOWLEDGE = fs.readFileSync(new URL("./conocimiento.md", import.meta.url), "utf8") +
  (process.env.PAGOS_INFO ? `\n## DATOS DE PAGO\n${process.env.PAGOS_INFO}\n` : "");
const DATA_FILE = "/tmp/chats.json";

const SYSTEM = `Eres quien atiende el WhatsApp de Monos en Shock Suspensión, taller de monoshock y suspensión de motos en Medellín.
ESTILO (muy importante): escribes como Andrés Vargas, el dueño: paisa, motero, con energía y carisma, cercano y de confianza, como un parcero que sabe mucho de suspensión. Usa jerga natural ("¡Qué más, parcero!", "de una", "con todo el gusto", "hágale", "eso tiene arreglo"), pero sin exagerar ni sonar a robot. Nada de frases de call center ("estimado cliente", "en qué más le puedo colaborar", "como asistente virtual").
- NOMBRE: en tu PRIMERA respuesta saluda y pregúntale el nombre al cliente ("¿Con quién tengo el gusto?"), y desde ahí llámalo por su nombre. Si ya lo dijo, no lo vuelvas a preguntar.
- Mensajes CORTOS como en un chat real (1 a 3 frases), máximo 1-2 emojis. Si hay que decir varias cosas, prioriza lo más importante.
- Haz UNA pregunta a la vez para avanzar: qué moto es (marca, modelo, cilindraje), qué síntoma tiene (rebota, bota aceite, suena en seco, quedó dura o caída) y en qué ciudad está.
- Explica el daño probable con palabras sencillas y da confianza ("eso es típico de retenes vencidos, tiene arreglo").
- Precios: solo los de la tabla de PRECIOS. El mantenimiento YA INCLUYE retén, o-rings, líquido hidráulico, nitrógeno y diagnóstico: NUNCA los cobres aparte. Las piezas dañadas (vástago, bujes, botella, muelle) son REPARACIÓN: solo da el aproximado de $40.000 a $150.000 adicionales y aclara que se avisa antes. Nunca inventes precios ni fechas exactas.
- CIERRE (siempre que el cliente ya tenga la info): invítalo a dar el paso:
  · Si está en Medellín o cerca: que nos visite en el taller, Carrera 65 # 30A - 53 (Conquistadores).
  · Si está en otra ciudad: que nos envíe el monoshock por transportadora a esa dirección. Lo revisamos, lo reparamos y le mandamos fotos y videos como evidencia; SOLO PAGA cuando ya está reparado y vio la evidencia. Luego se lo devolvemos.
  Remata con energía (ej: "¡Mándalo y te lo dejamos como nuevo, parcero!").
- Tú mismo das la dirección y el horario.
- Pasa la conversación a un asesor (terminando tu mensaje con la etiqueta exacta [ASESOR]) cuando: el cliente quiere ENVIAR su monoshock desde otra ciudad (explica lo básico y luego [ASESOR]), hay una GARANTÍA o reclamo, la moto no está en la tabla de precios, preguntan por barras delanteras, el cliente está molesto, o preguntan algo que no está en la información. Di algo natural como "Dame un momentico que un asesor te atiende ya mismo" y pon [ASESOR] al final.
- Cuando el cliente envía el COMPROBANTE de pago (una imagen o documento después de hablar del pago, o dice que ya pagó): dile que ya se lo pasas a Andrés para verificarlo y termina con la etiqueta exacta [PAGO]. No confirmes tú el pago.
- Si alguien pregunta por Andrés Vargas o por el dueño, o es amigo o familiar de Andrés: dale su WhatsApp directo 313 755 3704 (solo WhatsApp, no recibe llamadas). Eso no necesita [ASESOR].
- Si algo dice PENDIENTE o no lo sabes, no lo inventes: usa [ASESOR].
- Si el cliente pregunta sinceramente si eres un robot o una persona, no mientas: dile con naturalidad que eres el asistente del taller y que si quiere te comunica con Andrés o alguien del equipo, y pon [ASESOR]. No lo menciones si no te lo preguntan.
- No hables de temas ajenos al taller.

INFORMACIÓN DEL TALLER:
${KNOWLEDGE}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);
// ---------------- almacenamiento simple
let chats = {};
try { chats = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
// acepta el token aunque se pegue con el texto de ejemplo de Upstash (TOKEN="...")
const pick = (v, key) => { if (!v) return v; const m = v.match(new RegExp(key + '\\s*=\\s*"?([^"\\s]+)')); return (m ? m[1] : v).replace(/^"|"$/g, "").trim(); };
const KV_URL = pick(UPSTASH_REDIS_REST_URL, "UPSTASH_REDIS_REST_URL");
const KV_TOKEN = pick(UPSTASH_REDIS_REST_TOKEN, "UPSTASH_REDIS_REST_TOKEN");
const kv = async (cmd) => {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` }, body: JSON.stringify(cmd) });
  return (await r.json()).result;
};
const loadChats = async () => {
  try { const v = await kv(["GET", "chats"]); if (v) { const st = JSON.parse(v); for (const [id, c] of Object.entries(chats)) { if (st[id]) { st[id].msgs = [...st[id].msgs, ...c.msgs]; st[id].unread += c.unread; } else st[id] = c; } chats = st; log("chats cargados:", Object.keys(chats).length); } }
  catch (e) { log("error cargando chats (revisa UPSTASH_REDIS_REST_TOKEN)"); }
};
let saveTimer = null;
const save = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(chats)); } catch {}
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kv(["SET", "chats", JSON.stringify(chats)]).catch(() => log("error guardando chats")), 1500);
};
const chatOf = (id, name) => (chats[id] ||= { id, name: name || id, msgs: [], botPausedUntil: 0, unread: 0 });

// ---------------- WhatsApp
async function wa(path, body) {
  const r = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) log("WA error", path, JSON.stringify(j));
  return j;
}
async function sendText(to, text, who = "bot") {
  await wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { body: text } });
  const c = chatOf(to);
  c.msgs.push({ from: who, text, t: Date.now() });
  save();
}

// ---------------- avisos al equipo (asesor / Andrés)
// Ojo: WhatsApp solo deja escribir texto libre si ese número le escribió al bot en las últimas 24 h.
// Si falla y hay una plantilla aprobada en ALERT_TEMPLATE, se envía con la plantilla.
async function sendAlert(to, text) {
  if (!to) return;
  const r = await wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, type: "text", text: { body: text } });
  if (r?.messages) { log("aviso enviado a", to); return true; }
  if (ALERT_TEMPLATE) {
    const t = await wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, type: "template",
      template: { name: ALERT_TEMPLATE, language: { code: ALERT_TEMPLATE_LANG }, components: [{ type: "body", parameters: [{ type: "text", text: text.replace(/\s+/g, " ").slice(0, 900) }] }] } });
    if (t?.messages) { log("aviso (plantilla) enviado a", to); return true; }
  }
  log("no se pudo avisar a", to, "(escríbele 'hola' al bot desde ese número o crea la plantilla ALERT_TEMPLATE)");
  return false;
}
// reenvía una foto/documento que mandó el cliente (descarga y vuelve a subir el archivo)
async function forwardMedia(media, to, caption) {
  try {
    const info = await (await fetch(`${GRAPH}/${media.id}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).json();
    if (!info.url) return false;
    const bin = await (await fetch(info.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } })).arrayBuffer();
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("type", info.mime_type || "image/jpeg");
    fd.append("file", new Blob([bin], { type: info.mime_type || "image/jpeg" }), media.filename || "comprobante");
    const up = await (await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/media`, { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: fd })).json();
    if (!up.id) return false;
    const kind = media.type === "document" ? "document" : "image";
    const r = await wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", to, type: kind, [kind]: { id: up.id, caption } });
    return !!r?.messages;
  } catch (e) { log("error reenviando archivo", e); return false; }
}
const lastClientLines = (c, n = 4) => c.msgs.filter((m) => m.from === "cliente").slice(-n).map((m) => "• " + m.text).join("\n");

// ---------------- Claude
async function askClaude(c) {
  const history = c.msgs.slice(-20).map((m) => ({ role: m.from === "cliente" ? "user" : "assistant", content: m.text }));
  // la API exige empezar con user y alternar
  const merged = [];
  for (const m of history) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += "\n" + m.content;
    else merged.push({ ...m });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system: SYSTEM, messages: merged }),
  });
  const j = await r.json();
  if (!r.ok) { log("Claude error", JSON.stringify(j)); return null; }
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function handleIncoming(msg, name) {
  const from = msg.from;
  const c = chatOf(from, name);
  let text = msg.text?.body;
  if (!text && msg.type === "interactive") text = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title;
  if (!text && msg.type === "button") text = msg.button?.text;
  const MEDIA = { image: "una imagen", document: "un documento", audio: "un audio", video: "un video", sticker: "un sticker" };
  if (msg.type === "image" || msg.type === "document") c.lastMedia = { id: msg[msg.type].id, type: msg.type, filename: msg.document?.filename, t: Date.now() };
  if (!text && (msg.image?.caption || msg.document?.caption)) text = msg.image?.caption || msg.document?.caption;
  if (msg.type !== "text" && MEDIA[msg.type]) text = `[El cliente envió ${MEDIA[msg.type]}]` + (text ? ` ${text}` : "");
  if (!text) text = `[El cliente envió un ${msg.type}]`;
  c.msgs.push({ from: "cliente", text, t: Date.now() });
  c.unread++;
  save();
  wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", status: "read", message_id: msg.id }).catch(() => {});

  if (Date.now() < c.botPausedUntil) return; // lo atiende una persona
  if (msg.type === "audio" || msg.type === "video" || msg.type === "sticker") {
    await sendText(from, "¡Recibido, parcero! 🙌 Por aquí no alcanzo a escuchar audios ni ver videos; cuéntame por escrito qué moto es y qué le notas al monoshock.");
    return;
  }
  let reply = await askClaude(c);
  if (!reply) reply = "¡Qué más, parcero! 🙌 Dame un momentico y te respondo. [ASESOR]";
  const handoff = reply.includes("[ASESOR]");
  const pago = reply.includes("[PAGO]");
  reply = reply.replace(/\[ASESOR\]|\[PAGO\]/g, "").trim();
  await sendText(from, reply);
  const quien = `${c.name} (+${from})`;
  if (pago) {
    log("Comprobante de pago:", quien);
    const recent = c.lastMedia && Date.now() - c.lastMedia.t < 30 * 60 * 1000;
    const aviso = `💰 COMPROBANTE DE PAGO por verificar\nCliente: ${quien}\nÚltimos mensajes:\n${lastClientLines(c)}`;
    await sendAlert(DUENO_WA, aviso);
    if (recent) await forwardMedia(c.lastMedia, DUENO_WA, `Comprobante de ${quien}`);
    c.needsHuman = true; save();
  }
  if (handoff) {
    c.botPausedUntil = Date.now() + 12 * 3600 * 1000;
    c.needsHuman = true;
    save();
    log("Pasar a asesor:", from, c.name);
    await sendAlert(ASESOR_WA, `🔔 Cliente esperando asesor\nCliente: ${quien}\nÚltimos mensajes:\n${lastClientLines(c)}\n\nRespóndele desde el panel del bot (el bot quedó en pausa para este chat).`);
  }
}

// ---------------- panel web
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
function panelHtml(sel) {
  const list = Object.values(chats).sort((a, b) => (b.msgs.at(-1)?.t || 0) - (a.msgs.at(-1)?.t || 0));
  const c = sel && chats[sel];
  const k = encodeURIComponent(PANEL_PASSWORD);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Monos en Shock · Chats</title><meta http-equiv="refresh" content="20">
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0B0B0C;color:#fff}header{background:#E3262B;padding:12px 16px;font-weight:800}
.wrap{display:flex;flex-wrap:wrap}.side{width:300px;max-width:100%;border-right:1px solid #222}.side a{display:block;padding:12px 16px;color:#fff;text-decoration:none;border-bottom:1px solid #1d1d1d}
.side a.on{background:#222}.tag{background:#E3262B;border-radius:9px;padding:1px 7px;font-size:12px;margin-left:6px}.main{flex:1;min-width:280px;padding:16px}
.m{max-width:80%;padding:8px 12px;border-radius:12px;margin:6px 0;white-space:pre-wrap}.cliente{background:#222}.bot{background:#3a1012;margin-left:auto}.asesor{background:#E3262B;margin-left:auto}
form{display:flex;gap:8px;margin-top:12px}textarea{flex:1;border-radius:10px;padding:10px;font:inherit}button{background:#E3262B;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:700}
small{color:#999}</style></head><body><header>🦍 Monos en Shock · Chats de WhatsApp</header><div class="wrap"><div class="side">
${list.map((x) => `<a class="${x.id === sel ? "on" : ""}" href="/panel?k=${k}&c=${x.id}">${esc(x.name)}${x.needsHuman ? '<span class="tag">ASESOR</span>' : ""}<br><small>+${x.id}</small></a>`).join("") || "<p style='padding:16px'>Aún no hay chats.</p>"}
</div><div class="main">${c ? `<h3>${esc(c.name)} <small>+${c.id}</small></h3>
<small>Bot: ${Date.now() < c.botPausedUntil ? "⏸️ pausado (lo atiendes tú)" : "🤖 activo"}</small>
<div>${c.msgs.slice(-60).map((m) => `<div class="m ${m.from}">${esc(m.text)}<br><small>${m.from} · ${new Date(m.t).toLocaleString("es-CO", { timeZone: "America/Bogota" })}</small></div>`).join("")}</div>
<form method="post" action="/panel/send?k=${k}&c=${c.id}"><textarea name="text" rows="2" placeholder="Escribe tu respuesta…"></textarea><button>Enviar</button></form>
<form method="post" action="/panel/bot?k=${k}&c=${c.id}"><button>${Date.now() < c.botPausedUntil ? "Reactivar bot" : "Pausar bot (atender yo)"}</button></form>
<small>Recuerda: solo puedes escribir libremente si el cliente te escribió en las últimas 24 horas.</small>` : "<p>Elige un chat.</p>"}</div></div></body></html>`;
}
const readBody = (req) => new Promise((res) => { let d = ""; req.on("data", (x) => (d += x)); req.on("end", () => res(d)); });

// ---------------- política de privacidad (requerida por Meta)
const PRIVACY_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de privacidad · Monos en Shock Suspensión</title>
<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111}h1{color:#E3262B}h2{margin-top:28px}</style></head><body>
<h1>Política de privacidad</h1>
<p><b>Monos en Shock Suspensión</b> · Carrera 65 # 30A - 53, Medellín, Colombia · WhatsApp +57 300 000 0163 · monosenshockoficial@gmail.com</p>
<p>Última actualización: 20 de noviembre de 2026.</p>
<h2>1. Qué datos recogemos</h2>
<p>Cuando nos escribes por WhatsApp recibimos tu número de teléfono, el nombre de tu perfil y el contenido de los mensajes, fotos o audios que nos envíes (por ejemplo, la marca y modelo de tu moto o el problema de tu suspensión).</p>
<h2>2. Para qué los usamos</h2>
<p>Solo para atender tu consulta: responder preguntas, cotizar, agendar la revisión o el envío de tu monoshock y hacer seguimiento a la reparación y la garantía. Usamos un asistente automático con inteligencia artificial (Claude, de Anthropic) para responder más rápido; un asesor humano puede tomar la conversación en cualquier momento.</p>
<h2>3. Con quién los compartimos</h2>
<p>No vendemos ni compartimos tus datos con terceros para publicidad. Solo los procesan los proveedores necesarios para prestar el servicio: Meta (WhatsApp Business Platform), Anthropic (asistente de IA) y Render (alojamiento del servidor).</p>
<h2>4. Cuánto tiempo los guardamos</h2>
<p>Guardamos las conversaciones el tiempo necesario para atender tu servicio y la garantía, y como máximo 2 años, salvo que la ley exija otra cosa.</p>
<h2>5. Tus derechos</h2>
<p>De acuerdo con la Ley 1581 de 2012 de Colombia, puedes conocer, actualizar, rectificar o pedir que borremos tus datos, y revocar tu autorización. Escríbenos a monosenshockoficial@gmail.com o al WhatsApp +57 300 000 0163 y lo atendemos en un plazo máximo de 15 días hábiles.</p>
<h2>6. Eliminación de datos</h2>
<p>Para pedir que borremos tus datos, envía la palabra <b>BORRAR</b> por WhatsApp o escríbenos al correo indicado.</p>
<h2>7. Cambios</h2>
<p>Si cambiamos esta política, publicaremos la nueva versión en esta misma página.</p>
</body></html>`;

// ---------------- servidor
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && u.pathname === "/") { res.end("Monos en Shock bot OK"); return; }
    if (req.method === "GET" && (u.pathname === "/privacidad" || u.pathname === "/terminos")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PRIVACY_HTML); return;
    }
    if (u.pathname === "/webhook" && req.method === "GET") {
      if (u.searchParams.get("hub.mode") === "subscribe" && u.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
        res.end(u.searchParams.get("hub.challenge")); return;
      }
      res.writeHead(403); res.end(); return;
    }
    if (u.pathname === "/webhook" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      res.writeHead(200); res.end("ok");
      for (const e of body.entry || []) for (const ch of e.changes || []) {
        const v = ch.value || {};
        const names = Object.fromEntries((v.contacts || []).map((x) => [x.wa_id, x.profile?.name]));
        for (const m of v.messages || []) handleIncoming(m, names[m.from]).catch((err) => log("handle error", err));
      }
      return;
    }
    if (u.pathname.startsWith("/panel")) {
      if (!PANEL_PASSWORD || u.searchParams.get("k") !== PANEL_PASSWORD) { res.writeHead(401); res.end("Acceso denegado"); return; }
      const cid = u.searchParams.get("c");
      if (req.method === "POST" && u.pathname === "/panel/send" && chats[cid]) {
        const text = new URLSearchParams(await readBody(req)).get("text")?.trim();
        if (text) { await sendText(cid, text, "asesor"); chats[cid].botPausedUntil = Date.now() + 12 * 3600 * 1000; chats[cid].needsHuman = false; chats[cid].unread = 0; save(); }
        res.writeHead(303, { Location: `/panel?k=${encodeURIComponent(PANEL_PASSWORD)}&c=${cid}` }); res.end(); return;
      }
      if (req.method === "POST" && u.pathname === "/panel/bot" && chats[cid]) {
        const c = chats[cid];
        c.botPausedUntil = Date.now() < c.botPausedUntil ? 0 : Date.now() + 12 * 3600 * 1000;
        c.needsHuman = false; save();
        res.writeHead(303, { Location: `/panel?k=${encodeURIComponent(PANEL_PASSWORD)}&c=${cid}` }); res.end(); return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(panelHtml(cid)); return;
    }
    res.writeHead(404); res.end();
  } catch (err) { log("server error", err); if (!res.headersSent) { res.writeHead(500); res.end(); } }
}).listen(PORT, async () => {
  await loadChats();
  log("Bot escuchando en puerto", PORT);
  if (REGISTER_PIN && PHONE_NUMBER_ID) log("register:", JSON.stringify(await wa(`${PHONE_NUMBER_ID}/register`, { messaging_product: "whatsapp", pin: REGISTER_PIN })));
  if (WABA_ID) log("subscribed_apps:", JSON.stringify(await wa(`${WABA_ID}/subscribed_apps`, {})));
});
