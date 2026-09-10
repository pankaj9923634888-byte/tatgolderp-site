/* Shell: sign in with an e-mail code, work out who you are, show the right tabs. */
(function () {
  "use strict";
  const cfg = window.HR_CONFIG || {};
  window.$ = sel => document.querySelector(sel);
  window.esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  window.dmy = iso => /^\d{4}-\d{2}-\d{2}/.test(String(iso || "")) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : (iso || "—");
  window.amount = n => "₹" + Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  window.clockTime = value => value ? new Date(value).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "—";

  window.sb = null;
  window.me = null;     // { role, name, email, employeeLinked, ... }
  window.tab = null;
  window.SCREENS = {};  // filled by hr.js / attendance.js

  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  const signinError = message => { const box = $("#signin-error"); box.textContent = message; box.hidden = !message; };

  // ---------------------------------------------------------------- navigation
  window.buildNav = function () {
    const keys = Object.keys(SCREENS).filter(k => SCREENS[k].roles.includes(me.role) && (!SCREENS[k].needsEmployee || me.employeeLinked));
    $("#tabbar").innerHTML = keys.map(k =>
      `<button class="tabbtn" type="button" data-t="${k}"><span class="ti">${SCREENS[k].icon}</span><span class="tl">${esc(SCREENS[k].label)}</span></button>`).join("");
    $("#tabbar").querySelectorAll(".tabbtn").forEach(b => { b.onclick = () => go(b.dataset.t); });
    if (!keys.length) {
      $("#main").innerHTML = `<div class="panel"><h3>Nothing assigned yet</h3><p class="dim">You are signed in as ${esc(me.email)}, but no employee record is linked to this login. Ask the owner to link your TatGold username to your employee record, then refresh.</p></div>`;
      return;
    }
    go(keys.includes(tab) ? tab : keys[0]);
  };

  window.go = async function (key) {
    tab = key;
    document.querySelectorAll(".tabbtn").forEach(b => b.classList.toggle("on", b.dataset.t === key));
    $("#screen-name").textContent = SCREENS[key]?.label || "";
    document.querySelector("#hr-dialog")?.close();
    window.scrollTo({ top: 0 });
    try { await SCREENS[key].open(); }
    catch (error) { $("#main").innerHTML = `<div class="panel"><h3>Could not open ${esc(SCREENS[key].label)}</h3><p class="err">${esc(error.message || error)}</p></div>`; }
  };

  // ---------------------------------------------------------------- session
  async function loadMe() {
    const { data, error } = await sb.rpc("me");
    if (error) throw error;
    return data;
  }

  async function enterApp() {
    show("#boot", false); show("#signin", false); show("#app", true);
    $("#main").innerHTML = '<div class="empty">Loading…</div>';
    try { me = await loadMe(); }
    catch (error) {
      $("#main").innerHTML = `<div class="panel"><h3>Could not reach the HR database</h3><p class="err">${esc(error.message)}</p>
        <p class="note">If this says the function is missing, the database setup (001_hr_app.sql) has not been applied to this project yet.</p></div>`;
      return;
    }
    if (!me.authorised) {
      $("#who").textContent = me.email || "";
      $("#tabbar").innerHTML = "";
      $("#main").innerHTML = `<div class="panel"><h3>This e-mail has no access</h3>
        <p class="dim">You signed in as <b>${esc(me.email)}</b>, but it is not on the Admin list and no active employee record uses it.</p>
        <p class="note">Ask Admin to add this e-mail to your employee record, then sign out and sign in again.</p></div>`;
      return;
    }
    $("#who").textContent = `${me.name || me.email}${me.role === "ADMIN" ? " · Admin" : me.branch ? " · " + me.branch : ""}`;
    buildNav();
  }

  async function signOut() {
    await sb.auth.signOut();
    me = null; tab = null;
    show("#app", false); show("#signin", true);
    $("#email-form").hidden = false; $("#code-form").hidden = true; signinError("");
  }

  // ---------------------------------------------------------------- sign in with an e-mail code
  function wireSignIn() {
    let pendingEmail = "";
    $("#email-form").onsubmit = async event => {
      event.preventDefault(); signinError("");
      const button = event.target.querySelector("button"); button.disabled = true; button.textContent = "Sending…";
      pendingEmail = $("#email").value.trim().toLowerCase();
      const { error } = await sb.auth.signInWithOtp({ email: pendingEmail, options: { shouldCreateUser: true } });
      button.disabled = false; button.textContent = "Send sign-in code";
      if (error) { signinError(error.message); return; }
      $("#code-target").textContent = pendingEmail;
      $("#email-form").hidden = true; $("#code-form").hidden = false;
      setTimeout(() => $("#code").focus(), 50);
    };
    $("#code-back").onclick = () => { $("#code-form").hidden = true; $("#email-form").hidden = false; signinError(""); };
    $("#code-form").onsubmit = async event => {
      event.preventDefault(); signinError("");
      const button = event.target.querySelector("button"); button.disabled = true; button.textContent = "Checking…";
      const { error } = await sb.auth.verifyOtp({ email: pendingEmail, token: $("#code").value.trim(), type: "email" });
      button.disabled = false; button.textContent = "Sign in";
      if (error) { signinError(/expired|invalid/i.test(error.message) ? "That code is wrong or has expired. Ask for a new one." : error.message); return; }
      await enterApp();
    };
    $("#signout").onclick = signOut;
  }

  // ---------------------------------------------------------------- start
  const bootMessage = (title, detail) => {
    $("#boot").innerHTML = `<div class="panel" style="max-width:460px"><h3>${esc(title)}</h3><p class="dim">${esc(detail)}</p></div>`;
  };

  async function start() {
    try { await boot(); }
    catch (error) { bootMessage("The app could not start", error.message || String(error)); }
  }

  async function boot() {
    const bridge = window.parent !== window && window.parent.tatgoldHR;
    if (!bridge) { bootMessage("Open HR from TatGold ERP", "Sign in to TatGold and choose HR & Attendance."); return; }
    sb = bridge;
    $("#signout").hidden = true;
    await enterApp();

  }

  window.HRApp = { start, enterApp, signOut };
})();
