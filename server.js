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
  CLAUDE_MODEL = "claude-sonnet-5-5",
  GRAPH_VERSION = "v25.0",
} = process.env;

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const KNOWLEDGE = fs.readFileSync(new URL("./conocimiento.md", import.meta.url), "utf8");
const DATA_FILE = "/tmp/chats.json";

const SYSTEM = `Eres el asistente de WhatsApp de Monos en Shock Suspensión, taller de monoshock y suspensión de motos en Medellín.
Hablas como un colombiano paisa amable y motero ("¡Hola, parcero!", "con mucho gusto"), profesional y cercano.
Reglas:
- Respuestas CORTAS (máximo 3-4 frases), aptas para WhatsApp, con 1-2 emojis como mucho.
- Usa SOLO la información del taller de abajo. Si algo dice PENDIENTE o no lo sabes, NO lo inventes: ofrece pasar con un asesor.
- Solo das los precios que están en la tabla de PRECIOS de la información del taller, con la regla de base + adicionales; aclara siempre que el valor final se confirma en la revisión. Nunca inventes precios ni prometas fechas.
- Para orientar, pregunta qué moto tiene (marca, modelo, año) y qué síntoma nota.
- Si el cliente quiere agendar, ya decidió traer la moto, enviar su monoshock, pagar, habla de un reclamo/garantía, pide hablar con una persona, o está molesto: responde con una frase breve diciendo que lo pasas con un asesor y termina tu mensaje con la etiqueta exacta [ASESOR].
- No hables de temas ajenos al taller.

INFORMACIÓN DEL TALLER:
${KNOWLEDGE}`;

// ---------------- almacenamiento simple
let chats = {};
try { chats = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(chats)); } catch {} };
const chatOf = (id, name) => (chats[id] ||= { id, name: name || id, msgs: [], botPausedUntil: 0, unread: 0 });
const log = (...a) => console.log(new Date().toISOString(), ...a);

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
  if (!text) text = `[El cliente envió un ${msg.type}]`;
  c.msgs.push({ from: "cliente", text, t: Date.now() });
  c.unread++;
  save();
  wa(`${PHONE_NUMBER_ID}/messages`, { messaging_product: "whatsapp", status: "read", message_id: msg.id }).catch(() => {});

  if (Date.now() < c.botPausedUntil) return; // lo atiende una persona
  if (msg.type !== "text" && msg.type !== "interactive" && msg.type !== "button") {
    await sendText(from, "¡Gracias! 🙌 Por ahora leo mensajes de texto. Cuéntame por escrito qué moto tienes y qué le notas al monoshock, y si quieres te paso con un asesor para ver tus fotos o videos.");
    return;
  }
  let reply = await askClaude(c);
  if (!reply) reply = "¡Hola! 🙌 En un momento te atiende un asesor de Monos en Shock. [ASESOR]";
  const handoff = reply.includes("[ASESOR]");
  reply = reply.replace("[ASESOR]", "").trim();
  await sendText(from, reply);
  if (handoff) {
    c.botPausedUntil = Date.now() + 12 * 3600 * 1000;
    c.needsHuman = true;
    save();
    log("Pasar a asesor:", from, c.name);
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
  log("Bot escuchando en puerto", PORT);
  if (REGISTER_PIN && PHONE_NUMBER_ID) log("register:", JSON.stringify(await wa(`${PHONE_NUMBER_ID}/register`, { messaging_product: "whatsapp", pin: REGISTER_PIN })));
  if (WABA_ID) log("subscribed_apps:", JSON.stringify(await wa(`${WABA_ID}/subscribed_apps`, {})));
});
