/* Ashirwad & Durga Jewellers — HR calculations shared by the browser and the test harness.
   The server (hr.payroll_lines) is the authority for payroll money; this mirrors it exactly so
   the app can show month-to-date figures without a round trip. The harness cross-checks both. */
(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  else root.HRCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const statuses = ["Not marked", "Present", "Absent", "Half day", "Paid leave", "Unpaid leave", "Holiday / weekly off"];
  const docs = ["Aadhaar", "PAN", "Bank proof", "Appointment letter"];
  const branches = ["Ashirwad", "Durga", "A&D"];
  const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // Shop defaults. Every one of these is editable per employee.
  const RULES = { shiftIn: "10:00", shiftOut: "20:30", lateGrace: 15, weeklyOff: "Sunday" };

  // Decimal-safe 2dp rounding (half up), matching Postgres round(numeric, 2). Working in
  // integer paise avoids the binary-floating-point edge cases that make 1234.565 unpredictable.
  function money(n) {
    const value = Number(n);
    if (!Number.isFinite(value)) return NaN;
    const paise = Math.round(Number((value * 100).toPrecision(15)));
    return paise / 100;
  }

  const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const istTime = value => value ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)) : null;
  const mins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  const weekday = date => WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()];

  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) &&
      new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  }
  function monthDates(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Choose a valid payroll month.");
    const [year, m] = month.split("-").map(Number);
    if (year < 2000 || year > 2100) throw new Error("Choose a month between 2000 and 2100.");
    const count = new Date(Date.UTC(year, m, 0)).getUTCDate();
    return Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
  }
  function rulesFor(employee) {
    return {
      shiftIn: employee?.shiftIn || RULES.shiftIn,
      shiftOut: employee?.shiftOut || RULES.shiftOut,
      lateGrace: employee?.lateGrace === "" || employee?.lateGrace == null || !Number.isFinite(Number(employee.lateGrace)) ? RULES.lateGrace : Number(employee.lateGrace),
      weeklyOff: WEEKDAYS.includes(employee?.weeklyOff) ? employee.weeklyOff : RULES.weeklyOff
    };
  }
  // What the rules say a day should be, given the punch times. The server applies this at punch
  // time; Admin sees it here as the suggested status when reviewing a date by hand.
  function dayStatus(employee, date, inTime, outTime) {
    const r = rulesFor(employee);
    if (weekday(date) === r.weeklyOff) return { status: "Holiday / weekly off", note: r.weeklyOff + " off (fixed — never shifted)", lateMin: 0 };
    const tin = mins(inTime);
    if (tin == null) return { status: "Not marked", note: "No punch recorded", lateMin: 0 };
    const late = tin - mins(r.shiftIn);
    if (late > r.lateGrace) return { status: "Half day", note: `Late by ${late} min (in ${inTime}, allowed till ${hhmm(mins(r.shiftIn) + r.lateGrace)})`, lateMin: late };
    const tout = mins(outTime);
    if (tout != null && tout < mins(r.shiftOut)) return { status: "Half day", note: `Left at ${outTime}, shift ends ${r.shiftOut}`, lateMin: Math.max(0, late) };
    return { status: "Present", note: late > 0 ? `In ${inTime} (${late} min late, within grace)` : "On time", lateMin: Math.max(0, late) };
  }

  const record = (state, id, date) => state.attendance.find(a => a.employeeId === id && a.date === date)?.status || "Not marked";

  // The status a date really carries for pay. Mirrors hr.effective_status in SQL:
  //  * an explicit mark (Admin, or an approved leave) always wins;
  //  * a date that has not happened yet counts as nothing — a mid-month run must not charge it;
  //  * the employee's own weekly off is never a working day, so never Absent;
  //  * anything else that has elapsed with no punch, no leave and no mark is Absent, unpaid.
  function effectiveStatus(state, employee, date, on = today()) {
    const marked = record(state, employee.id, date);
    if (marked !== "Not marked") return marked;
    if (date > on) return "Not marked";
    return weekday(date) === rulesFor(employee).weeklyOff ? "Holiday / weekly off" : "Absent";
  }

  function countDays(state, employee, dates, on) {
    const counts = { Present: 0, "Half day": 0, "Paid leave": 0, "Unpaid leave": 0, Absent: 0, "Holiday / weekly off": 0, "Not marked": 0 };
    let unpaidDays = 0, unmarkedDays = 0, autoAbsentDays = 0;
    for (const date of dates) {
      const marked = record(state, employee.id, date), status = effectiveStatus(state, employee, date, on);
      counts[status] = (counts[status] || 0) + 1;
      if (status === "Absent" || status === "Unpaid leave") unpaidDays++;
      else if (status === "Half day") unpaidDays += 0.5;
      else if (status === "Not marked") unmarkedDays++;
      if (marked === "Not marked" && status === "Absent") autoAbsentDays++;
    }
    return { counts, unpaidDays, unmarkedDays, autoAbsentDays };
  }

  function payroll(state, month, on = today()) {
    const dates = monthDates(month), lastDay = dates[dates.length - 1];
    const employees = state.employees.filter(e => e.active && e.joined <= lastDay);
    if (!employees.length) throw new Error("No active employee had joined by this month.");
    return employees.map(e => {
      const salary = Number(e.salary);
      if (!(salary > 0) || !Number.isFinite(salary)) throw new Error(`Set a monthly salary for ${e.name}.`);
      if (!validDate(e.joined)) throw new Error(`Set a joining date for ${e.name}.`);
      const eligible = dates.filter(d => d >= e.joined);
      const { unpaidDays, unmarkedDays, autoAbsentDays } = countDays(state, e, eligible, on);
      const gross = money(salary * eligible.length / dates.length);
      const lossOfPay = money(salary * unpaidDays / dates.length);
      const pf = money(Number(e.pf?.employeeAmount || 0)), employerPF = money(Number(e.pf?.employerAmount || 0));
      if (gross - lossOfPay < pf) throw new Error(`Employee PF is more than the salary earned by ${e.name} this month.`);
      return { employeeId: e.id, name: e.name, designation: e.designation, branch: e.branch, monthlySalary: salary,
        calendarDays: dates.length, eligibleDays: eligible.length, unpaidDays, unmarkedDays, autoAbsentDays,
        gross, lossOfPay, pf, employerPF, net: money(gross - lossOfPay - pf) };
    });
  }

  // Month so far, for the per-employee report card.
  function monthToDate(state, employee, month, uptoDate = today()) {
    const all = monthDates(month), calendarDays = all.length;
    const dates = all.filter(d => d <= uptoDate && d >= employee.joined);
    const { counts, unpaidDays, autoAbsentDays } = countDays(state, employee, dates, uptoDate);
    const salary = Number(employee.salary || 0);
    const grossSoFar = money(salary * dates.length / calendarDays);
    const lossOfPaySoFar = money(salary * unpaidDays / calendarDays);
    return { month, uptoDate, calendarDays, daysElapsed: dates.length, counts, unpaidDays, autoAbsentDays,
      grossSoFar, lossOfPaySoFar, approxNetSoFar: money(grossSoFar - lossOfPaySoFar) };
  }

  function leave(state, employee, year) {
    const used = state.attendance.filter(a => a.employeeId === employee.id && a.date.startsWith(String(year)) && a.status === "Paid leave").length;
    const allowance = Number(employee.leaveAllowance || 0);
    return { used, allowance, remaining: allowance - used };
  }

  function policyStatus(policy, on = today()) {
    if (!policy || policy.status !== "Active") return policy?.status || "Not set";
    if (!policy.expiry) return "Expiry missing";
    const days = Math.round((Date.parse(policy.expiry) - Date.parse(on)) / 86400000);
    return days < 0 ? "Expired" : days <= 30 ? `Renew in ${days}d` : "Active";
  }

  // Plain-language answers built from the HR record itself. No external service is called.
  function answer(state, question, on = today()) {
    const q = String(question || "").toLowerCase(), active = state.employees.filter(e => e.active);
    if (!active.length) return "Add your employees first. Then I can answer about salary, attendance, leave, insurance and documents.";
    const nameMatch = active.find(e => q.includes(e.name.toLowerCase().split(/\s+/)[0]));
    const who = nameMatch ? [nameMatch] : active;
    if (/not checked in|nahi aala|absent today|who is missing|hasn't|has not/.test(q)) {
      const missing = active.filter(e => e.joined <= on && !state.attendance.some(a => a.employeeId === e.id && a.date === on && a.checkIn)
        && weekday(on) !== rulesFor(e).weeklyOff);
      return missing.length ? `Not punched in yet on ${on}:\n` + missing.map(e => `${e.name}${e.branch ? " · " + e.branch : ""}`).join("\n")
        : `Everyone rostered today has punched in.`;
    }
    if (/on duty|checked in|working now/.test(q)) {
      const on_duty = active.filter(e => { const r = state.attendance.find(a => a.employeeId === e.id && a.date === on); return r?.checkIn && !r?.checkOut; });
      return on_duty.length ? "On duty now:\n" + on_duty.map(e => e.name).join("\n") : "Nobody is punched in right now.";
    }
    if (/insurance|renew|policy|विमा/.test(q))
      return who.map(e => `${e.name}: Health — ${policyStatus(e.health, on)}${e.health?.expiry ? ` (${e.health.expiry})` : ""}; Accident — ${policyStatus(e.accident, on)}${e.accident?.expiry ? ` (${e.accident.expiry})` : ""}.`).join("\n");
    if (/document|kyc|aadhaar|pan|कागद/.test(q))
      return who.map(e => { const missing = docs.filter(d => e.documents?.[d]?.status !== "Verified"); return `${e.name}: ${missing.length ? "To verify — " + missing.join(", ") : "All documents verified"}.`; }).join("\n");
    if (/leave|सुट्ट|रजा/.test(q))
      return who.map(e => { const l = leave(state, e, on.slice(0, 4)); return `${e.name}: ${l.remaining} paid leave days left (${l.used} of ${l.allowance} used in ${on.slice(0, 4)}).`; }).join("\n");
    if (/weekly off|holiday|सुट्टीचा दिवस/.test(q))
      return who.map(e => `${e.name}: ${rulesFor(e).weeklyOff} off · shift ${rulesFor(e).shiftIn}–${rulesFor(e).shiftOut}.`).join("\n");
    if (/absent|attendance|present|हजर/.test(q))
      return `${on}\n` + who.map(e => `${e.name}: ${record(state, e.id, on)}.`).join("\n");
    if (/\bpf\b|पीएफ/.test(q))
      return who.map(e => `${e.name}: ${e.pf?.status}; employee PF ₹${Number(e.pf?.employeeAmount || 0).toLocaleString("en-IN")}, employer PF ₹${Number(e.pf?.employerAmount || 0).toLocaleString("en-IN")} per month.`).join("\n");
    if (/salary|payroll|पगार/.test(q))
      return who.map(e => `${e.name}: monthly salary ${e.salary ? "₹" + Number(e.salary).toLocaleString("en-IN") : "not set"}.`).join("\n") + "\nRun Payroll to prepare the month's draft. No payment is sent from here.";
    return "Ask about today's attendance, who hasn't punched in, leave balances, weekly offs, insurance renewals, missing documents, PF or salary. Answers come from your own HR records — no external AI is connected.";
  }

  return { statuses, docs, branches, WEEKDAYS, RULES, money, today, istTime, mins, hhmm, weekday,
    validDate, monthDates, rulesFor, dayStatus, record, effectiveStatus, countDays,
    payroll, monthToDate, leave, policyStatus, answer };
});
