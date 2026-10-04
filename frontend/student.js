// Student page: read-only notes for one class. Depends on config.js and common.js.
const classId = new URLSearchParams(location.search).get("class") || "";

function showMessage(text) {
  $("notes").replaceChildren(h("p", { class: "empty" }, text));
}

function noteCard(note) {
  const after = h("div", { class: "after" });
  after.innerHTML = renderNotes(note.notes);               // safe: renderNotes escapes all HTML

  const photo = h("img", { src: note.imageUrl, alt: "Original whiteboard photo", loading: "lazy", decoding: "async" });
  const compare = h("div", { class: "compare" }, photo, after);
  const slider = h("input", {
    type: "range", min: 0, max: 100, value: 100, class: "slider",
    "aria-label": "Slide left to reveal the original photo",
  });
  const sliderRow = h("div", {},
    slider,
    h("div", { class: "slider-labels", "aria-hidden": "true" }, h("span", {}, "Photo"), h("span", {}, "Notes")),
  );

  slider.addEventListener("input", () => {
    after.style.clipPath = `inset(0 ${100 - slider.value}% 0 0)`;
  });
  // The photo is deleted after 30 days. Without it, show the notes alone.
  photo.addEventListener("error", () => {
    photo.remove();
    sliderRow.remove();
    compare.classList.add("plain");
    after.style.clipPath = "none";
  });

  const copy = h("button", { class: "btn quiet small", type: "button" }, "Copy notes");
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(`${note.title}\n\n${note.notes}`);
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => { copy.textContent = "Copy notes"; }, 2000);
  });

  return h("article", { class: "card" },
    h("div", { class: "note-head" }, h("h2", {}, note.title), h("span", { class: "muted small" }, formatDate(note.createdAt))),
    compare,
    sliderRow,
    h("div", { class: "note-actions" }, copy),
  );
}

async function main() {
  if (!/^[a-f0-9]{12}$/.test(classId)) {
    showMessage("This link is incomplete. Ask your teacher for the class link.");
    return;
  }
  try {
    const [info, notes] = await Promise.all([
      request(`/classes/${classId}`),
      request(`/classes/${classId}/notes`),
    ]);
    $("className").textContent = info.name;
    document.title = `${info.name} - Class notes`;
    if (notes.length) $("notes").replaceChildren(...notes.map(noteCard));
    else showMessage("No notes yet. They appear here a minute after your teacher photographs the board.");
  } catch (err) {
    showMessage(err.message === "Class not found" ? "This class link is not valid. Ask your teacher for a new one." : err.message);
  }
}
main();
