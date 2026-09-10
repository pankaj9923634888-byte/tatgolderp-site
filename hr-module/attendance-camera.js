/* A fresh camera photo, stamped with the IST time and the device's location, is reviewed by the
   employee and only then committed. The server times the punch — the device clock is not used. */
(function () {
  "use strict";

  function shell(title) {
    const dialog = document.createElement("dialog");
    dialog.className = "camera-dialog"; dialog.setAttribute("aria-label", title);
    dialog.innerHTML = `<header><h3>${esc(title)}</h3><button type="button" class="btn ghost sm" data-close>Close</button></header><div class="body camera-body"></div>`;
    document.body.append(dialog); dialog.showModal(); return dialog;
  }

  // Best effort: a refused or unavailable location never blocks the punch.
  function getLocation() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      const timer = setTimeout(() => resolve(null), 6000);
      navigator.geolocation.getCurrentPosition(
        pos => { clearTimeout(timer); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }); },
        () => { clearTimeout(timer); resolve(null); },
        { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
    });
  }

  const istStamp = () => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short",
    year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date()) + " IST";

  // Burns the stamp into the photo itself, so the image stands on its own as evidence.
  function stampCanvas(canvas, employeeName, loc) {
    const ctx = canvas.getContext("2d");
    const pad = Math.max(8, Math.round(canvas.width * 0.02));
    const fs = Math.max(11, Math.round(canvas.width * 0.032));
    const lh = Math.round(fs * 1.35);
    const lines = [employeeName, istStamp(), loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}  ±${Math.round(loc.acc || 0)}m` : "Location unavailable"];
    const barH = lh * lines.length + pad * 2;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, canvas.height - barH, canvas.width, barH);
    ctx.fillStyle = "#fff";
    ctx.font = `${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    lines.forEach((line, i) => ctx.fillText(line, pad, canvas.height - barH + pad + i * lh));
  }

  async function view(path, title = "Punch photo") {
    const dialog = shell(title), body = dialog.querySelector(".camera-body");
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    body.innerHTML = '<p role="status" class="dim">Loading the private photo…</p>';
    try {
      const { data, error } = await sb.storage.from("hr-punch-photos").createSignedUrl(path, 60);
      if (error) throw error;
      if (!dialog.open) return;
      body.innerHTML = '<img class="camera-photo" alt="Saved punch photo"><p class="note">Visible to this employee and to Admin only. The link expires in a minute.</p>';
      const img = body.querySelector("img");
      img.onerror = () => { body.innerHTML = '<p class="err" role="alert">Could not load this photo. Close and try again.</p>'; };
      img.src = data.signedUrl;
    } catch (error) {
      if (dialog.open) body.innerHTML = `<p class="err" role="alert">${esc(error.message || "Could not open the photo.")}</p>`;
    }
  }

  function captureAndPunch(action, employeeName) {
    return new Promise(resolve => {
      const title = action === "IN" ? "Photo punch-in" : "Photo punch-out";
      const dialog = shell(title), body = dialog.querySelector(".camera-body"), close = dialog.querySelector("[data-close]");
      body.innerHTML = `
        <p class="camera-instruction">${esc(employeeName)} · keep your face clearly visible, then take the photo.</p>
        <div class="camera-frame"><video autoplay muted playsinline aria-label="Live camera"></video><img alt="Your photo to review" hidden><span class="camera-placeholder">Opening camera…</span></div>
        <p class="camera-status" role="status" aria-live="polite"></p>
        <p class="err" role="alert" hidden></p>
        <div class="camera-controls">
          <button type="button" class="btn" data-capture disabled>Take photo</button>
          <button type="button" class="btn ghost" data-retake hidden>Retake</button>
          <button type="button" class="btn" data-confirm hidden>Use photo &amp; ${action === "IN" ? "punch in" : "punch out"}</button>
          <button type="button" class="btn ghost" data-retry hidden>Open camera again</button>
        </div>
        <p class="note">The date, time and location are stamped onto the photo and saved with it. Your punch time comes from the server, not this device.</p>`;

      const video = body.querySelector("video"), img = body.querySelector("img");
      const placeholder = body.querySelector(".camera-placeholder"), status = body.querySelector(".camera-status"), errorBox = body.querySelector(".err");
      const capture = body.querySelector("[data-capture]"), retake = body.querySelector("[data-retake]");
      const confirm = body.querySelector("[data-confirm]"), retry = body.querySelector("[data-retry]");

      let stream = null, blob = null, objectUrl = null, prepared = null, uploaded = false;
      let busy = false, result = null, generation = 0, savedAttempt = false, punchLoc = null;
      const locPromise = getLocation();   // starts while the camera opens

      const fail = message => { errorBox.textContent = message; errorBox.hidden = false; };
      const stop = () => { ++generation; stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null; capture.disabled = true; };
      const revoke = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; };
      const onHide = () => { if (!document.hidden || !dialog.open || blob) return; stop(); placeholder.hidden = false; placeholder.textContent = "Camera paused"; retry.hidden = false; };
      const onPageHide = () => stop();
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", onPageHide);

      close.onclick = () => { if (!busy) dialog.close(); };
      dialog.addEventListener("cancel", e => { if (busy) e.preventDefault(); });
      dialog.addEventListener("close", () => {
        stop(); revoke();
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onPageHide);
        dialog.remove(); resolve(result);
      }, { once: true });

      async function openCamera() {
        stop(); revoke(); blob = null; prepared = null; uploaded = false; savedAttempt = false;
        errorBox.hidden = true; status.textContent = "";
        img.hidden = true; video.hidden = false; placeholder.hidden = false; placeholder.textContent = "Opening camera…";
        capture.hidden = false; retake.hidden = true; confirm.hidden = true; retry.hidden = true;
        const current = generation;
        try {
          if (!window.isSecureContext) throw new Error("Open the app on its https:// address to use the camera.");
          if (!navigator.mediaDevices?.getUserMedia) throw new Error("The camera is not available in this browser. Use Safari or Chrome on your phone.");
          const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "user" }, width: { ideal: 960 }, height: { ideal: 720 } } });
          if (!dialog.open || current !== generation || document.hidden) { media.getTracks().forEach(t => t.stop()); return; }
          stream = media; video.srcObject = media; video.muted = true;
          video.onloadeddata = () => { if (dialog.open && stream && video.videoWidth) { capture.disabled = false; placeholder.hidden = true; } };
          await video.play();
          if (stream && video.videoWidth) { capture.disabled = false; placeholder.hidden = true; }
        } catch (err) {
          if (!dialog.open || current !== generation) return;
          stop(); video.hidden = true; placeholder.textContent = "Camera unavailable"; retry.hidden = false;
          fail(err.name === "NotAllowedError" ? "Allow camera access for this site in your browser settings, then try again."
            : err.name === "NotFoundError" ? "No camera found on this device."
            : err.name === "NotReadableError" ? "The camera is busy. Close other camera apps and try again."
            : err.message || "Could not open the camera.");
        }
      }

      capture.onclick = async () => {
        if (!stream || !video.videoWidth || capture.disabled) return;
        capture.disabled = true; errorBox.hidden = true;
        try {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          punchLoc = await locPromise;
          stampCanvas(canvas, employeeName, punchLoc);
          const photo = await new Promise(r => canvas.toBlob(r, "image/jpeg", .82));
          if (!dialog.open) return;
          if (!photo || !photo.size || photo.size > 2 * 1024 * 1024) throw new Error("Could not prepare this photo. Take it again.");
          blob = photo; stop(); revoke();
          objectUrl = URL.createObjectURL(blob); img.src = objectUrl;
          video.hidden = true; img.hidden = false; placeholder.hidden = true;
          capture.hidden = true; retake.hidden = false; confirm.hidden = false;
          status.textContent = punchLoc ? "Check the photo, then confirm." : "Location was not available — the punch will still be saved.";
        } catch (err) { fail(err.message); capture.disabled = !stream; }
      };
      retake.onclick = openCamera; retry.onclick = openCamera;

      confirm.onclick = async () => {
        if (busy || !blob) return;
        busy = true; close.disabled = true; confirm.disabled = true; retake.disabled = true; errorBox.hidden = true;
        status.textContent = "Saving the photo and your punch…";
        try {
          if (!prepared) {
            const { data, error } = await sb.rpc("hr_photo_prepare", { p_action: action });
            if (error) throw error;
            if (data.alreadyDone) { result = data.attendance; dialog.close(); return; }
            prepared = data;
          }
          if (!uploaded) {
            const { error } = await sb.storage.from(prepared.bucket).upload(prepared.path, blob, { contentType: "image/jpeg", upsert: false, cacheControl: "0" });
            // A dropped response can leave the object already stored; the punch RPC checks it independently.
            const already = error && (String(error.statusCode || error.status) === "409" || /already exists|duplicate/i.test(error.message || ""));
            if (error && !already) throw error;
            uploaded = true;
          }
          savedAttempt = true;
          const { data, error } = await sb.rpc("hr_punch", { p_action: action, p_photo_token: prepared.token, p_lat: punchLoc?.lat ?? null, p_lng: punchLoc?.lng ?? null });
          if (error) throw error;
          result = data; dialog.close();
        } catch (err) {
          status.textContent = "";
          if (/expired|fresh photo/i.test(err.message || "")) { savedAttempt = false; prepared = null; uploaded = false; }
          const setup = /PGRST202|42883/.test(err.code || "");
          fail(setup ? "Photo attendance is not set up on this project yet. Ask Admin to apply database/001_hr_app.sql and 002_storage.sql."
            : (err.message || "Could not confirm the punch.") + (savedAttempt ? " Tap Retry save to confirm the same punch, or close and refresh." : " Nothing was saved. Try again."));
          confirm.textContent = "Retry save";
          retake.hidden = savedAttempt;
          if (!savedAttempt && /expired|fresh photo|Too many/i.test(err.message || "")) { prepared = null; uploaded = false; }
        } finally { busy = false; close.disabled = false; confirm.disabled = false; retake.disabled = false; }
      };

      openCamera();
    });
  }

  window.PunchPhotos = { captureAndPunch, view };
})();
