import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, getDocs, collection, updateDoc, deleteDoc, onSnapshot, addDoc, writeBatch, query, where, arrayUnion, arrayRemove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const app = initializeApp({
  apiKey: "AIzaSyCPoQ-8anpEqtozvXlJCoaxl3hOv4E5uIg",
  authDomain: "ballerapp-61517.firebaseapp.com",
  projectId: "ballerapp-61517",
  storageBucket: "ballerapp-61517.firebasestorage.app",
  messagingSenderId: "653164120828",
  appId: "1:653164120828:web:a1b24c6082b14adbfb6579"
});
const auth = getAuth(app), db = getFirestore(app);
const SUPER = "jayvannep@gmail.com";
const GUEST = "https://ui-avatars.com/api/?name=Guest&background=3b2e21&color=fff";
const NOPHOTO = "https://ui-avatars.com/api/?name=P&background=3b2e21&color=fff";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let uid = null, isAdmin = false, unsubs = [];
let users = [], custom = {}, info = {}, photos = [], msgs = [], pool = [], games = [], sel = null;
let profileKey = "", formFilled = false;

const go = id => { document.querySelectorAll(".page").forEach(p => p.classList.add("hidden")); $(id).classList.remove("hidden"); };
const stop = () => { unsubs.forEach(u => u()); unsubs = []; };
const me = () => users.find(u => u.uid === uid);
const byUid = id => users.find(u => u.uid === id);
const abbr = p => !p ? "[N/A]" : p === "GUEST" ? "[GUEST]" : `[${(p.match(/\(([^)]+)\)/) || [0, p])[1]}]`;
const badge = u => u.status !== "in" ? `<span class="na">N/A</span>` : u.isPaid ? `<span class="paid">PAID</span>` : `<span class="unpaid">UNPAID</span>`;
const dateKey = () => info.dateKey || new Date().toISOString().slice(0, 10);
const yearCount = u => (u.attendedDates || []).filter(d => d.startsWith(String(new Date().getFullYear()))).length;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function shrink(file, max, q) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = () => rej(new Error("Could not read that image."));
    img.src = url;
  });
}

/* ---------- auth ---------- */
onAuthStateChanged(auth, async user => {
  stop(); isAdmin = false; users = []; formFilled = false; profileKey = "";
  if (!user) { uid = null; go("login-page"); return; }
  uid = user.uid;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (!snap.exists()) { $("reg-name").value = user.displayName || ""; go("signup-page"); return; }
    const d = snap.data();
    if (d.isBanned) { alert("Account restricted: " + (d.banReason || "Violated club policies.")); signOut(auth); return; }
    isAdmin = user.email === SUPER || (await getDoc(doc(db, "admins", user.email))).exists();
    if (!d.isApproved && !isAdmin) { go("pending-page"); return; }
    $("admin-nav").classList.toggle("hidden", !isAdmin);
    $("super").classList.toggle("hidden", user.email !== SUPER);
    $("swap-hint").classList.toggle("hidden", !isAdmin);
    $("auto-btn").classList.toggle("hidden", !isAdmin);
    go("dashboard-page");
    listen(user); if (user.email === SUPER) loadAdmins();
  } catch (e) { alert("Could not load your account: " + e.message); }
});

function listen(user) {
  unsubs.push(onSnapshot(doc(db, "settings", "game_info"), s => {
    info = s.data() || {};
    $("v-date").textContent = info.date || "TBA"; $("v-time").textContent = info.time || "TBA";
    $("v-venue").textContent = info.venue || "TBA"; $("v-notice").textContent = info.announcement || "No announcements posted.";
    if (isAdmin && !formFilled) {
      formFilled = true;
      $("s-key").value = info.dateKey || ""; $("s-date").value = info.date || ""; $("s-time").value = info.time || "";
      $("s-venue").value = info.venue || ""; $("s-msg").value = info.announcement || "";
      if (info.startMinutes != null) $("s-start").value = hhmm(info.startMinutes);
    }
    renderMatches();
  }));
  unsubs.push(onSnapshot(doc(db, "settings", "custom_matches"), s => { custom = s.data() || {}; renderMatches(); }));
  unsubs.push(onSnapshot(collection(db, "photos"), s => { photos = s.docs.map(d => ({ id: d.id, ...d.data() })); renderGallery(); }));
  unsubs.push(onSnapshot(collection(db, "users"), s => {
    users = s.docs.map(d => d.data());
    pool = buildPool(); renderProfile(); renderRoster(); renderBoard(); renderMatches(); if (isAdmin) { renderAdminUsers(); renderUnpaid(); }
  }));
  const q = isAdmin ? collection(db, "messages") : query(collection(db, "messages"), where("senderUid", "==", user.uid));
  unsubs.push(onSnapshot(q, s => { msgs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")); renderMsgs(); }));
}

/* ---------- pool: players at the venue go first, then by check-in time ---------- */
function buildPool() {
  const p = [];
  users.filter(u => u.status === "in" && (u.isApproved || u.email === SUPER) && !u.isBanned)
    .sort((a, b) => (b.arrived ? 1 : 0) - (a.arrived ? 1 : 0)
      || (a.arrived ? (a.arrivedAt || 0) - (b.arrivedAt || 0) : (a.checkedInAt || 0) - (b.checkedInAt || 0))
      || String(a.name).localeCompare(String(b.name)))
    .forEach(u => {
      p.push({ id: u.uid, uid: u.uid, name: u.name, pos: u.position || "", photo: u.photoURL, paid: u.isPaid, arrived: !!u.arrived });
      (u.guests || []).forEach((g, i) => p.push({ id: `${u.uid}:g${i}`, name: `${g} (${u.name}'s guest)`, pos: "GUEST", photo: GUEST, paid: u.isPaid, arrived: !!u.arrived }));
    });
  return p;
}

function renderRoster() {
  $("roster").innerHTML = !pool.length ? `<li class="muted">No one has checked in yet.</li>` : pool.map(p => `
    <li><div class="row"><img class="av" src="${esc(p.photo || NOPHOTO)}" width="30" height="30" alt="">
    <span><strong>${esc(p.name)}</strong><span class="pos">${esc(p.pos)}</span>${p.arrived ? `<i class="dot" title="At the venue"></i>` : ""}</span></div>
    <div class="row">${p.paid ? `<span class="paid">PAID</span>` : `<span class="unpaid">UNPAID</span>`}
    ${isAdmin && p.uid ? `<button class="btn-o s ${p.arrived ? "bad" : "ok"}" data-act="arrive" data-id="${esc(p.uid)}">${p.arrived ? "Undo" : "Arrived"}</button>` : ""}</div></li>`).join("");
}

function renderBoard() {
  const top = users.map(u => ({ n: u.name, c: yearCount(u) })).filter(x => x.c > 0).sort((a, b) => b.c - a.c).slice(0, 5);
  $("board").innerHTML = top.length ? top.map(x => `<li><span>${esc(x.n)}</span><b>${x.c}</b></li>`).join("") : `<li class="muted">No attendance recorded yet.</li>`;
}

/* ---------- games ---------- */
function renderMatches() {
  const box = $("matches"); games = [];
  if (pool.length < 5) { box.innerHTML = `<p class="muted sm" style="margin-top:8px">Need at least 5 players to start. Right now: ${pool.length}.</p>`; return; }
  const byId = Object.fromEntries(pool.map(p => [p.id, p]));
  const base = info.startMinutes ?? 18 * 60;
  let rest = [...pool], n = 0, html = "";
  while (rest.length && n < 8) {
    let g = rest.slice(0, 10); rest = rest.slice(10);
    if (g.length < 10) g = g.concat(pool.filter(p => !g.includes(p)).slice(0, 10 - g.length));
    let A = g.slice(0, 5), B = g.slice(5, 10);
    const c = custom[`game_${n + 1}`];
    if (c) { A = (c.teamA || []).map(i => byId[i]).filter(Boolean); B = (c.teamB || []).map(i => byId[i]).filter(Boolean); }
    games.push({ A, B });
    const m = base + n * 45, h = Math.floor(m / 60) % 24;
    const t = `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
    const list = (arr, k) => arr.map((p, i) => {
      const on = sel && sel.g === n && sel.t === k && sel.i === i;
      const inner = `${esc(p.name)}<span class="pos">${esc(abbr(p.pos))}</span>${p.arrived ? `<i class="dot" title="At the venue"></i>` : ""}`;
      return `<li>${isAdmin ? `<button class="slot${on ? " on" : ""}" data-act="pick" data-id="${n}:${k}:${i}">${inner}</button>` : `<span class="slot">${inner}</span>`}</li>`;
    }).join("");
    html += `<div class="game"><div class="game-h"><span class="display">Game ${n + 1}</span><span class="tip">Tip-off ${t}</span></div>
      <div class="teams"><div class="team"><h4>Team A</h4><ol>${list(A, "A")}</ol></div><div class="team b"><h4>Team B</h4><ol>${list(B, "B")}</ol></div></div></div>`;
    n++;
  }
  box.innerHTML = html;
}

/* ---------- other renders ---------- */
function renderProfile() {
  const d = me(); if (!d) return;
  const key = JSON.stringify([d.name, d.height, d.position, d.photoURL, d.status, d.isPaid, d.warning, d.arrived, yearCount(d), isAdmin]);
  if (key === profileKey) return; profileKey = key;
  const positions = ["Point Guard (PG)", "Shooting Guard (SG)", "Small Forward (SF)", "Power Forward (PF)", "Center (C)"];
  $("profile").innerHTML = `
    ${d.warning ? `<div class="alert"><strong>Account warning</strong><br>${esc(d.warning)}</div>` : ""}
    <div class="row between"><div class="row"><img class="av" src="${esc(d.photoURL || NOPHOTO)}" width="58" height="58" alt="" style="border-color:var(--ball)">
      <div><h3 class="display">${esc(d.name)}</h3><p class="muted sm">${esc(d.position)} | ${esc(d.height || "N/A")}</p></div></div>${badge(d)}</div>
    <div class="stat"><b>${yearCount(d)}</b><span class="muted sm">games played in ${new Date().getFullYear()}</span></div>
    ${isAdmin && d.status === "in" ? `<button class="btn-o s ${d.isPaid ? "bad" : "ok"}" data-act="selfPay">${d.isPaid ? "Mark myself unpaid" : "Mark myself paid"}</button>` : ""}
    <div style="margin-top:10px"><label>Update photo</label><input type="file" id="self-photo" accept="image/*">
    <label>Height (ft'in")</label><input id="self-h" value="${esc(d.height || "")}">
    <label>Position</label><select id="self-p">${positions.map(p => `<option ${p === d.position ? "selected" : ""}>${p}</option>`).join("")}</select>
    <button class="btn" data-act="saveProfile">Save profile</button></div>`;
}

function renderGallery() {
  $("gallery").innerHTML = photos.map(p => `<div class="photo"><img src="${esc(p.url)}" alt="Game photo">
    <div class="acts"><a href="${esc(p.url)}" download="photo.jpg">Save</a>${isAdmin ? `<button class="btn s" style="background:#dc2626;color:#fff" data-act="delPhoto" data-id="${esc(p.id)}">Delete</button>` : ""}</div></div>`).join("");
}

function renderMsgs() {
  const replies = m => (m.replies || []).map(r => `<div class="reply"><strong>${esc(r.sender)}:</strong> ${esc(r.text)}</div>`).join("");
  $("my-msgs").innerHTML = msgs.filter(m => m.senderUid === uid).map(m => `<div class="sub sm"><div class="row between"><span><strong>You:</strong> ${esc(m.text)}</span>
    <button class="btn-o s bad" data-act="delMsg" data-id="${esc(m.id)}">Delete</button></div>${replies(m)}</div>`).join("");
  if (!isAdmin) return;
  const open = document.activeElement && document.activeElement.id;
  $("admin-msgs").innerHTML = msgs.map(m => `<div class="sub"><div class="row between"><p class="sm" style="color:var(--ball);font-weight:700">${esc(m.senderName)} (${esc(m.senderEmail)})</p>
    <button class="btn-o s bad" data-act="delMsg" data-id="${esc(m.id)}">Delete</button></div><p class="sm" style="margin:6px 0">${esc(m.text)}</p>${replies(m)}
    <div class="row" style="margin-top:8px"><input id="reply-${esc(m.id)}" placeholder="Type reply..." style="margin:0;padding:5px 8px"><button class="btn s" data-act="reply" data-id="${esc(m.id)}">Reply</button></div></div>`).join("");
  if (open && $(open)) $(open).focus();
}

function renderAdminUsers() {
  $("admin-users").innerHTML = users.filter(u => u.email !== SUPER).map(u => `<div class="sub"><div class="row between" style="margin-bottom:8px">
    <div class="row"><img class="av" src="${esc(u.photoURL || NOPHOTO)}" width="36" height="36" alt="">
    <div><p class="sm" style="font-weight:700">${esc(u.name)} <span class="muted xs">(${esc(u.email)})</span></p>
    <p class="muted xs">${esc(u.position)} | ${esc(u.height || "N/A")} | ${u.status === "in" ? "IN" : "OUT"} | ${yearCount(u)} games this year</p></div></div>${badge(u)}</div>
    <div class="row wrap" style="gap:4px">
    ${!u.isApproved ? `<button class="btn s" data-act="approve" data-id="${esc(u.uid)}">Approve</button>` : ""}
    ${u.status === "in" ? `<button class="btn-o s ${u.arrived ? "bad" : "ok"}" data-act="arrive" data-id="${esc(u.uid)}">${u.arrived ? "Undo arrival" : "Arrived"}</button>
    <button class="btn-o s ${u.isPaid ? "bad" : "ok"}" data-act="pay" data-id="${esc(u.uid)}">${u.isPaid ? "Set unpaid" : "Set paid"}</button>` : ""}
    <button class="btn-o s" data-act="editUser" data-id="${esc(u.uid)}">Edit</button>
    ${yearCount(u) ? `<button class="btn-o s warn" data-act="resetYear" data-id="${esc(u.uid)}">Reset games</button>` : ""}
    <button class="btn-o s ${u.status === "in" ? "bad" : "ok"}" data-act="force" data-id="${esc(u.uid)}">${u.status === "in" ? "Cancel" : "Force play"}</button>
    <button class="btn-o s" data-act="warn" data-id="${esc(u.uid)}">Warn</button>
    ${u.warning ? `<button class="btn-o s warn" data-act="clearWarn" data-id="${esc(u.uid)}">Clear warning</button>` : ""}
    <button class="btn-o s bad" data-act="ban" data-id="${esc(u.uid)}">${u.isBanned ? "Unblock" : "Block"}</button></div></div>`).join("");
}


/* ---------- unpaid list (checked-in players who haven't paid; guests count under their host) ---------- */
const unpaidUsers = () => users.filter(u => u.status === "in" && !u.isPaid && !u.isBanned && (u.isApproved || u.email === SUPER));
function renderUnpaid() {
  const list = unpaidUsers();
  $("unpaid-count").textContent = list.length ? `(${list.length})` : "";
  $("unpaid-list").innerHTML = list.length ? list.map(u => {
    const g = (u.guests || []).length;
    return `<li><span><strong>${esc(u.name)}</strong>${g ? `<span class="pos">+${g} guest${g > 1 ? "s" : ""}</span>` : ""}${u.arrived ? `<i class="dot" title="At the venue"></i>` : ""}</span>
    <button class="btn s" data-act="pay" data-id="${esc(u.uid)}">Mark paid</button></li>`;
  }).join("") : `<li class="muted">Everyone who checked in has paid.</li>`;
}

async function loadAdmins() {
  const s = await getDocs(collection(db, "admins"));
  $("admins").innerHTML = s.docs.map(d => `<li style="margin-bottom:4px">${esc(d.id)} <button class="btn-o s bad" data-act="rmAdmin" data-id="${esc(d.id)}">Remove</button></li>`).join("");
}

/* ---------- actions ---------- */
const upd = (id, data) => updateDoc(doc(db, "users", id), data);
const A = {
  login: () => signInWithPopup(auth, new GoogleAuthProvider()).catch(e => alert("Login failed: " + e.message)),
  logout: () => signOut(auth),
  nav: id => go(id),
  attend: async s => {
    let guests = [];
    if (s === "in") {
      guests = $("guests").value.split(",").map(x => x.trim()).filter(Boolean);
      if (guests.length > 4) return alert("Maximum of 4 guests per player.");
    }
    await upd(uid, { status: s, guests, checkedInAt: s === "in" ? Date.now() : 0 });
  },
  selfPay: () => upd(uid, { isPaid: !me().isPaid }),
  saveProfile: async () => {
    const data = { height: $("self-h").value.trim(), position: $("self-p").value };
    const f = $("self-photo").files[0];
    try { if (f) data.photoURL = await shrink(f, 256, .8); await upd(uid, data); profileKey = ""; renderProfile(); alert("Profile updated."); }
    catch (e) { alert(e.message); }
  },
  sendMsg: async () => {
    const text = $("msg-in").value.trim(); if (!text) return;
    const u = auth.currentUser;
    await addDoc(collection(db, "messages"), { senderUid: uid, senderName: me()?.name || u.displayName || "Player", senderEmail: u.email, text, replies: [], createdAt: new Date().toISOString() });
    $("msg-in").value = "";
  },
  delMsg: async id => { if (confirm("Delete this message?")) await deleteDoc(doc(db, "messages", id)); },
  reply: async id => {
    const t = $("reply-" + id).value.trim(); if (!t) return;
    await updateDoc(doc(db, "messages", id), { replies: arrayUnion({ sender: auth.currentUser.email === SUPER ? "Super Admin" : "Admin", text: t, createdAt: new Date().toISOString() }) });
  },
  copyUnpaid: async () => {
    const list = unpaidUsers();
    if (!list.length) return alert("No unpaid players.");
    const text = `Unpaid (${info.date || "this game"}):\n` + list.map((u, i) => `${i + 1}. ${u.name}${(u.guests || []).length ? ` +${u.guests.length} guest(s)` : ""}`).join("\n");
    try { await navigator.clipboard.writeText(text); alert("List copied."); } catch { prompt("Copy this list:", text); }
  },
  resetYear: async id => {
    const u = byUid(id), y = String(new Date().getFullYear());
    if (!confirm(`Reset ${u.name}'s ${y} games (${yearCount(u)}) to 0? Other years are kept.`)) return;
    await upd(id, { attendedDates: (u.attendedDates || []).filter(d => !d.startsWith(y)) });
  },
  approve: id => upd(id, { isApproved: true }),
  pay: id => upd(id, { isPaid: !byUid(id).isPaid }),
  /* Arrived: moves the player to the front of the queue and counts the game toward their yearly total */
  arrive: id => {
    const on = !byUid(id).arrived, key = dateKey();
    return upd(id, on ? { arrived: true, arrivedAt: Date.now(), attendedDates: arrayUnion(key) } : { arrived: false, arrivedAt: 0, attendedDates: arrayRemove(key) });
  },
  force: id => { const out = byUid(id).status === "in"; return upd(id, { status: out ? "out" : "in", guests: [], checkedInAt: out ? 0 : Date.now() }); },
  warn: async id => { const r = prompt("Warning reason:"); if (r) await upd(id, { warning: r }); },
  clearWarn: id => upd(id, { warning: "" }),
  ban: async id => {
    const ban = !byUid(id).isBanned;
    await upd(id, { isBanned: ban, banReason: ban ? (prompt("Reason for block:") || "Rule violation") : "" });
  },
  editUser: async id => {
    const u = byUid(id);
    const name = prompt("Player name:", u.name); if (name === null) return;
    const height = prompt("Height (ft'in\"):", u.height || ""); if (height === null) return;
    const position = prompt("Position (e.g. Point Guard (PG)):", u.position || ""); if (position === null) return;
    await upd(id, { name: name.trim() || u.name, height, position });
  },
  /* Tap a player, then tap another to swap them. Works across teams and across games. */
  pick: async s => {
    const [g, t, i] = s.split(":"), k = { g: +g, t, i: +i };
    if (!sel) { sel = k; return renderMatches(); }
    if (sel.g === k.g && sel.t === k.t && sel.i === k.i) { sel = null; return renderMatches(); }
    const L = games.map(x => ({ A: [...x.A], B: [...x.B] }));
    const a = L[sel.g][sel.t], b = L[k.g][k.t];
    [a[sel.i], b[k.i]] = [b[k.i], a[sel.i]];
    const touched = [...new Set([sel.g, k.g])], out = {};
    for (const n of touched) {
      const ids = [...L[n].A, ...L[n].B].map(p => p.id);
      if (new Set(ids).size !== ids.length) { sel = null; renderMatches(); return alert("That swap would put the same player twice in one game."); }
      out[`game_${n + 1}`] = { teamA: L[n].A.map(p => p.id), teamB: L[n].B.map(p => p.id) };
    }
    sel = null;
    await setDoc(doc(db, "settings", "custom_matches"), out, { merge: true });
  },
  resetAuto: async () => { if (confirm("Clear all manual swaps and go back to automatic teams?")) { sel = null; await deleteDoc(doc(db, "settings", "custom_matches")); } },
  upload: async () => {
    const f = $("photo-in").files[0]; if (!f) return alert("Select an image first.");
    try { await setDoc(doc(db, "photos", String(Date.now())), { url: await shrink(f, 1000, .7), createdAt: new Date().toISOString() }); $("photo-in").value = ""; }
    catch (e) { alert(e.message); }
  },
  delPhoto: async id => { if (confirm("Delete this photo?")) await deleteDoc(doc(db, "photos", id)); },
  addAdmin: async () => {
    const email = $("new-admin").value.trim().toLowerCase(); if (!email) return;
    await setDoc(doc(db, "admins", email), { addedAt: new Date().toISOString() });
    $("new-admin").value = ""; loadAdmins();
  },
  rmAdmin: async id => { await deleteDoc(doc(db, "admins", id)); loadAdmins(); }
};

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || !A[b.dataset.act]) return;
  try { await A[b.dataset.act](b.dataset.id); } catch (err) { alert("Something went wrong: " + err.message); }
});

$("signup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const u = auth.currentUser; if (!u) return;
  try {
    await setDoc(doc(db, "users", u.uid), {
      uid: u.uid, name: $("reg-name").value.trim(), email: u.email, height: $("reg-h").value.trim(), position: $("reg-p").value,
      photoURL: u.photoURL || "", status: "out", isPaid: false, guests: [], checkedInAt: 0, arrived: false, arrivedAt: 0, attendedDates: [],
      isApproved: u.email === SUPER, isBanned: false, warning: "", createdAt: new Date().toISOString()
    });
    alert(u.email === SUPER ? "Registration complete." : "Profile submitted. Please wait for admin approval.");
    location.reload();
  } catch (err) { alert("Could not save profile: " + err.message); }
});

$("sched-form").addEventListener("submit", async e => {
  e.preventDefault();
  if (!confirm("Saving the schedule resets attendance, payments, arrivals and manual teams. Yearly game counts are kept. Continue?")) return;
  try {
    const [h, m] = ($("s-start").value || "18:00").split(":").map(Number);
    const b = writeBatch(db);
    b.set(doc(db, "settings", "game_info"), { dateKey: $("s-key").value, date: $("s-date").value, time: $("s-time").value, venue: $("s-venue").value, announcement: $("s-msg").value, startMinutes: h * 60 + m });
    b.delete(doc(db, "settings", "custom_matches"));
    await b.commit();
    const all = (await getDocs(collection(db, "users"))).docs;
    for (let i = 0; i < all.length; i += 400) {
      const bb = writeBatch(db);
      all.slice(i, i + 400).forEach(d => bb.update(d.ref, { status: "out", isPaid: false, guests: [], checkedInAt: 0, arrived: false, arrivedAt: 0 }));
      await bb.commit();
    }
    alert("Schedule updated.");
  } catch (err) { alert("Error: " + err.message); }
});
