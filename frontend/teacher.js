// Teacher console. Depends on config.js and common.js.
let classId = "";
let pollTimer = null;

const STUDENT_STATUS = { confirmed: "Confirmed", pending: "Pending", inactive: "Not subscribed" };
const BOARD_STATUS = { processing: "Reading", ready: "Ready", empty: "No content", failed: "Failed", limit: "Limit reached" };
const ERROR_HINTS = {
  AccessDeniedException: "The AI model is not available to this account or region. Check Bedrock model access.",
  ThrottlingException: "The AI model is busy. Upload the photo again in a minute.",
  ValidationException: "The model could not use this image. Try a clearer photo.",
  ResourceNotFoundException: "The model ID is wrong for this region.",
};
const EMAIL_FIND = /[^\s,;<>()"']+@[^\s,;<>()"']+\.[^\s,;<>()"']+/g;

function notify(text, isError = false) {
  const el = $("msg");
  el.textContent = text;
  el.hidden = !text;
  el.classList.toggle("error", isError);
}

async function guarded(button, task) {
  if (button) button.disabled = true;
  try { await task(); } catch (err) { notify(err.message, true); }
  finally { if (button) button.disabled = false; }
}

// ----- sign in -----
async function start() {
  let classes;
  try {
    classes = await request("/classes", { teacher: true });
  } catch (err) {
    sessionStorage.removeItem("snapKey");
    throw err;
  }
  $("auth").hidden = true;
  $("app").hidden = false;
  $("signOut").hidden = false;
  notify("");
  renderClasses(classes);
}

$("authForm").addEventListener("submit", (e) => {
  e.preventDefault();
  sessionStorage.setItem("snapKey", $("passcode").value);
  guarded($("signIn"), start);
});
$("signOut").addEventListener("click", () => {
  sessionStorage.removeItem("snapKey");
  location.reload();
});
if (sessionStorage.getItem("snapKey")) guarded(null, start);

// ----- classes -----
function renderClasses(classes, preferId) {
  const has = classes.length > 0;
  $("noClass").hidden = has;
  $("classPicker").hidden = !has;
  $("linkBox").hidden = !has;
  $("classPanels").hidden = !has;
  $("classSelect").replaceChildren(...classes.map((c) => h("option", { value: c.classId }, c.name)));
  if (!has) { classId = ""; clearInterval(pollTimer); return; }
  $("classSelect").value = preferId || classes[0].classId;
  selectClass();
}

function selectClass() {
  clearInterval(pollTimer);
  classId = $("classSelect").value;
  const link = new URL(`student.html?class=${classId}`, location.href).href;
  $("studentLink").textContent = link;
  $("studentLink").href = link;
  $("queue").replaceChildren();
  guarded(null, () => Promise.all([loadRoster(), loadBoards()]));
}
$("classSelect").addEventListener("change", selectClass);

$("newClassForm").addEventListener("submit", (e) => {
  e.preventDefault();
  guarded($("createClass"), async () => {
    const name = $("className").value.trim();
    if (!name) throw new Error("Enter a class name.");
    const { classId: id } = await request("/classes", { method: "POST", teacher: true, body: { name } });
    $("className").value = "";
    renderClasses(await request("/classes", { teacher: true }), id);
  });
});

$("copyLink").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("studentLink").href);
    notify("Student link copied.");
  } catch {
    notify("Could not copy automatically. Select the link and copy it.", true);
  }
});

// ----- students -----
async function loadRoster() {
  const cid = classId;
  const rows = await request(`/classes/${cid}/students`, { teacher: true });
  if (cid !== classId) return;
  $("rosterCount").textContent = rows.length ? `${rows.length} student${rows.length === 1 ? "" : "s"}` : "";
  $("roster").replaceChildren(
    ...(rows.length
      ? rows.map(rosterRow)
      : [h("tr", {}, h("td", { colspan: 3, class: "muted" }, "No students yet."))]),
  );
}

function rosterRow(student) {
  const remove = (e) => guarded(e.currentTarget, async () => {
    await request(`/classes/${classId}/students/${encodeURIComponent(student.email)}`, { method: "DELETE", teacher: true });
    await loadRoster();
  });
  return h("tr", {},
    h("td", {}, student.email),
    h("td", {}, h("span", { class: `pill ${student.status}` }, STUDENT_STATUS[student.status] || student.status)),
    h("td", { class: "right" }, h("button", { class: "btn quiet small", type: "button", onclick: remove }, "Remove")),
  );
}

$("studentsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  guarded($("addStudents"), async () => {
    const cid = classId;
    const found = [...new Set(($("emails").value.match(EMAIL_FIND) || []).map((s) => s.toLowerCase()))];
    if (!found.length) throw new Error("No email addresses found. Paste one per line or separated by commas.");
    const totals = { added: 0, invalid: [], failed: [] };
    for (let i = 0; i < found.length; i += 50) {          // the server accepts 50 at a time
      const r = await request(`/classes/${cid}/students`, {
        method: "POST", teacher: true, body: { emails: found.slice(i, i + 50) },
      });
      totals.added += r.added.length;
      totals.invalid.push(...r.invalid);
      totals.failed.push(...r.failed);
    }
    $("emails").value = "";
    let text = `Confirmation email sent to ${totals.added} student${totals.added === 1 ? "" : "s"}.`;
    if (totals.invalid.length) text += ` Skipped invalid: ${totals.invalid.join(", ")}.`;
    if (totals.failed.length) text += ` Could not add: ${totals.failed.join(", ")}. Try those again.`;
    notify(text, totals.failed.length > 0);
    if (cid === classId) await loadRoster();
  });
});

// ----- boards -----
async function loadBoards() {
  const cid = classId;
  const { boards, remaining } = await request(`/classes/${cid}/boards`, { teacher: true });
  if (cid !== classId) return boards;
  $("remaining").textContent = `${remaining} photo${remaining === 1 ? "" : "s"} left today. The count resets at 05:30 IST.`;
  $("boards").replaceChildren(
    ...(boards.length
      ? boards.map(boardRow)
      : [h("tr", {}, h("td", { colspan: 3, class: "muted" }, "No boards yet. Add a photo above."))]),
  );
  return boards;
}

function boardRow(board) {
  const remove = (e) => {
    if (!confirm("Delete this board and its photo? Students will no longer see it.")) return;
    guarded(e.currentTarget, async () => {
      await request(`/classes/${classId}/boards/${board.id}`, { method: "DELETE", teacher: true });
      await loadBoards();
    });
  };
  const detail = board.error ? ERROR_HINTS[board.error] || board.error : "";
  return h("tr", {},
    h("td", {},
      h("div", {}, board.title || "Untitled"),
      h("div", { class: "muted small" }, formatDate(board.createdAt)),
      detail && h("div", { class: "muted small" }, detail),
    ),
    h("td", {}, h("span", { class: `pill ${board.status}` }, BOARD_STATUS[board.status] || board.status)),
    h("td", { class: "right" }, h("button", { class: "btn quiet small", type: "button", onclick: remove }, "Delete")),
  );
}

// Refresh the list every 3 seconds until the new photos are finished (max 2 minutes).
function poll(ids) {
  clearInterval(pollTimer);
  const waiting = new Set(ids);
  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    try {
      const boards = await loadBoards();
      for (const b of boards) if (b.status !== "processing") waiting.delete(b.id);
    } catch { /* try again on the next tick */ }
    if (!waiting.size || ticks >= 40) {
      clearInterval(pollTimer);
      if (waiting.size) notify("Some photos are still being read. Refresh this page in a minute.");
    }
  };
  pollTimer = setInterval(tick, 3000);
  tick();
}

// ----- photo upload -----
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("this image format is not supported. Use JPG or PNG.")); };
    img.src = url;
  });
}

// Shrinks to 1600px and re-encodes as JPEG: faster upload, always under the model's size limit.
async function shrink(file, maxSide = 1600) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";                                  // PNG transparency becomes white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.85, 0.7, 0.5]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= 3_400_000) return blob;
  }
  throw new Error("this photo is too large even after shrinking.");
}

async function uploadFiles(files) {
  const cid = classId;
  const ids = [];
  for (const file of files) {
    const name = file.name || "Camera photo";
    const item = h("li", {}, `${name}: preparing`);
    $("queue").prepend(item);
    try {
      if (!file.type.startsWith("image/")) throw new Error("this file is not an image.");
      const blob = await shrink(file);
      item.textContent = `${name}: uploading`;
      const { id, post } = await request(`/classes/${cid}/upload`, { method: "POST", teacher: true });
      const form = new FormData();
      Object.entries(post.fields).forEach(([key, value]) => form.append(key, value));
      form.append("file", blob);                           // the file must be the last field
      let res;
      try { res = await fetch(post.url, { method: "POST", body: form }); }
      catch { throw new Error("the upload was interrupted. Check your connection and try again."); }
      if (!res.ok) throw new Error(`the upload was rejected (${res.status}). Try again.`);
      ids.push(id);
      item.textContent = `${name}: uploaded, reading the board`;
    } catch (err) {
      item.textContent = `${name}: ${err.message}`;
      item.className = "bad";
    }
  }
  if (ids.length && cid === classId) poll(ids);
}

for (const inputId of ["cam", "files"]) {
  $(inputId).addEventListener("change", (e) => {
    const files = [...e.target.files];                     // copy before the input is reset
    e.target.value = "";
    if (files.length && classId) uploadFiles(files);
  });
}
