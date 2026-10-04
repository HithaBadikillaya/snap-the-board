// Shared helpers for the teacher and student pages.
const API = window.APP_CONFIG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

async function request(path, { method = "GET", body, teacher = false } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (teacher) headers["x-teacher-key"] = sessionStorage.getItem("snapKey") || "";
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error("Could not reach the server. Check your internet connection and the API address in config.js.");
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    throw new Error(data.error || (res.status === 429 ? "Too many requests. Wait a few seconds and try again." : `Request failed (${res.status}).`));
  }
  return data;
}

// Build DOM without innerHTML, so nothing from the server can inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) el.setAttribute(key, value === true ? "" : value);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

const formatDate = (iso) =>
  new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

// Tiny Markdown renderer for the notes. HTML is escaped first, so the only tags
// in the output are the ones created below.
function renderNotes(markdown) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`(.+?)`/g, "<code>$1</code>");
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { closeList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
      closeList();
      const tag = m[1].length <= 2 ? "h3" : "h4";
      out.push(`<${tag}>${inline(m[2])}</${tag}>`);
    } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}
