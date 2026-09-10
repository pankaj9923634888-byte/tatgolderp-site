/* Admin HR: employees, attendance, leave approvals and monthly payroll.
   Payroll money is always computed by the server; this screen displays and approves it. */
(function () {
  "use strict";
  const C = window.HRCore;
  let state = null, version = 0, busy = false;

  const clone = v => JSON.parse(JSON.stringify(v));
  const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  const findEmployee = id => state.employees.find(e => e.id === id);
  const tag = text => `<span class="tag ${/^(Active|Present|Verified|Approved|Paid leave)$/.test(text) ? "good"
    : /Expired|Absent|Rejected/.test(text) ? "bad"
    : /Renew|missing|Not set|Pending|Not marked|Draft|To review|Half day/.test(text) ? "warn" : ""}">${esc(text)}</span>`;
  const option = (values, selected) => values.map(v => `<option${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("");
  const field = (key, label, value = "", type = "text", attrs = "") =>
    `<label for="f-${key}">${label}<input class="input" id="f-${key}" name="${key}" type="${type}" value="${esc(value)}"
      autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" ${attrs}></label>`;
  const picker = (key, label, values, value) =>
    `<label for="f-${key}">${label}<select class="input" id="f-${key}" name="${key}">${option(values, value)}</select></label>`;
  const punchNote = row => row?.checkIn
    ? `In ${clockTime(row.checkIn)} · Out ${clockTime(row.checkOut)}${row.source ? " · " + row.source : ""}`
    : row?.source ? row.source : "No punch recorded today";
  const newEmployee = () => ({
    id: crypto.randomUUID(), name: "", designation: "", branch: C.branches[0], email: "", mobile: "",
    joined: C.today(), active: true, salary: "", leaveAllowance: 12,
    weeklyOff: C.RULES.weeklyOff, shiftIn: C.RULES.shiftIn, shiftOut: C.RULES.shiftOut, lateGrace: C.RULES.lateGrace,
    pf: { status: "To review", employeeAmount: 0, employerAmount: 0 },
    health: { status: "Not set", provider: "", policyNumber: "", expiry: "" },
    accident: { status: "Not set", provider: "", policyNumber: "", expiry: "" },
    documents: {} });

  // ---------------------------------------------------------------- dialog plumbing
  function dialog(title, body, wide = false) {
    document.querySelector("#hr-dialog")?.close();
    const previous = document.activeElement;
    const el = document.createElement("dialog");
    el.id = "hr-dialog"; if (wide) el.className = "wide";
    el.innerHTML = `<header><h3>${esc(title)}</h3><button class="btn ghost sm" type="button" data-close>Close</button></header>
      <div class="body">${body}<p class="err" id="hr-error" role="alert" hidden></p></div>`;
    el.querySelector("[data-close]").onclick = () => el.close();
    el.addEventListener("close", () => { el.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
    document.body.append(el); el.showModal(); return el;
  }
  function showError(el, error) {
    const box = el.querySelector("#hr-error");
    if (box) { box.textContent = error.message || String(error); box.hidden = false; }
  }
  async function run(el, action) {
    if (busy) return;
    busy = true;
    const controls = [...el.querySelectorAll("button, input, select")], was = controls.map(c => c.disabled);
    controls.forEach(c => { c.disabled = true; });
    const lock = e => e.preventDefault(); el.addEventListener("cancel", lock);
    el.querySelector("#hr-error").hidden = true;
    try { await action(); }
    catch (error) { showError(el, error); }
    finally { busy = false; el.removeEventListener("cancel", lock); controls.forEach((c, i) => { c.disabled = was[i]; }); }
  }
  async function save(next, action) {
    const { data, error } = await sb.rpc("hr_save", { p_state: next, p_version: version, p_action: action });
    if (error) throw new Error(error.code === "40001"
      ? "HR was changed in another window. Close this form, refresh and try again — nothing you saved before is lost."
      : error.message);
    state = data.state; version = Number(data.version);
    if (tab === "hr") render();
  }

  // ---------------------------------------------------------------- main screen
  async function open() {
    $("#main").innerHTML = '<div class="empty">Loading HR records…</div>';
    const { data, error } = await sb.rpc("hr_get");
    if (error) {
      const setup = /PGRST202|42883|42P01/.test(error.code || "");
      $("#main").innerHTML = `<div class="panel"><h3>${setup ? "Database setup pending" : "Could not load HR"}</h3>
        <p class="dim">${setup ? "Apply database/001_hr_app.sql and 002_storage.sql in this Supabase project's SQL editor, then refresh."
          : esc(error.message)}</p><button class="btn ghost" id="hr-retry" type="button">Try again</button></div>`;
      $("#hr-retry").onclick = () => go("hr");
      return;
    }
    state = data.state; version = Number(data.version); render();
  }

  function render() {
    const on = C.today();
    const active = state.employees.filter(e => e.active), archived = state.employees.filter(e => !e.active);
    const warnings = [];
    for (const e of active) {
      for (const [key, label] of [["health", "health insurance"], ["accident", "accident insurance"]]) {
        const s = C.policyStatus(e[key], on);
        if (s !== "Active") warnings.push(`${e.name} · ${label}: ${s.toLowerCase()}${e[key]?.expiry ? " (" + dmy(e[key].expiry) + ")" : ""}.`);
      }
      if (C.leave(state, e, on.slice(0, 4)).remaining < 0) warnings.push(`${e.name} · paid leave has gone past the yearly allowance.`);
      if (!e.email) warnings.push(`${e.name} · no TatGold login linked, so they cannot punch attendance themselves.`);
      const missed = state.attendance.filter(a => a.employeeId === e.id && a.checkIn && !a.checkOut && !a.reviewedAt && a.date < on);
      if (missed.length) warnings.push(`${e.name} · ${missed.length} day${missed.length === 1 ? "" : "s"} punched in but never out. Review before payroll.`);
    }
    const records = state.payroll.slice().sort((a, b) => b.month.localeCompare(a.month));
    const byBranch = {};
    for (const e of active) (byBranch[e.branch || "Unassigned"] ||= []).push(e);

    $("#main").innerHTML = `
      <div class="heading"><div><h2>HR</h2>
        <div class="dim">${active.length} active ${active.length === 1 ? "employee" : "employees"} · ${dmy(on)} · Admin only</div></div>
        <button class="btn ghost sm" id="hr-refresh" type="button">Refresh</button></div>

      <div class="actions">
        <button class="btn" id="hr-add" type="button">＋ Add employee</button>
        <button class="btn ghost" id="hr-attendance" type="button" ${!active.length ? "disabled" : ""}>Attendance</button>
        <button class="btn ghost" id="hr-payroll" type="button" ${!active.length ? "disabled" : ""}>Run payroll</button>
        <button class="btn ghost" id="hr-ask" type="button">Ask HR</button>
      </div>

      ${active.length ? Object.keys(byBranch).sort().map(branch => `
        <h4>${esc(branch)} · ${byBranch[branch].length}</h4>
        <div class="grid">${byBranch[branch].map(e => card(e, on)).join("")}</div>`).join("")
      : `<div class="panel"><h3>Start with your team</h3>
          <p class="dim">Add each employee once — salary, weekly off, shift, PF and insurance. Link their TatGold username so they can punch attendance from their own phone.</p>
          <button class="btn" id="hr-first" type="button">Add the first employee</button></div>`}

      ${warnings.length ? `<details class="panel"><summary>Needs attention · ${warnings.length}</summary>
        <ul style="margin:12px 0 0; padding-left:20px">${warnings.map(w => `<li>${esc(w)}</li>`).join("")}</ul></details>` : ""}

      <div class="panel"><div class="line"><h3>Leave requests</h3><span class="dim" id="hr-leave-count">…</span></div>
        <div id="hr-leave-list"><p class="dim">Loading…</p></div></div>

      <div class="panel"><div class="line"><h3>Monthly payroll</h3><span class="dim">Draft, then approve</span></div>
        ${records.length ? records.map(p => `<div class="line"><div><b>${esc(p.month)}</b> ${tag(p.status)}
          <div class="dim">${p.lines.length} ${p.lines.length === 1 ? "employee" : "employees"} · ${amount(p.lines.reduce((n, l) => n + Number(l.net), 0))} net</div></div>
          <button class="btn ghost sm" type="button" data-pay="${esc(p.id)}">Open</button></div>`).join("")
        : '<p class="dim">No payroll yet. Run payroll to prepare this month\'s draft.</p>'}</div>

      ${archived.length ? `<details class="panel"><summary>Archived · ${archived.length}</summary>
        ${archived.map(e => `<div class="line"><span>${esc(e.name)}</span>
          <button class="btn ghost sm" type="button" data-edit="${esc(e.id)}">View / restore</button></div>`).join("")}</details>` : ""}`;

    $("#hr-refresh").onclick = () => go("hr");
    $("#hr-add").onclick = () => employeeForm();
    $("#hr-first")?.addEventListener("click", () => employeeForm());
    $("#hr-attendance").onclick = () => attendanceForm();
    $("#hr-payroll").onclick = () => payrollForm();
    $("#hr-ask").onclick = askForm;
    document.querySelectorAll("[data-edit]").forEach(b => { b.onclick = () => employeeForm(b.dataset.edit); });
    document.querySelectorAll("[data-report]").forEach(b => { b.onclick = () => employeeReport(b.dataset.report); });
    document.querySelectorAll("[data-docs]").forEach(b => { b.onclick = () => documentsForm(b.dataset.docs); });
    document.querySelectorAll("[data-photo]").forEach(b => { b.onclick = () => PunchPhotos.view(b.dataset.photo, b.dataset.photoTitle); });
    document.querySelectorAll("[data-pay]").forEach(b => { b.onclick = () => payrollReview(b.dataset.pay); });
    loadLeavePanel();
  }

  function card(e, on) {
    const l = C.leave(state, e, on.slice(0, 4));
    const verified = C.docs.filter(d => e.documents?.[d]?.status === "Verified").length;
    const row = state.attendance.find(a => a.employeeId === e.id && a.date === on);
    const todayStatus = e.joined > on ? "Not joined" : C.record(state, e.id, on);
    const onDuty = !!row?.checkIn && !row?.checkOut;
    const rules = C.rulesFor(e);
    return `<article class="card">
      <div class="person">
        <div class="avatar${onDuty ? " on-duty" : ""}" title="${onDuty ? "Punched in — on duty now" : ""}">${esc(initials(e.name))}</div>
        <div class="identity"><h3>${esc(e.name)}</h3><div class="dim">${esc(e.designation || "Employee")}</div></div>
        <button class="btn ghost sm" type="button" data-report="${esc(e.id)}">Report</button>
        <button class="btn ghost sm" type="button" data-edit="${esc(e.id)}">Edit</button>
      </div>
      <div class="facts">
        <div><span>Monthly salary</span><b>${e.salary ? amount(e.salary) : "Not set"}</b></div>
        <div><span>Today</span><b>${onDuty ? "● " : ""}${esc(todayStatus)}</b></div>
        <div><span>Paid leave ${on.slice(0, 4)}</span><b>${l.remaining} left of ${l.allowance}</b></div>
        <div><span>Weekly off</span><b>${esc(rules.weeklyOff)}</b></div>
      </div>
      <p class="punch-note">${esc(punchNote(row))}</p>
      ${row?.checkIn ? `<div class="photo-links">${[[row.checkInPhoto, "In photo"], [row.checkOutPhoto, "Out photo"]]
        .filter(([p]) => p).map(([p, label]) => `<button class="btn ghost sm" type="button" data-photo="${esc(p)}"
          data-photo-title="${esc(e.name + " · " + label + " · " + dmy(on))}">${label}</button>`).join("")}</div>` : ""}
      <div class="line"><span class="dim">PF</span>${tag(e.pf?.status || "Not set")}</div>
      <div class="line"><span class="dim">Health insurance</span>${tag(C.policyStatus(e.health, on))}</div>
      <div class="line"><span class="dim">Personal accident</span>${tag(C.policyStatus(e.accident, on))}</div>
      <div class="card-footer"><span class="dim">KYC ${verified} of ${C.docs.length} verified</span>
        <button class="btn ghost sm" type="button" data-docs="${esc(e.id)}">Documents</button></div>
    </article>`;
  }

  // ---------------------------------------------------------------- leave approvals
  async function loadLeavePanel() {
    const list = $("#hr-leave-list"), count = $("#hr-leave-count");
    if (!list) return;
    const { data, error } = await sb.rpc("hr_leave_admin_list", { p_status: null });
    if (error) { count.textContent = ""; list.innerHTML = `<p class="dim">Could not load leave requests: ${esc(error.message)}</p>`; return; }
    const pending = (data || []).filter(r => r.status === "PENDING");
    const decided = (data || []).filter(r => r.status !== "PENDING").slice(0, 10);
    count.textContent = pending.length ? `${pending.length} waiting` : "Nothing waiting";
    const row = r => `<div class="line"><div><b>${esc(r.employeeName || "—")}</b> ${tag(r.type === "PAID" ? "Paid leave" : "Unpaid leave")}
      <div class="dim">${dmy(r.from)}${r.from !== r.to ? " – " + dmy(r.to) : ""}${r.reason ? " · " + esc(r.reason) : ""}</div></div>
      ${r.status === "PENDING" ? `<span class="row"><button class="btn ghost sm" type="button" data-reject="${esc(r.id)}">Reject</button>
        <button class="btn sm" type="button" data-approve="${esc(r.id)}">Approve</button></span>`
      : `<span>${tag(r.status)}</span>`}</div>`;
    list.innerHTML = (pending.length ? pending.map(row).join("") : '<p class="dim">No leave applications waiting.</p>') +
      (decided.length ? `<details style="margin-top:10px"><summary class="dim">Recent decisions</summary>${decided.map(row).join("")}</details>` : "");
    list.querySelectorAll("[data-approve]").forEach(b => { b.onclick = () => decideLeave(b, b.dataset.approve, true); });
    list.querySelectorAll("[data-reject]").forEach(b => { b.onclick = () => decideLeave(b, b.dataset.reject, false); });
  }
  async function decideLeave(button, id, approve) {
    const note = approve ? null : (prompt("Reason for rejecting (optional):") || null);
    button.disabled = true;
    const { error } = await sb.rpc("hr_leave_decide", { p_id: id, p_approve: approve, p_note: note });
    if (error) { alert(error.message); button.disabled = false; return; }
    await open();   // approved leave changes attendance, so reload everything
  }

  // ---------------------------------------------------------------- employee report
  function employeeReport(id) {
    const e = findEmployee(id);
    const el = dialog("Report · " + e.name, `<label for="rep-month">Month<select class="input" id="rep-month"></select></label><div id="rep-body"></div>`);
    const monthSel = el.querySelector("#rep-month");
    const [cy, cm] = C.today().split("-").map(Number), months = [];
    for (let i = 0; i < 6; i++) { const d = new Date(Date.UTC(cy, cm - 1 - i, 1)); months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`); }
    monthSel.innerHTML = months.filter(m => m >= e.joined.slice(0, 7)).map(m => `<option value="${m}">${m}</option>`).join("");
    function draw() {
      const month = monthSel.value, isCurrent = month === C.today().slice(0, 7);
      const r = C.monthToDate(state, e, month, isCurrent ? C.today() : C.monthDates(month).slice(-1)[0]);
      const rows = [["Present", r.counts.Present], ["Half day", r.counts["Half day"]], ["Paid leave", r.counts["Paid leave"]],
        ["Unpaid leave", r.counts["Unpaid leave"]], ["Absent", r.counts.Absent],
        ["Weekly off", r.counts["Holiday / weekly off"]], ["Not marked", r.counts["Not marked"]]];
      el.querySelector("#rep-body").innerHTML = `
        <div class="facts" style="margin-top:14px">${rows.map(([k, v]) => `<div><span>${k}</span><b>${v || 0}</b></div>`).join("")}</div>
        <h4>${isCurrent ? "Earned so far this month" : "Salary for the month"}</h4>
        ${e.salary ? `<div class="facts">
            <div><span>Days counted</span><b>${r.daysElapsed} of ${r.calendarDays}</b></div>
            <div><span>Gross</span><b>${amount(r.grossSoFar)}</b></div>
            <div><span>Loss of pay</span><b>${amount(r.lossOfPaySoFar)}</b></div>
            <div><span>Approx. net before PF</span><b>${amount(r.approxNetSoFar)}</b></div></div>
          <p class="note">Employee PF (${amount(e.pf?.employeeAmount || 0)} a month) comes off once at payroll, not day by day. Days that have not happened yet are excluded.${
            r.autoAbsentDays ? ` ${r.autoAbsentDays} day${r.autoAbsentDays === 1 ? "" : "s"} counted Absent automatically — no punch, no leave, nothing marked.` : ""}</p>`
        : `<p class="dim">Set a monthly salary in Edit to see earnings.</p>`}`;
    }
    monthSel.onchange = draw; draw();
  }

  // ---------------------------------------------------------------- add / edit employee
  async function employeeForm(id) {
    const loginResult = await sb.rpc("hr_login_options");
    if (loginResult.error) throw loginResult.error;
    const logins = loginResult.data || [];
    const e = clone(id ? findEmployee(id) : newEmployee());
    const rules = C.rulesFor(e);
    const policy = (key, title) => `<h4>${title}</h4><div class="fields">
      ${picker(key + "Status", "Status", ["Not set", "Pending", "Active", "Not enrolled"], e[key]?.status || "Not set")}
      ${field(key + "Expiry", "Cover ends", e[key]?.expiry || "", "date")}
      ${field(key + "Provider", "Insurer", e[key]?.provider || "", "text", 'maxlength="100"')}
      ${field(key + "Number", "Policy number", e[key]?.policyNumber || "", "text", 'maxlength="100"')}</div>`;

    const el = dialog(id ? "Edit employee" : "Add employee", `<form id="emp-form">
      <div class="fields">
        ${field("name", "Full name", e.name, "text", 'required maxlength="100"')}
        ${field("designation", "Designation", e.designation, "text", 'maxlength="100"')}
        ${picker("branch", "Shop", C.branches, e.branch || C.branches[0])}
        ${field("joined", "Joining date", e.joined, "date", "required")}
        ${field("salary", "Monthly gross salary (₹)", e.salary ?? "", "number", 'min="0" max="10000000" step="0.01" placeholder="Not set"')}
        ${field("leaveAllowance", "Paid leave days per year", e.leaveAllowance, "number", 'required min="0" max="366" step="1"')}
        ${picker("active", "Status", ["Active", "Archived"], e.active ? "Active" : "Archived")}
      </div>

      <h4>Sign-in</h4>
      <p class="note">Choose this employee’s existing TatGold username. They use the same password for attendance. Add any new login under Users & access first. Leave unlinked for manual attendance.</p>
      <div class="fields">
        ${`<label>TatGold login<select class="input" name="email"><option value="">Not linked</option>${logins.map(u=>`<option value="${esc(u.email)}" ${u.email===e.email?"selected":""}>${esc(u.username)} · ${esc(u.fullName)}</option>`).join("")}</select></label>`}
        ${field("mobile", "Mobile", e.mobile || "", "tel", 'maxlength="20"')}
      </div>

      <h4>Attendance rules</h4>
      <p class="note">One fixed weekly off per employee, taken on that day only — never shifted. Punching in more than the grace minutes after shift start is a half day, and so is punching out before shift end.</p>
      <div class="fields">
        ${picker("weeklyOff", "Weekly off", C.WEEKDAYS, rules.weeklyOff)}
        ${field("shiftIn", "Shift starts", rules.shiftIn, "time", "required")}
        ${field("shiftOut", "Shift ends", rules.shiftOut, "time", "required")}
        ${field("lateGrace", "Late grace (minutes)", rules.lateGrace, "number", 'required min="0" max="180" step="1"')}
      </div>

      <h4>Provident fund</h4>
      <p class="note">Fixed monthly amounts, deducted once at payroll. PF eligibility and rates are decided outside this app.</p>
      <div class="fields">
        ${picker("pfStatus", "PF status", ["To review", "Not applicable", "Existing member", "Voluntary", "Active"], e.pf?.status || "To review")}
        ${field("employeePF", "Employee PF per month (₹)", e.pf?.employeeAmount ?? 0, "number", 'required min="0" max="1000000" step="0.01"')}
        ${field("employerPF", "Employer PF per month (₹)", e.pf?.employerAmount ?? 0, "number", 'required min="0" max="1000000" step="0.01"')}
      </div>

      ${policy("health", "Health insurance · company paid")}
      ${policy("accident", "Personal accident insurance · company paid")}

      <p class="note">Archiving keeps every past record and leaves the employee out of new payroll drafts.</p>
      <button class="btn save" type="submit">Save employee</button></form>`);

    el.querySelector("form").onsubmit = event => {
      event.preventDefault();
      const f = new FormData(event.currentTarget);
      run(el, async () => {
        e.name = f.get("name").trim();
        if (!e.name) throw new Error("Enter the employee's name.");
        e.designation = f.get("designation").trim();
        e.branch = f.get("branch");
        e.joined = f.get("joined");
        if (!C.validDate(e.joined)) throw new Error("Choose a valid joining date.");
        e.salary = f.get("salary") === "" ? null : Number(f.get("salary"));
        e.leaveAllowance = Number(f.get("leaveAllowance"));
        e.active = f.get("active") === "Active";
        e.email = f.get("email").trim().toLowerCase();
        e.mobile = f.get("mobile").trim();
        if (e.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.email)) throw new Error("Check the sign-in e-mail.");
        e.weeklyOff = f.get("weeklyOff"); e.shiftIn = f.get("shiftIn"); e.shiftOut = f.get("shiftOut");
        e.lateGrace = Number(f.get("lateGrace"));
        if (!C.WEEKDAYS.includes(e.weeklyOff) || C.mins(e.shiftIn) == null || C.mins(e.shiftOut) == null || !(e.lateGrace >= 0))
          throw new Error("Check the weekly off, shift times and grace minutes.");
        if (C.mins(e.shiftOut) <= C.mins(e.shiftIn)) throw new Error("Shift end must be after shift start.");
        e.pf = { status: f.get("pfStatus"), employeeAmount: Number(f.get("employeePF")), employerAmount: Number(f.get("employerPF")) };
        if (e.pf.status === "Not applicable" && (e.pf.employeeAmount || e.pf.employerAmount))
          throw new Error("Set both PF amounts to zero when PF does not apply.");
        for (const key of ["health", "accident"]) {
          e[key] = { status: f.get(key + "Status"), expiry: f.get(key + "Expiry"),
            provider: f.get(key + "Provider").trim(), policyNumber: f.get(key + "Number").trim() };
          if (e[key].status === "Active" && !C.validDate(e[key].expiry)) throw new Error("Set the cover end date for active insurance.");
        }
        const next = clone(state), index = next.employees.findIndex(x => x.id === e.id);
        if (index < 0) next.employees.push(e); else next.employees[index] = e;
        await save(next, id ? "Employee updated: " + e.name : "Employee added: " + e.name);
        el.close();
      });
    };
  }

  // ---------------------------------------------------------------- attendance by hand
  function attendanceForm(date = C.today()) {
    const el = dialog("Attendance", `
      ${field("attDate", "Date", date, "date", `required max="${C.today()}"`)}
      <p class="note">Employees punch with a photo; the rules are applied automatically at that moment. Use this to correct a day or to mark someone who does not use the app. Absent and unpaid leave cost a full day, a half day costs half. Recorded punch times and photos are kept whatever you set here.</p>
      <p class="note"><button class="btn ghost sm" type="button" id="att-apply-rules">Fill in what the rules say</button></p>
      <form id="att-form"><div id="att-list"></div><button class="btn save" type="submit">Save attendance</button></form>`);
    const dateInput = el.querySelector("#f-attDate");

    function draw() {
      const selected = dateInput.value;
      el.querySelector("#att-list").innerHTML = state.employees
        .filter(e => e.active && e.joined <= selected)
        .map(e => {
          const row = state.attendance.find(a => a.employeeId === e.id && a.date === selected);
          const suggestion = C.dayStatus(e, selected, C.istTime(row?.checkIn), C.istTime(row?.checkOut));
          const options = row?.checkIn ? C.statuses.filter(s => s !== "Not marked") : C.statuses;
          return `<div class="attendance-entry">
            <label><span class="attendance-person">${esc(e.name)}
              <small>${esc(punchNote(row))}</small>
              <small class="dim">Rule: ${esc(suggestion.status)} — ${esc(suggestion.note)}</small></span>
              <select class="input" aria-label="${esc(e.name)}" name="${esc(e.id)}">${option(options, C.record(state, e.id, selected))}</select></label>
            <div class="photo-links" style="margin-top:8px">${[[row?.checkInPhoto, "In photo"], [row?.checkOutPhoto, "Out photo"]]
              .filter(([p]) => p).map(([p, label]) => `<button class="btn ghost sm" type="button" data-photo="${esc(p)}"
                data-photo-title="${esc(e.name + " · " + label)}">${label}</button>`).join("")}</div>
          </div>`;
        }).join("") || '<p class="dim">Nobody had joined by this date.</p>';
    }
    el.querySelector("#att-list").addEventListener("click", event => {
      const button = event.target.closest("[data-photo]");
      if (button) PunchPhotos.view(button.dataset.photo, button.dataset.photoTitle);
    });
    dateInput.onchange = draw; draw();

    el.querySelector("#att-apply-rules").onclick = () => {
      const selected = dateInput.value;
      state.employees.filter(e => e.active && e.joined <= selected).forEach(e => {
        const row = state.attendance.find(a => a.employeeId === e.id && a.date === selected);
        const suggestion = C.dayStatus(e, selected, C.istTime(row?.checkIn), C.istTime(row?.checkOut));
        const select = el.querySelector(`select[name="${e.id}"]`);
        if (select && suggestion.status !== "Not marked" && [...select.options].some(o => o.value === suggestion.status))
          select.value = suggestion.status;
      });
    };

    el.querySelector("form").onsubmit = event => {
      event.preventDefault();
      const date = dateInput.value, values = [...new FormData(event.currentTarget)];
      run(el, async () => {
        if (!C.validDate(date) || date > C.today()) throw new Error("Choose today or an earlier date.");
        if (!values.length) throw new Error("Nobody to mark on this date.");
        const ids = new Set(values.map(([id]) => id));
        const next = clone(state);
        next.attendance = next.attendance.filter(a => a.date !== date || !ids.has(a.employeeId));
        for (const [employeeId, status] of values) if (status !== "Not marked") {
          const existing = state.attendance.find(a => a.employeeId === employeeId && a.date === date);
          next.attendance.push({ ...existing, employeeId, date, status,
            source: "Set by Admin", reviewedAt: new Date().toISOString(), reviewedBy: me.email });
        }
        await save(next, "Attendance saved for " + date);
        el.close();
      });
    };
  }

  // ---------------------------------------------------------------- documents
  function documentsForm(id) {
    const employee = findEmployee(id);
    const el = dialog("Documents · " + employee.name, `
      <p class="note">Files live in a private folder only Admin can open. "Received" and "Verified" are separate — verifying is your own check. PDF, JPEG or PNG up to 5 MB.</p>
      <form id="doc-form">${C.docs.map((d, i) => `<section style="margin-bottom:16px"><b>${d}</b>
        <div class="fields" style="margin-top:8px">
          ${picker("doc" + i, "Status", ["Missing", "Received", "Verified"], employee.documents?.[d]?.status || "Missing")}
          <label for="file${i}">Attach or replace<input class="input" id="file${i}" name="file${i}" type="file" accept="application/pdf,image/jpeg,image/png"></label>
        </div>
        ${employee.documents?.[d]?.file ? `<div class="line"><span class="dim">${esc(employee.documents[d].file.name)}</span>
          <button class="btn ghost sm" type="button" data-open="${i}">Open</button></div>` : ""}</section>`).join("")}
      <p class="note">A document held on paper can be tracked here without uploading anything.</p>
      <button class="btn save" type="submit">Save documents</button></form>`);

    el.querySelectorAll("[data-open]").forEach(b => {
      b.onclick = () => run(el, async () => {
        const file = employee.documents[C.docs[Number(b.dataset.open)]].file;
        const { data, error } = await sb.storage.from("hr-documents").createSignedUrl(file.path, 60);
        if (error) throw error;
        const link = document.createElement("a");
        link.href = data.signedUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; link.click();
      });
    });

    el.querySelector("form").onsubmit = event => {
      event.preventDefault();
      const f = new FormData(event.currentTarget);
      run(el, async () => {
        const next = clone(state), e = next.employees.find(x => x.id === id);
        for (let i = 0; i < C.docs.length; i++) {
          const file = f.get("file" + i), d = C.docs[i];
          if (file?.size && (!/^(application\/pdf|image\/(jpeg|png))$/.test(file.type) || file.size > 5 * 1024 * 1024))
            throw new Error("Use a PDF, JPEG or PNG up to 5 MB.");
          if (f.get("doc" + i) === "Missing" && (file?.size || e.documents?.[d]?.file))
            throw new Error(`Choose Received or Verified for the attached ${d}.`);
        }
        e.documents = e.documents || {};
        for (let i = 0; i < C.docs.length; i++) {
          const d = C.docs[i], file = f.get("file" + i);
          e.documents[d] = { ...(e.documents[d] || {}), status: f.get("doc" + i) };
          if (file?.size) {
            const extension = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[file.type];
            const path = `${id}/${crypto.randomUUID()}.${extension}`;
            const { error } = await sb.storage.from("hr-documents").upload(path, file, { upsert: false, contentType: file.type });
            if (error) throw error;
            e.documents[d].file = { name: file.name, path, uploadedAt: new Date().toISOString() };
          }
        }
        await save(next, "Documents updated for " + employee.name);
        el.close();
      });
    };
  }

  // ---------------------------------------------------------------- payroll
  const payrollTable = lines => `<div class="table"><table><thead><tr>
      <th>Employee</th><th class="num">Days</th><th class="num">Unpaid</th><th class="num">Gross ₹</th>
      <th class="num">Loss of pay ₹</th><th class="num">PF ₹</th><th class="num">Net ₹</th></tr></thead><tbody>
      ${lines.map(l => `<tr><td>${esc(l.name)}<div class="dim">${esc(l.branch || "")}</div></td>
        <td class="num">${l.eligibleDays}/${l.calendarDays}</td><td class="num">${l.unpaidDays}</td>
        <td class="num">${amount(l.gross)}</td><td class="num">${amount(l.lossOfPay)}</td>
        <td class="num">${amount(l.pf)}</td><td class="num"><b>${amount(l.net)}</b></td></tr>`).join("")}
    </tbody></table></div>`;

  function payrollForm() {
    const el = dialog("Run monthly payroll", `
      ${field("month", "Month", C.today().slice(0, 7), "month", 'required min="2000-01" max="2100-12"')}
      <p class="note">Calendar-day basis. Joining dates prorate the salary. Weekly offs, holidays and paid leave are paid. A working day that has passed with no punch, no approved leave and nothing marked is treated as Absent and its pay is cut — you do not have to mark it. Employee PF is the full monthly amount; employer PF and insurance are company cost, not deductions.</p>
      <div id="pay-preview"><p class="dim">Loading…</p></div>
      <label class="check"><input type="checkbox" id="pay-confirm">
        <span>I have reviewed the attendance, the unpaid days and the PF amounts, including anything counted Absent automatically.</span></label>
      <button class="btn save" id="pay-draft" type="button" disabled>Save payroll draft</button>`, true);

    async function preview() {
      const box = el.querySelector("#pay-preview");
      el.querySelector("#hr-error").hidden = true;
      el.querySelector("#pay-confirm").checked = false;
      el.querySelector("#pay-draft").disabled = true;
      box.innerHTML = '<p class="dim">Working it out…</p>';
      const month = el.querySelector("#f-month").value;
      if (state.payroll.some(p => p.month === month && p.status !== "Rejected")) {
        box.innerHTML = ""; showError(el, new Error("This month already has a payroll. Close this and open it under Monthly payroll."));
        return;
      }
      const { data, error } = await sb.rpc("hr_payroll_preview", { p_month: month });
      if (error) { box.innerHTML = ""; showError(el, error); return; }
      const autoAbsent = data.lines.reduce((n, l) => n + Number(l.autoAbsentDays), 0);
      const unmarked = data.lines.reduce((n, l) => n + Number(l.unmarkedDays), 0);
      box.innerHTML = payrollTable(data.lines) +
        `<div class="line"><b>Total net ${amount(data.totalNet)}</b><span class="dim">Employer PF ${amount(data.totalEmployerPF)}</span></div>
         ${autoAbsent ? `<p class="notice">${autoAbsent} employee-day${autoAbsent === 1 ? "" : "s"} had no punch, no leave and nothing marked, so ${autoAbsent === 1 ? "it is" : "they are"} counted Absent and unpaid. Correct them in Attendance first if that is wrong.</p>` : ""}
         ${unmarked ? `<p class="notice">This month is not over: ${unmarked} employee-day${unmarked === 1 ? " has" : "s have"} not happened yet. Nothing is deducted for ${unmarked === 1 ? "it" : "them"}, so the gross shown is the whole month's salary.</p>` : ""}`;
      el.querySelector("#pay-draft").disabled = false;
    }
    el.querySelector("#f-month").onchange = preview;
    preview();

    el.querySelector("#pay-draft").onclick = () => {
      const month = el.querySelector("#f-month").value;
      const confirmed = el.querySelector("#pay-confirm").checked;
      run(el, async () => {
        if (!confirmed) throw new Error("Review the figures and tick the confirmation first.");
        const { data, error } = await sb.rpc("hr_payroll_draft", { p_month: month });
        if (error) throw error;
        await open();
        el.close();
        payrollReview(data.id);
      });
    };
  }

  function payrollReview(id) {
    const p = state.payroll.find(x => x.id === id);
    const el = dialog("Payroll · " + p.month, `
      <p>${tag(p.status)} <span class="dim">${p.status === "Approved" ? "Approved by " + esc(p.approvedBy || "Admin")
        : "Prepared by " + esc(p.createdBy || "Admin")}</span></p>
      ${payrollTable(p.lines)}
      <div class="line"><b>Total net ${amount(p.lines.reduce((n, l) => n + Number(l.net), 0))}</b>
        <span class="dim">Employer PF ${amount(p.lines.reduce((n, l) => n + Number(l.employerPF), 0))}</span></div>
      <p class="note">Approving records the salary figures and locks this month's attendance and leave. It does not send any payment — bank transfer and PF remittance stay separate.</p>
      ${p.status === "Draft" ? `
        <label class="check"><input type="checkbox" id="approve-confirm"><span>I have reviewed this month for every employee.</span></label>
        <div class="row"><button class="btn" id="pay-approve" type="button">Approve payroll</button>
          <button class="btn ghost" id="pay-reject" type="button">Reject draft</button></div>` : ""}
      ${p.status === "Approved" ? `<div class="row" style="margin-top:16px">
          <button class="btn ghost" id="pay-csv" type="button">Download register (CSV)</button>
          ${p.lines.map((l, i) => `<button class="btn ghost sm" type="button" data-slip="${i}">Payslip · ${esc(l.name)}</button>`).join("")}
        </div>` : ""}`, true);

    el.querySelector("#pay-approve")?.addEventListener("click", () => run(el, async () => {
      if (!el.querySelector("#approve-confirm").checked) throw new Error("Tick the confirmation to approve.");
      const { error } = await sb.rpc("hr_payroll_approve", { p_id: id });
      if (error) throw error;
      await open(); el.close(); payrollReview(id);
    }));
    el.querySelector("#pay-reject")?.addEventListener("click", () => run(el, async () => {
      const { error } = await sb.rpc("hr_payroll_reject", { p_id: id });
      if (error) throw error;
      await open(); el.close();
    }));
    el.querySelector("#pay-csv")?.addEventListener("click", () => downloadRegister(p));
    el.querySelectorAll("[data-slip]").forEach(b => { b.onclick = () => payslip(p, p.lines[Number(b.dataset.slip)]); });
  }

  function downloadRegister(p) {
    // A leading =, +, - or @ would be read as a formula by Excel, so quote those cells.
    const cell = v => '"' + String(typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""') + '"';
    const rows = [["Month", "Employee", "Shop", "Designation", "Monthly salary", "Eligible days", "Calendar days",
      "Unpaid days", "Gross", "Loss of pay", "Employee PF", "Net", "Employer PF", "Status"],
      ...p.lines.map(l => [p.month, l.name, l.branch || "", l.designation || "", l.monthlySalary, l.eligibleDays,
        l.calendarDays, l.unpaidDays, l.gross, l.lossOfPay, l.pf, l.net, l.employerPF, p.status])];
    const blob = new Blob(["﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `AD-payroll-${p.month}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function payslip(p, l) {
    const company = (window.HR_CONFIG?.COMPANY) || "Ashirwad & Durga Jewellers";
    const legal = (window.HR_CONFIG?.COMPANY_LEGAL) || "";
    const rows = [["Monthly salary", amount(l.monthlySalary)], ["Days paid", `${l.eligibleDays} of ${l.calendarDays}`],
      ["Unpaid days", l.unpaidDays], ["Gross earnings", amount(l.gross)], ["Loss of pay", "− " + amount(l.lossOfPay)],
      ["Employee PF", "− " + amount(l.pf)], ["Net salary", amount(l.net)],
      ["Employer PF (company contribution)", amount(l.employerPF)]];
    const html = `<h3>${esc(company)}</h3><p class="dim">${esc(legal)}${legal ? " · " : ""}Payslip · ${esc(p.month)}</p>
      <h4>${esc(l.name)}</h4><p class="dim">${esc(l.designation || "Employee")}${l.branch ? " · " + esc(l.branch) : ""}</p>
      <div class="table"><table><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${esc(v)}</td></tr>`).join("")}</tbody></table></div>
      <p class="note">Approved by ${esc(p.approvedBy || "Admin")} on ${dmy(String(p.approvedAt || "").slice(0, 10))}. This payslip records the salary calculation; it is not a payment confirmation.</p>`;
    const el = dialog("Payslip · " + l.name, `<div id="slip">${html}</div><button class="btn save" id="slip-print" type="button">Print or save as PDF</button>`);
    el.querySelector("#slip-print").onclick = () => {
      // Printed from its own frame so nothing else on screen ends up on the page.
      const frame = document.createElement("iframe");
      frame.title = "Payslip"; frame.style.cssText = "position:fixed;width:1px;height:1px;left:-10000px;border:0";
      frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 60000); };
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(l.name)} ${esc(p.month)}</title>
        <style>body{font:14px -apple-system,system-ui,sans-serif;padding:32px;color:#1B1917}
        h3{font-size:22px;margin:0} h4{font-size:16px;margin:20px 0 2px} p{margin:4px 0}
        table{width:100%;border-collapse:collapse;margin-top:14px}
        td{padding:11px 8px;border-bottom:1px solid #E6E1D9} td.num{text-align:right}
        .dim,.note{color:#736C63;font-size:12px} @page{size:A4;margin:18mm}</style></head>
        <body>${el.querySelector("#slip").innerHTML}</body></html>`;
      document.body.append(frame);
    };
  }

  // ---------------------------------------------------------------- ask HR
  function askForm() {
    const prompts = ["Who hasn't punched in today", "Who is on duty now", "Leave balances", "Insurance renewals", "Missing documents", "Weekly offs", "PF", "Salaries"];
    const el = dialog("Ask HR", `
      <p class="note">Answers come from your own HR records in this app. No external AI service is connected, and nothing here changes a record or sends a payment.</p>
      <form id="ask-form" class="row"><input class="input grow" id="ask-q" maxlength="500" placeholder="Who has insurance due for renewal?"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" required><button class="btn" type="submit">Ask</button></form>
      <div class="answer" id="ask-answer" role="status" aria-live="polite">Pick a question below, or type your own.</div>
      <div class="chips">${prompts.map(p => `<button class="chip" type="button" data-q="${esc(p)}">${esc(p)}</button>`).join("")}</div>`);
    const respond = q => { el.querySelector("#ask-q").value = q; el.querySelector("#ask-answer").textContent = C.answer(state, q); };
    el.querySelector("form").onsubmit = event => { event.preventDefault(); respond(el.querySelector("#ask-q").value.trim()); };
    el.querySelectorAll("[data-q]").forEach(b => { b.onclick = () => respond(b.dataset.q); });
  }

  SCREENS.hr = { icon: "☰", label: "HR", roles: ["ADMIN"], open };
})();
