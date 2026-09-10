/* My Attendance — what an employee sees: punch in / out with a photo, their own last 30 days,
   their leave balance and applications. Salaries, payroll and other people are not reachable here. */
(function () {
  "use strict";
  const C = window.HRCore;
  let current = null;

  const photoLinks = day => [[day?.checkInPhoto, "In photo"], [day?.checkOutPhoto, "Out photo"]]
    .filter(([p]) => p)
    .map(([p, label]) => `<button class="btn ghost sm" type="button" data-photo="${esc(p)}" data-photo-title="${esc(label)}">${label}</button>`).join("");

  const STATUS_TAG = { PENDING: "warn", APPROVED: "good", REJECTED: "bad", CANCELLED: "" };
  const tagFor = text => `<span class="tag ${/^(Present|Approved|Paid leave)$/.test(text) ? "good" : /Absent|Rejected/.test(text) ? "bad" : /Half day|Pending|Not marked/.test(text) ? "warn" : ""}">${esc(text)}</span>`;

  async function open() {
    $("#main").innerHTML = '<div class="empty">Loading your attendance…</div>';
    const { data, error } = await sb.rpc("hr_my_attendance");
    if (error) throw error;
    render(data);
    sb.rpc("hr_leave_mine").then(({ data: leave, error: err }) => { if (!err && tab === "myattendance") renderLeave(leave); });
  }

  function render(data, message = "") {
    current = data;
    if (!data.linked) {
      $("#main").innerHTML = `<div class="panel"><h3>No employee record yet</h3>
        <p class="dim">Ask the owner to link your TatGold username to your employee record. Once it is there, punch-in appears here automatically.</p>
        <button class="btn ghost" id="att-retry">Check again</button></div>`;
      $("#att-retry").onclick = () => go("myattendance");
      return;
    }
    const r = data.record, started = !!r?.checkIn, finished = !!r?.checkOut;
    const blocked = data.locked || data.joined > data.today;
    const isOff = C.weekday(data.today) === data.weeklyOff;

    $("#main").innerHTML = `
      <div class="heading"><div><h2>My attendance</h2>
        <div class="dim">${esc(data.employeeName)} · ${dmy(data.today)}${data.branch ? " · " + esc(data.branch) : ""}</div></div>
        <button class="btn ghost sm" id="att-refresh" type="button">Refresh</button></div>

      <div class="panel">
        <h3>${finished ? "Done for today" : started ? "You are punched in" : isOff ? "Your weekly off" : "Start your day"}</h3>
        <p class="note">Shift ${esc(data.shiftIn)}–${esc(data.shiftOut)} · weekly off ${esc(data.weeklyOff)}${r?.status ? " · today: " + esc(r.status) : ""}</p>
        <div class="punch-times">
          <div><span>In</span><strong>${clockTime(r?.checkIn)}</strong></div>
          <div><span>Out</span><strong>${clockTime(r?.checkOut)}</strong></div>
        </div>
        <div class="camera-controls">
          <button class="btn" id="att-in" type="button" ${started || blocked ? "disabled" : ""}>Photo punch-in</button>
          <button class="btn ghost" id="att-out" type="button" ${!started || finished || blocked ? "disabled" : ""}>Photo punch-out</button>
        </div>
        <div class="photo-links" style="margin-top:12px">${photoLinks(r)}</div>
        ${isOff && !started ? `<p class="notice">Today is your weekly off. If you do come in, punch as usual — the day stays a weekly off and is not counted as work.</p>` : ""}
        ${blocked ? `<p class="notice">${data.locked ? "This month's payroll is approved, so attendance is locked. Speak to Admin." : "Your attendance starts on " + dmy(data.joined) + "."}</p>` : ""}
        <p class="camera-status" id="att-feedback" role="status" aria-live="polite">${esc(message)}</p>
        <p class="err" id="att-error" role="alert" hidden></p>
        <p class="note">For a missed punch or a correction, speak to Admin. Recorded times cannot be changed here.</p>
      </div>

      <div class="panel"><h3>Last 30 days</h3>
        ${data.history.length ? `<div class="history">${data.history.map(day => `
          <article class="day">
            <div class="when"><b>${dmy(day.date)}</b>${tagFor(day.status)}</div>
            <div><span class="label">In</span><b>${clockTime(day.checkIn)}</b></div>
            <div><span class="label">Out</span><b>${clockTime(day.checkOut)}</b></div>
            ${day.source || photoLinks(day) ? `<div class="why">${esc(day.source || "")}
              <span class="photo-links" style="margin:0">${photoLinks(day)}</span></div>` : ""}
          </article>`).join("")}</div>` : '<p class="dim">Nothing recorded yet.</p>'}
      </div>

      <div class="panel"><div class="line"><h3>Leave</h3>
        <button class="btn ghost sm" id="att-leave-apply" type="button">Apply for leave</button></div>
        <p class="note" id="att-leave-note">Loading…</p><div id="att-leave-list"></div></div>`;

    $("#att-refresh").onclick = () => go("myattendance");
    $("#att-leave-apply").onclick = () => leaveForm(data);
    $("#main").querySelectorAll("[data-photo]").forEach(b => { b.onclick = () => PunchPhotos.view(b.dataset.photo, b.dataset.photoTitle); });

    const punch = async action => {
      const inBtn = $("#att-in"), outBtn = $("#att-out"), refresh = $("#att-refresh");
      if ((action === "IN" && inBtn.disabled) || (action === "OUT" && outBtn.disabled)) return;
      inBtn.disabled = true; outBtn.disabled = true; refresh.disabled = true;
      $("#att-feedback").textContent = "Take a photo to continue…";
      $("#att-error").hidden = true;
      try {
        const updated = await PunchPhotos.captureAndPunch(action, current.employeeName);
        if (tab !== "myattendance") return;
        if (!updated) { await open(); return; }
        render(updated, action === "IN" ? "Punch-in saved." : "Punch-out saved.");
        sb.rpc("hr_leave_mine").then(({ data: leave, error }) => { if (!error) renderLeave(leave); });
      } catch (error) {
        if (tab !== "myattendance") return;
        $("#att-feedback").textContent = "";
        $("#att-error").textContent = (error.message || "Could not confirm your punch.") + " Refresh to check whether it was saved.";
        $("#att-error").hidden = false;
        refresh.disabled = false;
      }
    };
    $("#att-in").onclick = () => punch("IN");
    $("#att-out").onclick = () => punch("OUT");
  }

  function renderLeave(leave) {
    const note = $("#att-leave-note"), list = $("#att-leave-list");
    if (!note || !leave?.linked) return;
    const left = Number(leave.allowance) - Number(leave.used);
    note.textContent = `${left} earned leaves available (${leave.used} of ${leave.allowance} earned used). 2 per completed month; unused days carry forward. Sick leave: ${Number(leave.sickAllowance)-Number(leave.sickUsed)} of 3 paid days left this year.`;
    list.innerHTML = leave.requests.length ? leave.requests.slice(0, 8).map(r => `
      <div class="line"><span>${dmy(r.from)}${r.from !== r.to ? " – " + dmy(r.to) : ""} · ${r.type === "PAID" ? "Paid" : r.type === "SICK" ? "Paid sick leave" : "Unpaid"}${r.reason ? " · " + esc(r.reason) : ""}</span>
      <span class="row"><span class="tag ${STATUS_TAG[r.status] || ""}">${esc(r.status)}</span>
      ${r.status === "PENDING" ? `<button class="btn ghost sm" type="button" data-cancel="${esc(r.id)}">Withdraw</button>` : ""}</span></div>`).join("")
      : '<p class="dim">You have not applied for any leave yet.</p>';
    list.querySelectorAll("[data-cancel]").forEach(b => {
      b.onclick = async () => {
        b.disabled = true;
        const { error } = await sb.rpc("hr_leave_cancel", { p_id: b.dataset.cancel });
        if (error) { alert(error.message); b.disabled = false; return; }
        const { data } = await sb.rpc("hr_leave_mine"); renderLeave(data);
      };
    });
  }

  function leaveForm(data) {
    const el = document.createElement("dialog");
    el.id = "hr-dialog";
    el.innerHTML = `<header><h3>Apply for leave</h3><button class="btn ghost sm" type="button" data-close>Close</button></header>
      <div class="body"><form id="leave-form" class="stack">
        <label>From<input class="input" name="from" type="date" min="${esc(data.joined)}" value="${esc(data.today)}" required autocomplete="off"></label>
        <label>To<input class="input" name="to" type="date" min="${esc(data.joined)}" value="${esc(data.today)}" required autocomplete="off"></label>
        <label>Type<select class="input" name="type"><option value="PAID">Paid leave</option><option value="SICK">Paid sick leave</option><option value="UNPAID">Unpaid leave</option></select></label>
        <label>Reason<input class="input" name="reason" maxlength="200" placeholder="e.g. family function"
          autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></label>
        <p class="note">Admin approves or rejects this. Your weekly off inside the range is already off and is not counted against your leave.</p>
        <button class="btn save" type="submit">Send request</button>
      </form><p class="err" id="leave-error" role="alert" hidden></p></div>`;
    document.body.append(el); el.showModal();
    el.querySelector("[data-close]").onclick = () => el.close();
    el.addEventListener("close", () => el.remove(), { once: true });
    el.querySelector("form").onsubmit = async event => {
      event.preventDefault();
      const f = new FormData(event.currentTarget), box = el.querySelector("#leave-error");
      const button = el.querySelector("button[type=submit]");
      box.hidden = true; button.disabled = true;
      const { error } = await sb.rpc("hr_leave_apply", {
        p_from: f.get("from"), p_to: f.get("to"), p_type: f.get("type"), p_reason: f.get("reason").trim() || null });
      button.disabled = false;
      if (error) { box.textContent = error.message; box.hidden = false; return; }
      el.close();
      const { data: fresh } = await sb.rpc("hr_leave_mine"); renderLeave(fresh);
    };
  }

  SCREENS.myattendance = { icon: "◷", label: "Attendance", roles: ["ADMIN", "STAFF"], needsEmployee: true, open };
})();
