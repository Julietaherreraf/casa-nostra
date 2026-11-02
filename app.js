// Casa Nostra — agenda de reservas.
// Datos en Firestore (colección "reservas"); acceso con Google.
// Quién puede ver/editar lo deciden las reglas de Firestore (firestore.rules), no esta interfaz.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, onSnapshot, addDoc, setDoc, deleteDoc, writeBatch }
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
  reservas: [],
  lectores: [],
  mode: readPref("cn-mode", ["lista", "mes"], "lista"),
  view: { y: new Date().getFullYear(), m: new Date().getMonth() },
  editing: null, confirmDel: false, formErr: "",
  showAccess: false, accessErr: "",
  busy: false, msg: "", msgErr: false,
};
let unsubs = [];
let loadTimer = null;

// ---------- utilidades ----------
function readPref(k, ok, def) { try { const v = localStorage.getItem(k); return ok.includes(v) ? v : def; } catch (e) { return def; } }
function writePref(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function today() { return iso(new Date()); }
function pd(s) { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function ymd(s) { const p = s.split("-"); return [+p[0], +p[1] - 1, +p[2]]; }
function days(a, b) { return Math.round((Date.UTC(...ymd(b)) - Date.UTC(...ymd(a))) / 864e5); }
function nice(s) { const d = pd(s); return DOW[d.getDay()] + " " + d.getDate() + "/" + (d.getMonth() + 1); }
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

// ---------- auth y datos ----------
getRedirectResult(auth).catch(e => { S.msg = errText(e); S.msgErr = true; render(); });

onAuthStateChanged(auth, user => {
  unsubs.forEach(u => u()); unsubs = [];
  clearTimeout(loadTimer);
  S.user = user; S.reservas = []; S.lectores = []; S.editing = null; S.showAccess = false;
  if (!user) { S.phase = "login"; render(); return; }
  S.isEditor = (user.email || "").toLowerCase() === EDITOR;
  S.phase = "loading"; render();
  loadTimer = setTimeout(() => { if (S.phase === "loading") { S.phase = "error"; render(); } }, 10000);

  unsubs.push(onSnapshot(collection(db, "reservas"), snap => {
    clearTimeout(loadTimer);
    S.reservas = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => isISODate(r.desde) && isISODate(r.hasta));
    S.phase = "ready"; render();
  }, err => {
    clearTimeout(loadTimer);
    S.phase = (err.code || "").includes("permission-denied") ? "denied" : "error";
    render();
  }));

  if (S.isEditor) {
    unsubs.push(onSnapshot(doc(db, "config", "acceso"), snap => {
      const l = snap.exists() ? snap.data().lectores : [];
      S.lectores = Array.isArray(l) ? l : [];
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
  h += '<div class="legend"><span><i class="dot" style="background:var(--lake)"></i>Booking</span><span><i class="dot" style="background:var(--reed)"></i>Directa</span><span><i class="dot" style="background:var(--clay)"></i>Salida</span></div>';
  if (!upcoming.length) h += '<div class="empty"><p>No hay estadías próximas.' + (S.isEditor ? ' Tocá “Agregar reserva” para sumar una.' : '') + '</p></div>';
  else { h += '<div class="agenda">'; upcoming.forEach((r, i) => { h += stayHtml(r, i === 0); }); h += '</div>'; }
  return h + '</section>';
}

function stayHtml(r, isNext) {
  const d = pd(r.desde), n = days(r.desde, r.hasta), direct = r.origen !== "Booking", t = total(r);
  let h = '<article class="stay' + (isNext ? " next" : "") + '">';
  h += '<div class="date" aria-hidden="true"><span class="d">' + d.getDate() + '</span><span class="m">' + MES[d.getMonth()] + '</span><span class="w">' + DOW[d.getDay()] + '</span></div>';
  h += '<div class="card"><div class="head"><h3>' + esc(r.nombre) + '</h3><div class="pills"><span class="pill' + (direct ? " direct" : "") + '">' + esc(r.origen) + '</span><span class="pill when">' + relTxt(r.desde) + '</span></div></div>';
  h += '<div class="box"><div class="big"><span class="num">' + (t == null ? "?" : t) + '</span><span class="lbl">personas</span></div><div class="det">' + esc(peopleTxt(r)) + '</div></div>';
  h += '<ul class="facts"><li>Llega <b>' + nice(r.desde) + '</b> · se va <b class="out">' + nice(r.hasta) + '</b> · ' + n + ' noche' + (n === 1 ? "" : "s") + '</li></ul>';
  if (r.notas) h += '<p class="notes">' + esc(r.notas) + '</p>';
  if (S.isEditor && !S.editing) h += '<div><button class="ghost" data-edit="' + esc(r.id) + '">Editar reserva</button></div>';
  return h + '</div></article>';
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
    const cls = "cell" + (occ ? " occ" : "") + (occ && occ.origen !== "Booking" ? " direct" : "") + (s === td ? " today" : "");
    let tags = "";
    if (dep) tags += '<span class="tag outtag">↑ ' + esc(first(dep.nombre)) + '</span>';
    if (arr) tags += '<span class="tag in">↓ ' + esc(first(arr.nombre)) + '</span>';
    h += '<div class="' + cls + '" title="' + esc(s + (occ ? ", ocupada por " + occ.nombre : ", libre")) + '"><span class="n">' + dd + '</span>' + tags + '</div>';
  }
  h += '</div></div><div class="legend"><span>↓ llega</span><span>↑ se va</span><span><i class="dot" style="background:var(--lake-soft);border:1px solid var(--lake)"></i>noche ocupada</span></div>';
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
  h += '<label class="f full">Nombre del huésped<input type="text" id="f-nombre" maxlength="100" value="' + esc(r.nombre) + '" autocomplete="off"></label>';
  h += '<label class="f">Llega (check-in)<input type="date" id="f-desde" value="' + esc(r.desde) + '"></label>';
  h += '<label class="f">Se va (check-out)<input type="date" id="f-hasta" value="' + esc(r.hasta) + '"></label>';
  h += '<label class="f">Adultos<input type="number" inputmode="numeric" min="0" max="30" id="f-adultos" value="' + (r.adultos ?? "") + '"></label>';
  h += '<label class="f">Niños<input type="number" inputmode="numeric" min="0" max="30" id="f-ninos" value="' + (r.ninos ?? "") + '"></label>';
  h += '<label class="f full">Origen<select id="f-origen">' + ["Booking", "Directa", "Airbnb"].map(o => '<option' + (r.origen === o ? " selected" : "") + '>' + o + '</option>').join("") + '</select></label>';
  h += '<label class="f full">Notas (opcional)<textarea id="f-notas" maxlength="500" placeholder="Ej.: llegan tarde, traen mascota, piden cuna">' + esc(r.notas) + '</textarea></label>';
  h += '</div>' + (S.formErr ? '<p class="err" role="alert">' + esc(S.formErr) + '</p>' : "");
  h += '<div class="actions"><div class="r"><button type="submit" class="primary"' + (S.busy ? " disabled" : "") + '>Guardar</button><button type="button" id="cancel">Cancelar</button></div>';
  if (!isNew) h += '<button type="button" class="danger' + (S.confirmDel ? " sure" : "") + '" id="del">' + (S.confirmDel ? "Tocá de nuevo para borrar" : "Borrar reserva") + '</button>';
  return h + '</div></form>';
}

function accessHtml() {
  let h = '<div class="form"><h2>Quién puede ver la agenda</h2><p class="sub">Mails de Google que pueden entrar a ver (no editar). Vos siempre tenés acceso.</p>';
  if (S.lectores.length) {
    h += '<ul class="emails">';
    S.lectores.forEach(e => { h += '<li><span>' + esc(e) + '</span><button class="ghost" data-rm="' + esc(e) + '">Quitar</button></li>'; });
    h += '</ul>';
  } else h += '<p class="sub">Todavía no agregaste a nadie.</p>';
  h += '<form class="addrow" id="addmail" novalidate><input type="email" id="newmail" placeholder="nombre@gmail.com" autocomplete="off" aria-label="Mail para dar acceso"><button class="primary" type="submit"' + (S.busy ? " disabled" : "") + '>Dar acceso</button></form>';
  if (S.accessErr) h += '<p class="err" role="alert">' + esc(S.accessErr) + '</p>';
  return h + '<div><button id="closeaccess">Cerrar</button></div></div>';
}

// ---------- eventos ----------
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
  document.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => {
    const next = S.lectores.filter(e => e !== b.dataset.rm);
    run(() => setDoc(doc(db, "config", "acceso"), { lectores: next }), "Acceso quitado.").catch(() => {});
  });
  on("del", () => {
    if (!S.confirmDel) { readForm(); S.confirmDel = true; render(); return; }
    const id = S.editing.id;
    run(() => deleteDoc(doc(db, "reservas", id)), "Reserva borrada.").then(() => { S.editing = null; render(); }).catch(() => {});
  });
  const f = q("form");
  if (f) f.onsubmit = e => {
    e.preventDefault(); readForm();
    const err = validate(S.editing); if (err) { S.formErr = err; render(); return; }
    const { id, ...data } = S.editing;
    const p = id ? setDoc(doc(db, "reservas", id), data) : addDoc(collection(db, "reservas"), data);
    run(() => p, "Reserva guardada.").then(() => { S.editing = null; S.formErr = ""; render(); }).catch(() => {});
  };
  const am = q("addmail");
  if (am) am.onsubmit = e => {
    e.preventDefault();
    const v = q("newmail").value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { S.accessErr = "Ese mail no parece válido."; render(); return; }
    if (v === EDITOR || S.lectores.includes(v)) { S.accessErr = "Ese mail ya tiene acceso."; render(); return; }
    S.accessErr = "";
    run(() => setDoc(doc(db, "config", "acceso"), { lectores: [...S.lectores, v] }), "Acceso agregado para " + v + ".").catch(() => {});
  };
}

function readForm() {
  const v = id => document.getElementById(id).value;
  const num = id => { const x = v(id).trim(); return x === "" ? null : Math.min(30, Math.max(0, parseInt(x, 10) || 0)); };
  Object.assign(S.editing, {
    nombre: v("f-nombre").trim(), desde: v("f-desde"), hasta: v("f-hasta"),
    adultos: num("f-adultos"), ninos: num("f-ninos"), origen: v("f-origen"), notas: v("f-notas").trim()
  });
}
function validate(r) {
  if (!r.nombre) return "Falta el nombre del huésped.";
  if (!isISODate(r.desde) || !isISODate(r.hasta)) return "Completá la fecha de llegada y la de salida.";
  if (r.hasta <= r.desde) return "La salida tiene que ser al menos un día después de la llegada.";
  const clash = S.reservas.find(x => x.id !== r.id && r.desde < x.hasta && x.desde < r.hasta);
  if (clash) return "Se superpone con " + clash.nombre + " (" + nice(clash.desde) + " al " + nice(clash.hasta) + "). Revisá las fechas.";
  return "";
}

// Si el celular cambia de claro a oscuro con la página abierta, actualiza el botón.
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => render());
render();
