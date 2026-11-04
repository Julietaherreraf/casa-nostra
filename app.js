// Casa Nostra — agenda de reservas.
// Datos en Firestore; acceso con Google.
// Quién puede ver/editar lo deciden las reglas de Firestore (firestore.rules), no esta interfaz.
//
// Colecciones:
//   reservas/{id}        nombre, desde, hasta, adultos, ninos, origen, notas
//   fichas/{reservaId}   personas: [{nombre, dni}], enmascarado: bool   ("Datos autorización")
//   config/acceso        lectores: [mails que ven la agenda], autorizan: [mails que ven y envían autorizaciones]
//   config/firma         nombre, dni   (firma del mensaje a portería)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, setDoc, writeBatch }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBWx8efic_rveDK_xt-X-HMq2zHNwKd8xs",
  authDomain: "casa-nostra-a18ff.firebaseapp.com",
  projectId: "casa-nostra-a18ff",
  storageBucket: "casa-nostra-a18ff.firebasestorage.app",
  messagingSenderId: "68070949511",
  appId: "1:68070949511:web:1eccbf10996d308edc6e22"
};

// Única cuenta que puede editar. Tiene que coincidir con la de firestore.rules.
const EDITOR = "julietaherreraf@gmail.com";

// Texto fijo del mensaje a portería.
const LUGAR = "Barrio Norte casa dos de Costanera";

// Reservas que había al momento de crear la app; se cargan una sola vez con un botón.
const RESERVAS_INICIALES = [
  { nombre: "Hugo Ugartemendia", desde: "2026-11-19", hasta: "2026-11-23", adultos: 4, ninos: 2, origen: "Booking", notas: "" },
  { nombre: "Rodolfo Zagaglia", desde: "2026-12-23", hasta: "2026-12-27", adultos: 5, ninos: 1, origen: "Booking", notas: "" },
  { nombre: "Fabián Mora", desde: "2027-01-07", hasta: "2027-01-11", adultos: null, ninos: null, origen: "Directa", notas: "" },
  { nombre: "Fabián Mora", desde: "2027-01-15", hasta: "2027-01-18", adultos: null, ninos: null, origen: "Directa", notas: "" },
  { nombre: "Verónica Delpozzi", desde: "2027-01-22", hasta: "2027-01-29", adultos: 4, ninos: 0, origen: "Booking", notas: "" }
];

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const DOW = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MESL = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

const S = {
  phase: "auth",          // auth | login | loading | denied | error | ready
  user: null,
  isEditor: false,
  reservas: [], reservasLoaded: false,
  lectores: [], autorizan: [],
  fichas: {}, canFichas: false, firma: null,
  mode: readPref("cn-mode", ["lista", "mes"], "lista"),
  view: { y: new Date().getFullYear(), m: new Date().getMonth() },
  editing: null, confirmDel: false, formErr: "",
  showAccess: false, accessErr: "",
  // Ventana "Datos autorización"
  authOpen: null, draft: null, pasteText: "", reveal: false, toast: "", sheetErr: "",
  busy: false, msg: "", msgErr: false,
};
let unsubs = [];
let loadTimer = null;
let sheetJustOpened = false;
const masking = new Set();

// ---------- utilidades ----------
function readPref(k, ok, def) { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : def; } catch (e) { return def; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function today() { return iso(new Date()); }
function pd(s) { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function ymd(s) { const p = s.split("-"); return [+p[0], +p[1] - 1, +p[2]]; }
function days(a, b) { return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 864e5); }
function nice(s) { const d = pd(s); return DOW[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1); }
function largo(s) { const p = s.split("-"); return (+p[2]) + " de " + MESL[+p[1] - 1]; }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function first(n) { return String(n || "").split(" ")[0]; }
function isISODate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function total(r) { return r.adultos == null && r.ninos == null ? null : (+r.adultos || 0) + (+r.ninos || 0); }
function peopleTxt(r) {
  if (total(r) == null) return "Cantidad a confirmar";
  const a = +r.adultos || 0, n = +r.ninos || 0;
  let t = a + " adulto" + (a === 1 ? "" : "s");
  if (n) t += ", " + n + " niño" + (n === 1 ? "" : "s");
  return t;
}
function relTxt(s) { const d = days(today(), s); if (d === 0) return "hoy"; if (d === 1) return "mañana"; if (d < 0) return "en curso"; return "en " + d + " días"; }
function isOwner(r) { return r.origen === "Propietarios"; }
function sorted() { return S.reservas.slice().sort((a, b) => a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : 0); }
function isDark() {
  const t = document.documentElement.getAttribute("data-theme");
  if (t === "dark") return true; if (t === "light") return false;
  return !!(window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
}
function errText(e) {
  const c = e && e.code || "";
  if (c.includes("permission-denied")) return "No tenés permiso para hacer esto.";
  if (c.includes("unavailable") || c.includes("network")) return "Sin conexión. Revisá internet y probá de nuevo.";
  if (c.includes("popup-closed") || c.includes("cancelled-popup")) return "Se cerró la ventana de Google antes de terminar.";
  if (c.includes("unauthorized-domain")) return "Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).";
  return "Algo falló (" + (c || "error") + "). Probá de nuevo.";
}

// ---------- DNI ----------
function digits(s) { return String(s || "").replace(/\D/g, ""); }
function fmtDni(d) { d = digits(d); return d ? d.replace(/\B(?=(\d{3})+(?!\d))/g, ".") : ""; }
function maskDni(d) { d = digits(d); if (d.length < 4) return "•••"; const f = fmtDni(d); return f.slice(0, -3).replace(/\d/g, "•") + f.slice(-3); }
function okDni(d) { d = digits(d); return d.length >= 7 && d.length <= 8; }

// Lee el texto pegado: "Nombre 30.123.456", "Nombre - DNI 30123456",
// o el nombre en una línea y el DNI en la siguiente (como el formato de portería).
function parseListado(txt) {
  const out = []; let pending = null;
  String(txt).split(/\r?\n/).forEach(raw => {
    const line = raw.trim(); if (!line) return;
    const m = line.match(/(\d[\d.\s]{5,12}\d)/);
    const dni = m ? digits(m[1]) : "";
    const name = (m ? line.replace(m[1], "") : line)
      .replace(/(^|\s)(?:d\.?n\.?i\.?|nro\.?|n[°º]|documento)(?=[\s:.\-]|$)/gi, " ")
      .replace(/[:\-–,;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    if (dni && !name && pending) { pending.dni = dni; out.push(pending); pending = null; return; }
    if (pending) { out.push(pending); pending = null; }
    if (dni) out.push({ nombre: name, dni }); else if (name) pending = { nombre: name, dni: "" };
  });
  if (pending) out.push(pending);
  return out;
}
function fichaWarnings(personas, r) {
  const w = [], seen = {}, t = total(r);
  personas.forEach((p, i) => {
    const who = "Fila " + (i + 1) + (p.nombre ? " (" + p.nombre + ")" : "");
    if (!p.nombre) w.push(who + ": falta el nombre.");
    if (!p.dni) w.push(who + ": falta el DNI.");
    else if (!okDni(p.dni)) w.push(who + ": el DNI tiene " + digits(p.dni).length + " dígitos; revisalo.");
    if (p.dni) { if (seen[p.dni]) w.push("DNI repetido: " + fmtDni(p.dni) + "."); seen[p.dni] = 1; }
  });
  if (t != null && personas.length !== t) w.push("Cargaste " + personas.length + " de " + t + " personas de la reserva.");
  if (t == null) w.push("La reserva no tiene cantidad de personas cargada; no puedo comparar.");
  return w;
}
function fichaState(r) {
  const f = S.fichas[r.id];
  if (f && f.enmascarado) return { cls: "masked", txt: "Archivado" };
  const ps = f ? f.personas : [];
  const valid = ps.filter(p => p.nombre && okDni(p.dni)).length, t = total(r);
  const done = ps.length > 0 && valid === ps.length && (t == null || ps.length === t);
  return done ? { cls: "ok", txt: "Completo ✓", done: true } : { cls: "pend", txt: valid + " de " + (t == null ? "?" : t) };
}
function saludo() { const h = new Date().getHours(); return h < 13 ? "Buenos días!" : h < 20 ? "Buenas tardes!" : "Buenas noches!"; }
function mensaje(r, personas, masked) {
  const d = masked ? maskDni : fmtDni;
  let t = saludo() + "\n\nAutorizo el ingreso a mi casa en " + LUGAR + ", desde el " + largo(r.desde) + " al " + largo(r.hasta) + " a los siguientes:\n";
  personas.forEach(p => { t += "\n" + p.nombre + "\nDNI n°: " + d(p.dni); });
  t += "\n\nSaluda atte\n" + (S.firma?.nombre || "") + "\nDNI: " + d(S.firma?.dni || "");
  return t;
}

// Cuando la estadía ya terminó, reemplaza los DNI completos por la versión enmascarada en la base.
// Lo hace solo la cuenta que edita, la próxima vez que abre la app.
function maskPast() {
  if (!S.isEditor || !S.reservasLoaded) return;
  const td = today();
  Object.entries(S.fichas).forEach(([id, f]) => {
    if (f.enmascarado || masking.has(id)) return;
    const r = S.reservas.find(x => x.id === id);
    if (r && r.hasta >= td) return;
    if (!r) return; // ficha huérfana: se borra junto con la reserva, no acá
    masking.add(id);
    const personas = (f.personas || []).map(p => ({ nombre: p.nombre, dni: maskDni(p.dni) }));
    setDoc(doc(db, "fichas", id), { personas, enmascarado: true }).catch(() => masking.delete(id));
  });
}

// ---------- auth y datos ----------
getRedirectResult(auth).catch(e => { S.msg = errText(e); S.msgErr = true; render(); });

onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  clearTimeout(loadTimer);
  Object.assign(S, { user, reservas: [], reservasLoaded: false, lectores: [], autorizan: [], fichas: {}, canFichas: false, firma: null, editing: null, showAccess: false, authOpen: null });
  if (!user) { S.phase = "login"; render(); return; }
  S.isEditor = (user.email || "").toLowerCase() === EDITOR;
  S.phase = "loading"; render();
  loadTimer = setTimeout(() => { if (S.phase === "loading") { S.phase = "error"; render(); } }, 10000);

  unsubs.push(onSnapshot(collection(db, "reservas"), snap => {
    clearTimeout(loadTimer);
    S.reservas = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => isISODate(r.desde) && isISODate(r.hasta));
    S.reservasLoaded = true;
    S.phase = "ready"; maskPast(); render();
  }, err => {
    clearTimeout(loadTimer);
    S.phase = (err.code || "").includes("permission-denied") ? "denied" : "error";
    render();
  }));

  // Datos autorización: si las reglas no dejan leerlos (por ej. el hermano), simplemente no se muestran.
  unsubs.push(onSnapshot(collection(db, "fichas"), snap => {
    S.canFichas = true;
    S.fichas = {};
    snap.docs.forEach(d => { const v = d.data(); S.fichas[d.id] = { personas: Array.isArray(v.personas) ? v.personas : [], enmascarado: !!v.enmascarado }; });
    maskPast(); render();
  }, () => { S.canFichas = false; render(); }));

  unsubs.push(onSnapshot(doc(db, "config", "firma"), snap => {
    S.firma = snap.exists() ? snap.data() : null; render();
  }, () => {}));

  if (S.isEditor) {
    unsubs.push(onSnapshot(doc(db, "config", "acceso"), snap => {
      const d = snap.exists() ? snap.data() : {};
      S.lectores = Array.isArray(d.lectores) ? d.lectores : [];
      S.autorizan = Array.isArray(d.autorizan) ? d.autorizan : [];
      if (S.phase === "ready") render();
    }, () => {}));
  }
});

async function login() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try { await signInWithPopup(auth, provider); }
  catch (e) {
    if ((e.code || "").includes("popup-blocked")) { await signInWithRedirect(auth, provider); return; }
    S.msg = errText(e); S.msgErr = true; render();
  }
}

async function run(fn, okMsg) {
  S.busy = true; S.msg = "Guardando…"; S.msgErr = false; render();
  try { await fn(); S.msg = okMsg || "Guardado."; S.msgErr = false; }
  catch (e) { S.msg = errText(e); S.msgErr = true; throw e; }
  finally { S.busy = false; render(); }
}

// ---------- vistas ----------
const GOOGLE_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function header() {
  let h = '<header class="top"><span class="eyebrow">Casa en el lago · reservas</span>';
  h += '<div class="titlerow"><h1>Casa Nostra</h1><button class="themebtn" id="theme" aria-label="Cambiar a modo ' + (isDark() ? "claro" : "oscuro") + '">' + (isDark() ? "☀ Claro" : "☾ Oscuro") + '</button></div>';
  h += '<p class="sub">Quién llega, quién se va y cuánta gente viene.</p></header>';
  return h;
}
function userLine() {
  if (!S.user) return "";
  return '<div class="userline"><span>Entraste como ' + esc(S.user.email) + (S.isEditor ? " · podés editar" : "") + '</span><button class="link" id="logout">Salir</button></div>';
}

function render() {
  const el = document.getElementById("app");
  let h = header();
  if (S.phase === "auth") h += '<p class="status">Cargando…</p>';
  else if (S.phase === "login") {
    h += '<div class="panel login"><h2>Entrá con tu cuenta de Google</h2><p>Solo pueden ver la agenda las personas autorizadas.</p>';
    h += '<button class="primary gbtn" id="login">' + GOOGLE_SVG + 'Entrar con Google</button>';
    if (S.msg) h += '<p class="status' + (S.msgErr ? " err" : "") + '">' + esc(S.msg) + '</p>';
    h += '</div>';
  }
  else if (S.phase === "loading") h += userLine() + '<p class="status">Cargando reservas…</p>';
  else if (S.phase === "denied") {
    h += userLine() + '<div class="panel"><h2>Todavía no tenés acceso</h2><p>Tu cuenta <b>' + esc(S.user.email) + '</b> no está autorizada para ver la agenda. Pedile a Juli que la agregue y después volvé a abrir esta página.</p>';
    h += '<p class="sub">Si entraste con otra cuenta de Google por error, tocá “Salir” y elegí la correcta.</p></div>';
  }
  else if (S.phase === "error") {
    h += userLine() + '<div class="panel"><h2>No se pudieron cargar las reservas</h2><p>Revisá la conexión a internet y recargá la página.</p><div><button class="primary" id="reload">Recargar</button></div></div>';
  }
  else h += mainHtml();
  el.innerHTML = h;

  // Ventana "Datos autorización" (va fuera de #app para quedar encima de todo)
  const had = document.getElementById("scrim");
  const keepScroll = had ? had.querySelector(".sheet")?.scrollTop : 0;
  if (had) had.remove();
  const r = S.authOpen && S.reservas.find(x => x.id === S.authOpen);
  if (r && S.canFichas && S.phase === "ready") {
    document.body.insertAdjacentHTML("beforeend", sheetHtml(r));
    sheetJustOpened = false;
    const sh = document.querySelector("#scrim .sheet"); if (sh && keepScroll) sh.scrollTop = keepScroll;
    document.body.classList.add("noscroll");
  } else document.body.classList.remove("noscroll");
  bind();
}

function mainHtml() {
  const list = sorted();
  let h = userLine();
  h += '<div class="bar"><span class="status' + (S.msgErr ? " err" : "") + '" role="status">' + esc(S.msg || "Hoy es " + nice(today())) + '</span>';
  if (S.isEditor && !S.editing) h += '<div class="r actions"><button id="access">Acceso</button><button class="primary" id="add">+ Agregar reserva</button></div>';
  h += '</div>';
  if (S.isEditor && S.showAccess) h += accessHtml();
  if (S.editing) h += formHtml();
  h += '<div class="seg" role="tablist" aria-label="Tipo de vista"><button role="tab" id="m-lista" aria-selected="' + (S.mode === "lista") + '">Lista</button><button role="tab" id="m-mes" aria-selected="' + (S.mode === "mes") + '">Calendario</button></div>';
  if (S.isEditor && S.reservas.length === 0) {
    h += '<div class="empty"><p>No hay reservas cargadas todavía.</p><button class="primary" id="seed"' + (S.busy ? " disabled" : "") + '>Cargar las 5 reservas actuales</button><p class="sub">Hugo, Rodolfo, Fabián (×2) y Verónica. Solo hace falta una vez.</p></div>';
  }
  if (S.mode === "mes") return h + monthHtml(list);
  const upcoming = list.filter(r => r.hasta >= today());
  h += '<section aria-labelledby="h-ag"><h2 id="h-ag">Próximas estadías</h2>';
  h += '<div class="legend"><span><i class="dot" style="background:var(--lake)"></i>Booking</span><span><i class="dot" style="background:var(--reed)"></i>Directa</span><span><i class="dot" style="background:var(--own)"></i>Propietarios</span><span><i class="dot" style="background:var(--clay)"></i>Salida</span></div>';
  if (!upcoming.length) h += '<div class="empty"><p>No hay estadías próximas.' + (S.isEditor ? ' Tocá “Agregar reserva” para sumar una.' : '') + '</p></div>';
  else { h += '<div class="agenda">'; upcoming.forEach((r, i) => { h += stayHtml(r, i === 0); }); h += '</div>'; }
  return h + '</section>';
}

function stayHtml(r, isNext) {
  const d = pd(r.desde), n = days(r.desde, r.hasta), own = isOwner(r), direct = !own && r.origen !== "Booking", t = total(r);
  let h = '<article class="stay' + (isNext ? " next" : "") + (own ? " own" : "") + '">';
  h += '<div class="date" aria-hidden="true"><span class="d">' + d.getDate() + '</span><span class="m">' + MES[d.getMonth()] + '</span><span class="w">' + DOW[d.getDay()] + '</span></div>';
  h += '<div class="card"><div class="head"><h3>' + esc(r.nombre) + '</h3><div class="pills"><span class="pill' + (own ? " own" : direct ? " direct" : "") + '">' + esc(r.origen) + '</span><span class="pill when">' + relTxt(r.desde) + '</span></div></div>';
  if (own) h += '<p class="ownline">Van los propietarios.</p>';
  else h += '<div class="box"><div class="big"><span class="num">' + (t == null ? "?" : t) + '</span><span class="lbl">personas</span></div><div class="det">' + esc(peopleTxt(r)) + '</div></div>';
  h += '<ul class="facts"><li>Llega <b>' + nice(r.desde) + '</b> · se va <b class="out">' + nice(r.hasta) + '</b> · ' + n + ' noche' + (n === 1 ? "" : "s") + '</li></ul>';
  if (r.notas) h += '<p class="notes">' + esc(r.notas) + '</p>';
  if (S.canFichas && !own) {
    const st = fichaState(r);
    h += '<button class="authbtn ' + st.cls + '" data-auth="' + esc(r.id) + '" aria-haspopup="dialog"><span class="l">' + EYE + 'Datos autorización</span><span class="st">' + esc(st.txt) + '</span></button>';
  }
  if (S.isEditor && !S.editing) h += '<div><button class="ghost" data-edit="' + esc(r.id) + '">Editar reserva</button></div>';
  return h + '</div></article>';
}

function dniTable(personas, editable) {
  if (!personas.length) return '<p class="sub">Todavía no hay personas cargadas.</p>';
  let h = '<div class="sh"><span class="sub">' + personas.length + ' persona' + (personas.length === 1 ? "" : "s") + '</span>';
  h += '<button class="ghost small eye" id="reveal">' + (S.reveal ? EYE_OFF + "Ocultar DNI" : EYE + "Ver DNI") + '</button></div>';
  h += '<div class="tbl-wrap"><table><thead><tr><th></th><th>Nombre completo</th><th>DNI</th>' + (editable ? '<th><span class="sr">Acciones</span></th>' : '') + '</tr></thead><tbody>';
  personas.forEach((p, i) => {
    const bad = !p.dni || !okDni(p.dni);
    const dniTxt = !p.dni ? "falta" : (S.reveal && digits(p.dni) === p.dni ? fmtDni(p.dni) : (digits(p.dni) === p.dni ? maskDni(p.dni) : p.dni));
    h += '<tr class="' + (bad && editable ? "bad" : "") + '"><td class="n">' + (i + 1) + '</td><td>' + (p.nombre ? esc(p.nombre) : '<span class="sub">(sin nombre)</span>') + '</td><td class="dni">' + esc(dniTxt) + '</td>';
    if (editable) h += '<td class="act"><button class="ghost small" data-rm="' + i + '">Quitar</button></td>';
    h += '</tr>';
  });
  return h + '</tbody></table></div>';
}

function sheetHtml(r) {
  const f = S.fichas[r.id] || { personas: [], enmascarado: false };
  const t = total(r);
  let h = '<div class="scrim" id="scrim"><div class="sheet' + (sheetJustOpened ? " anim" : "") + '" role="dialog" aria-modal="true" aria-labelledby="sh-t"><span class="grab" aria-hidden="true"></span>';
  h += '<div class="sh"><div><h2 id="sh-t">Datos autorización</h2><p class="sub">' + esc(r.nombre) + ' · ' + nice(r.desde) + ' al ' + nice(r.hasta) + ' · ' + (t == null ? "? " : t + " ") + 'personas</p></div><button class="ghost small" id="closeauth">Cerrar</button></div>';

  if (f.enmascarado) {
    h += '<p class="note-box">La estadía ya terminó. Los DNI se guardaron enmascarados y no se puede generar el mensaje.</p>';
    h += dniTable(f.personas, false);
    return h + '</div></div>';
  }

  if (S.isEditor) {
    const draft = S.draft || [];
    h += '<label class="f">Pegar listado (como llega por WhatsApp)<textarea id="paste" placeholder="Juan Pérez 30.123.456&#10;María Gómez - DNI 31987654">' + esc(S.pasteText) + '</textarea></label>';
    h += '<div class="row"><button id="doparse">Agregar al listado</button><span class="sub small-t">Acepta un nombre y DNI por línea, o el nombre y abajo el DNI.</span></div>';
    h += dniTable(draft, true);
    const w = draft.length ? fichaWarnings(draft, r) : [];
    if (draft.length) h += '<ul class="warns">' + (w.length ? w.map(x => '<li>' + esc(x) + '</li>').join("") : '<li class="ok">Todo en orden.</li>') + '</ul>';
    if (S.sheetErr) h += '<p class="err" role="alert">' + esc(S.sheetErr) + '</p>';
    h += '<div class="actions"><div class="r"><button class="primary" id="savefi"' + (S.busy ? " disabled" : "") + '>Guardar</button>' + (S.toast ? '<span class="toast" role="status">' + esc(S.toast) + '</span>' : '') + '</div>';
    if (draft.length) h += '<button class="ghost" id="clearfi">Vaciar listado</button>';
    h += '</div>';
    if (fichaState(r).done && S.firma) h += '<hr class="sep">' + messageBlock(r, f.personas);
    else if (!S.firma) h += '<p class="note-box">Falta cargar la firma (nombre y DNI de quien autoriza) en <b>Acceso</b>.</p>';
    return h + '</div></div>';
  }

  // Quien envía (mamá)
  if (!fichaState(r).done) {
    h += '<p class="note-box">Juli todavía no completó los datos (' + esc(fichaState(r).txt) + '). Cuando estén, acá aparece el mensaje listo para mandar.</p>';
    h += dniTable(f.personas, false);
  } else if (!S.firma) {
    h += '<p class="note-box">Falta la firma del mensaje. Pedile a Juli que la cargue.</p>';
  } else h += messageBlock(r, f.personas);
  return h + '</div></div>';
}

function messageBlock(r, personas) {
  const full = mensaje(r, personas, false);
  let h = '<div class="sh"><span class="sub">Mensaje para portería</span><button class="ghost small eye" id="reveal">' + (S.reveal ? EYE_OFF + "Ocultar DNI" : EYE + "Ver DNI") + '</button></div>';
  h += '<div class="phone"><div class="bubble">' + esc(mensaje(r, personas, !S.reveal)) + '</div></div>';
  h += '<p class="sub small-t">En pantalla los DNI se ven tapados, pero lo que se envía o se copia lleva los números completos.</p>';
  h += '<div class="row"><a class="wa btnlink" href="https://api.whatsapp.com/send?text=' + encodeURIComponent(full) + '" target="_blank" rel="noopener">Enviar por WhatsApp</a>';
  h += '<button id="copymsg">Copiar mensaje</button>' + (S.toast ? '<span class="toast" role="status">' + esc(S.toast) + '</span>' : '') + '</div>';
  h += '<textarea id="msgfallback" class="sr" aria-hidden="true" tabindex="-1" readonly>' + esc(full) + '</textarea>';
  return h;
}

function monthHtml(all) {
  const { y, m } = S.view, firstDay = new Date(y, m, 1), lead = (firstDay.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate(), td = today();
  let h = '<section aria-labelledby="h-mes"><h2 id="h-mes" class="sr">Calendario</h2>';
  h += '<div class="mhead"><button id="prev" aria-label="Mes anterior">‹</button><h3>' + MESL[m] + ' ' + y + '</h3><button id="next" aria-label="Mes siguiente">›</button></div>';
  h += '<div class="grid-wrap"><div class="grid">';
  ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"].forEach(d => { h += '<div class="dow">' + d + '</div>'; });
  for (let i = 0; i < lead; i++) h += '<div class="cell pad"></div>';
  for (let dd = 1; dd <= dim; dd++) {
    const s = iso(new Date(y, m, dd)); let occ = null, arr = null, dep = null;
    all.forEach(r => { if (r.desde <= s && s < r.hasta) occ = r; if (r.desde === s) arr = r; if (r.hasta === s) dep = r; });
    const cls = "cell" + (occ ? " occ" : "") + (occ && isOwner(occ) ? " own" : occ && occ.origen !== "Booking" ? " direct" : "") + (s === td ? " today" : "");
    let tags = "";
    if (dep) tags += '<span class="tag outtag">↑ ' + esc(first(dep.nombre)) + '</span>';
    if (arr) tags += '<span class="tag in">↓ ' + esc(first(arr.nombre)) + '</span>';
    h += '<div class="' + cls + '" title="' + esc(s + (occ ? ", ocupada por " + occ.nombre : ", libre")) + '"><span class="n">' + dd + '</span>' + tags + '</div>';
  }
  h += '</div></div><div class="legend"><span>↓ llega</span><span>↑ se va</span><span><i class="dot" style="background:var(--lake-soft);border:1px solid var(--lake)"></i>noche ocupada</span><span><i class="dot" style="background:var(--own-soft);border:1px solid var(--own)"></i>propietarios</span></div>';
  const ms = iso(new Date(y, m, 1)), me = iso(new Date(y, m + 1, 1));
  const inMonth = all.filter(r => r.desde < me && r.hasta >= ms);
  h += '<h2>Estadías de ' + MESL[m] + '</h2>';
  if (!inMonth.length) h += '<div class="empty"><p>Sin reservas este mes.</p></div>';
  else { h += '<div class="agenda">'; inMonth.forEach(r => { h += stayHtml(r, false); }); h += '</div>'; }
  return h + '</section>';
}

function formHtml() {
  const r = S.editing, isNew = !r.id;
  let h = '<form class="form" id="form" novalidate><h2>' + (isNew ? "Nueva reserva" : "Editar reserva") + '</h2><div class="fgrid">';
  const own = isOwner(r);
  h += '<label class="f full">Tipo<select id="f-origen">' + ["Booking", "Directa", "Airbnb", "Propietarios"].map(o => '<option' + (r.origen === o ? " selected" : "") + '>' + o + '</option>').join("") + '</select></label>';
  h += '<label class="f full">' + (own ? "Quién va (ej.: Juli, mamá)" : "Nombre del huésped") + '<input type="text" id="f-nombre" maxlength="100" value="' + esc(r.nombre) + '" autocomplete="off"></label>';
  h += '<label class="f">Llega (check-in)<input type="date" id="f-desde" value="' + esc(r.desde) + '"></label>';
  h += '<label class="f">Se va (check-out)<input type="date" id="f-hasta" value="' + esc(r.hasta) + '"></label>';
  if (!own) {
    h += '<label class="f">Adultos<input type="number" inputmode="numeric" min="0" max="30" id="f-adultos" value="' + (r.adultos ?? "") + '"></label>';
    h += '<label class="f">Niños<input type="number" inputmode="numeric" min="0" max="30" id="f-ninos" value="' + (r.ninos ?? "") + '"></label>';
  }
  h += '<label class="f full">Notas (opcional)<textarea id="f-notas" maxlength="500" placeholder="Ej.: llegan tarde, traen mascota, piden cuna">' + esc(r.notas) + '</textarea></label>';
  h += '</div>' + (S.formErr ? '<p class="err" role="alert">' + esc(S.formErr) + '</p>' : "");
  h += '<div class="actions"><div class="r"><button type="submit" class="primary"' + (S.busy ? " disabled" : "") + '>Guardar</button><button type="button" id="cancel">Cancelar</button></div>';
  if (!isNew) h += '<button type="button" class="danger' + (S.confirmDel ? " sure" : "") + '" id="del">' + (S.confirmDel ? "Tocá de nuevo para borrar" : "Borrar reserva") + '</button>';
  return h + '</div></form>';
}

function accessHtml() {
  let h = '<div class="form"><h2>Acceso</h2>';
  h += '<p class="sub">Mails de Google que pueden ver la agenda (no editar). Tildá “Envía autorizaciones” para quien manda los datos a portería: solo esa persona ve los DNI.</p>';
  if (S.lectores.length) {
    h += '<ul class="emails">';
    S.lectores.forEach(e => {
      const on = S.autorizan.includes(e);
      h += '<li><span>' + esc(e) + '</span><span class="r"><label class="chk"><input type="checkbox" data-aut="' + esc(e) + '"' + (on ? " checked" : "") + (S.busy ? " disabled" : "") + '> Envía autorizaciones</label><button class="ghost small" data-rm-mail="' + esc(e) + '">Quitar</button></span></li>';
    });
    h += '</ul>';
  } else h += '<p class="sub">Todavía no agregaste a nadie.</p>';
  h += '<form class="addrow" id="addmail" novalidate><input type="email" id="newmail" placeholder="nombre@gmail.com" autocomplete="off" aria-label="Mail para dar acceso"><button class="primary" type="submit"' + (S.busy ? " disabled" : "") + '>Dar acceso</button></form>';
  if (S.accessErr) h += '<p class="err" role="alert">' + esc(S.accessErr) + '</p>';

  h += '<hr class="sep"><h3>Firma de la autorización</h3><p class="sub">Va al final del mensaje a portería.</p>';
  h += '<form class="fgrid" id="firmaform" novalidate><label class="f">Nombre<input type="text" id="fi-nombre" maxlength="100" value="' + esc(S.firma?.nombre || "") + '" autocomplete="off"></label>';
  h += '<label class="f">DNI<input type="text" inputmode="numeric" id="fi-dni" maxlength="12" value="' + esc(S.firma?.dni ? fmtDni(S.firma.dni) : "") + '" autocomplete="off"></label>';
  h += '<div class="full"><button class="primary" type="submit"' + (S.busy ? " disabled" : "") + '>Guardar firma</button></div></form>';
  return h + '<div><button id="closeaccess">Cerrar</button></div></div>';
}

// ---------- eventos ----------
function closeSheet() { S.authOpen = null; S.draft = null; S.pasteText = ""; S.reveal = false; S.toast = ""; S.sheetErr = ""; render(); }
function saveAcceso(lectores, autorizan, okMsg) {
  return run(() => setDoc(doc(db, "config", "acceso"), { lectores, autorizan: autorizan.filter(e => lectores.includes(e)) }), okMsg);
}

function bind() {
  const q = id => document.getElementById(id);
  const on = (id, fn) => { const e = q(id); if (e) e.onclick = fn; };
  on("theme", () => { const t = isDark() ? "light" : "dark"; document.documentElement.setAttribute("data-theme", t); writePref("cn-theme", t); render(); });
  on("login", login);
  on("logout", () => signOut(auth));
  on("reload", () => location.reload());
  on("m-lista", () => { S.mode = "lista"; writePref("cn-mode", "lista"); render(); });
  on("m-mes", () => { S.mode = "mes"; writePref("cn-mode", "mes"); render(); });
  on("prev", () => { S.view.m--; if (S.view.m < 0) { S.view.m = 11; S.view.y--; } render(); });
  on("next", () => { S.view.m++; if (S.view.m > 11) { S.view.m = 0; S.view.y++; } render(); });
  on("add", () => { S.editing = { id: null, nombre: "", desde: "", hasta: "", adultos: null, ninos: null, origen: "Booking", notas: "" }; S.formErr = ""; S.confirmDel = false; S.showAccess = false; render(); q("f-nombre")?.focus(); });
  on("access", () => { S.showAccess = !S.showAccess; S.accessErr = ""; render(); });
  on("closeaccess", () => { S.showAccess = false; render(); });
  on("cancel", () => { S.editing = null; S.formErr = ""; render(); });
  on("seed", () => {
    if (S.reservas.length) return;
    run(async () => {
      const b = writeBatch(db);
      RESERVAS_INICIALES.forEach(r => b.set(doc(collection(db, "reservas")), r));
      await b.commit();
    }, "Reservas cargadas.").catch(() => {});
  });
  document.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const r = S.reservas.find(x => x.id === b.dataset.edit); if (!r) return;
    S.editing = { ...r }; S.formErr = ""; S.confirmDel = false; S.showAccess = false; render(); window.scrollTo({ top: 0 });
  });
  on("del", () => {
    if (!S.confirmDel) { readForm(); S.confirmDel = true; render(); return; }
    const id = S.editing.id;
    run(async () => {
      const b = writeBatch(db);
      b.delete(doc(db, "reservas", id));
      b.delete(doc(db, "fichas", id)); // los datos de autorización se van con la reserva
      await b.commit();
    }, "Reserva borrada.").then(() => { S.editing = null; render(); }).catch(() => {});
  });
  const fo = q("f-origen");
  if (fo) fo.onchange = () => { readForm(); S.formErr = ""; render(); q("f-nombre")?.focus(); };
  const f = q("form");
  if (f) f.onsubmit = e => {
    e.preventDefault(); readForm();
    const err = validate(S.editing); if (err) { S.formErr = err; render(); return; }
    const { id, ...data } = S.editing;
    run(() => id ? setDoc(doc(db, "reservas", id), data) : addDoc(collection(db, "reservas"), data), "Reserva guardada.")
      .then(() => { S.editing = null; S.formErr = ""; render(); }).catch(() => {});
  };

  // Acceso
  document.querySelectorAll("[data-rm-mail]").forEach(b => b.onclick = () => {
    const next = S.lectores.filter(e => e !== b.dataset.rmMail);
    saveAcceso(next, S.autorizan, "Acceso quitado.").catch(() => {});
  });
  document.querySelectorAll("[data-aut]").forEach(c => c.onchange = () => {
    const e = c.dataset.aut;
    const next = c.checked ? [...new Set([...S.autorizan, e])] : S.autorizan.filter(x => x !== e);
    saveAcceso(S.lectores, next, c.checked ? e + " ahora ve y envía autorizaciones." : e + " ya no ve los DNI.").catch(() => {});
  });
  const am = q("addmail");
  if (am) am.onsubmit = e => {
    e.preventDefault();
    const v = q("newmail").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { S.accessErr = "Ese mail no parece válido."; render(); return; }
    if (v === EDITOR || S.lectores.includes(v)) { S.accessErr = "Ese mail ya tiene acceso."; render(); return; }
    S.accessErr = "";
    saveAcceso([...S.lectores, v], S.autorizan, "Acceso agregado para " + v + ".").catch(() => {});
  };
  const ff = q("firmaform");
  if (ff) ff.onsubmit = e => {
    e.preventDefault();
    const nombre = q("fi-nombre").value.trim(), dni = digits(q("fi-dni").value);
    if (!nombre) { S.accessErr = "Falta el nombre de la firma."; render(); return; }
    if (!okDni(dni)) { S.accessErr = "El DNI de la firma tiene que tener 7 u 8 dígitos."; render(); return; }
    S.accessErr = "";
    run(() => setDoc(doc(db, "config", "firma"), { nombre, dni }), "Firma guardada.").catch(() => {});
  };

  // Datos autorización
  document.querySelectorAll("[data-auth]").forEach(b => b.onclick = () => {
    const id = b.dataset.auth, fi = S.fichas[id];
    S.authOpen = id; S.reveal = false; S.toast = ""; S.sheetErr = ""; S.pasteText = "";
    S.draft = fi && !fi.enmascarado ? fi.personas.map(p => ({ ...p })) : [];
    sheetJustOpened = true; render(); q("closeauth")?.focus();
  });
  on("closeauth", closeSheet);
  const scrim = q("scrim");
  if (scrim) scrim.onclick = e => { if (e.target === scrim) closeSheet(); };
  on("reveal", () => { S.reveal = !S.reveal; render(); });
  on("doparse", () => {
    const txt = q("paste").value, add = parseListado(txt);
    if (!add.length) { S.sheetErr = "No encontré nombres ni DNI en el texto pegado."; render(); return; }
    S.draft = [...(S.draft || []), ...add]; S.pasteText = ""; S.sheetErr = ""; S.toast = ""; render();
  });
  const pa = q("paste"); if (pa) pa.oninput = () => { S.pasteText = pa.value; };
  document.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { S.draft.splice(+b.dataset.rm, 1); S.toast = ""; render(); });
  on("clearfi", () => { S.draft = []; S.toast = ""; render(); });
  on("savefi", () => {
    const id = S.authOpen;
    const personas = (S.draft || []).map(p => ({ nombre: String(p.nombre || "").slice(0, 100), dni: digits(p.dni).slice(0, 12) }));
    S.sheetErr = "";
    run(() => setDoc(doc(db, "fichas", id), { personas, enmascarado: false }), "Datos de autorización guardados.")
      .then(() => { S.toast = "Guardado."; render(); })
      .catch(e => { S.sheetErr = errText(e); render(); });
  });
  on("copymsg", () => {
    const ta = q("msgfallback"); const text = ta ? ta.value : "";
    const done = ok => { S.toast = ok ? "Copiado, con los DNI completos." : "No se pudo copiar. Usá “Enviar por WhatsApp”."; render(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(legacyCopy(ta)));
    else done(legacyCopy(ta));
  });
}
function legacyCopy(ta) {
  if (!ta) return false;
  try { ta.classList.remove("sr"); ta.select(); const ok = document.execCommand("copy"); ta.classList.add("sr"); return ok; } catch (e) { return false; }
}

function readForm() {
  const v = id => document.getElementById(id).value;
  const num = id => { const e = document.getElementById(id); if (!e) return null; const x = e.value.trim(); return x === "" ? null : Math.min(30, Math.max(0, parseInt(x, 10) || 0)); };
  Object.assign(S.editing, {
    nombre: v("f-nombre").trim(), desde: v("f-desde"), hasta: v("f-hasta"),
    adultos: num("f-adultos"), ninos: num("f-ninos"), origen: v("f-origen"), notas: v("f-notas").trim()
  });
  if (isOwner(S.editing)) { S.editing.adultos = null; S.editing.ninos = null; }
}
function validate(r) {
  if (!r.nombre) return isOwner(r) ? "Escribí quién va." : "Falta el nombre del huésped.";
  if (!isISODate(r.desde) || !isISODate(r.hasta)) return "Completá la fecha de llegada y la de salida.";
  if (r.hasta <= r.desde) return "La salida tiene que ser al menos un día después de la llegada.";
  const clash = S.reservas.find(x => x.id !== r.id && r.desde < x.hasta && x.desde < r.hasta);
  if (clash) return "Se superpone con " + clash.nombre + " (" + nice(clash.desde) + " al " + nice(clash.hasta) + "). Revisá las fechas.";
  return "";
}

document.addEventListener("keydown", e => { if (e.key === "Escape" && S.authOpen) closeSheet(); });
// Si el celular cambia de claro a oscuro con la página abierta, actualiza el botón.
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => render());
render();
