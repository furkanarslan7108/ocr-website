"use strict";

(() => {
  const API = "api";
  const STORE_JOBS = "ocrdesk.jobs";
  const STORE_OPTS = "ocrdesk.options";
  const STORE_SIDEBAR = "ocrdesk.sidebar";
  const POLL_MS = 700;
  const POLL_HIDDEN_MS = 3000;

  const LANG_NAMES = {
    eng: "English", tur: "Turkish", deu: "German", fra: "French", spa: "Spanish", ita: "Italian",
    por: "Portuguese", nld: "Dutch", rus: "Russian", ara: "Arabic", chi_sim: "Chinese (Simpl.)",
    chi_tra: "Chinese (Trad.)", jpn: "Japanese", kor: "Korean", pol: "Polish", ukr: "Ukrainian",
    ell: "Greek", heb: "Hebrew", hin: "Hindi", swe: "Swedish", dan: "Danish", nor: "Norwegian", fin: "Finnish",
  };
  const MODE_HINTS = {
    auto: "OCR only pages without text. Fastest; keeps existing text intact.",
    redo: "Replace an earlier OCR layer while keeping real digital text.",
    force: "Rasterize and OCR every page. Slowest; use for broken text layers.",
  };
  const STATUS_LABEL = { uploading: "Uploading", queued: "Queued", processing: "Processing", done: "Done", error: "Failed" };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    dropzone: $("#dropzone"),
    input: $("#file-input"),
    staging: $("#staging"),
    stagedList: $("#staged-list"),
    languages: $("#languages"),
    modeHint: $("#mode-hint"),
    rotate: $("#opt-rotate"),
    deskew: $("#opt-deskew"),
    clean: $("#opt-clean"),
    combineBox: $("#combine-box"),
    combine: $("#opt-combine"),
    title: $("#opt-title"),
    start: $("#start"),
    clearStaged: $("#clear-staged"),
    results: $("#results"),
    jobList: $("#job-list"),
    clearFinished: $("#clear-finished"),
    template: $("#job-template"),
    ttlNote: $("#ttl-note"),
    acceptedNote: $("#accepted-note"),
    topbar: $("#topbar"),
    shell: $("#shell"),
    sidebar: $("#sidebar"),
    toggleSidebar: $("#toggle-sidebar"),
    scrim: $("#scrim"),
    history: $("#history"),
    historyEmpty: $("#history-empty"),
    historyCount: $("#history-count"),
    historySearch: $("#history-search"),
    historyTemplate: $("#history-template"),
    storageNote: $("#storage-note"),
    clearHistory: $("#clear-history"),
    preview: $("#preview"),
    previewName: $("#preview-name"),
    previewMeta: $("#preview-meta"),
    previewClose: $("#preview-close"),
    previewTab: $("#preview-tab"),
    previewSections: $("#preview-sections"),
    previewOpen: $("#preview-open"),
    previewDl: $("#preview-dl"),
    previewFrame: $("#preview-frame"),
    previewText: $("#preview-text"),
    textNote: $("#text-note"),
    textBody: $("#text-body"),
    textCopy: $("#text-copy"),
  };

  let config = { languages: ["eng"], default_language: "eng", accepted_extensions: [], max_file_mb: 100, max_files_per_job: 20 };
  let staged = [];
  const shownStaged = new WeakSet(); // files whose chip has already animated in
  const jobs = new Map(); // id -> { data, node, refs }
  let pollTimer = null;
  let history = []; // saved conversions (metadata only), newest first
  let current = null; // what the preview shows: { id, name, result, pdfUrl, txtUrl, loadText, revoke }

  // ---------------------------------------------------------------- utils

  const storage = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
    },
  };

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function fmtSeconds(s) {
    return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  }

  function fmtDate(ts) {
    const d = new Date(ts * 1000);
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days === 0) return time;
    if (days === 1) return `Yesterday ${time}`;
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function dayGroup(ts) {
    const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(ts * 1000))) / 864e5);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return "Previous 7 days";
    if (days < 30) return "Previous 30 days";
    return "Older";
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  }

  async function api(path, opts) {
    const res = await fetch(`${API}/${path}`, opts);
    if (!res.ok) {
      let detail = `${res.status} ${res.statusText}`;
      try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  // ---------------------------------------------------------------- local archive (IndexedDB)

  // Output files are kept in the browser so history outlives the server's TTL.
  // Metadata and blobs live in separate stores so listing never loads the files.
  const db = (() => {
    let opening;
    const open = () => opening ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("ocrdesk", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("conversions", { keyPath: "id" });
        req.result.createObjectStore("files");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    async function run(stores, mode, fn) {
      const conn = await open();
      return new Promise((resolve, reject) => {
        const tx = conn.transaction(stores, mode);
        const req = fn(...[stores].flat().map((n) => tx.objectStore(n)));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    }
    return {
      list: () => run("conversions", "readonly", (s) => s.getAll()),
      has: async (id) => (await run("conversions", "readonly", (s) => s.count(id))) > 0,
      files: (id) => run("files", "readonly", (s) => s.get(id)),
      save: (meta, files) => run(["conversions", "files"], "readwrite", (m, f) => { f.put(files, meta.id); m.put(meta); }),
      remove: (id) => run(["conversions", "files"], "readwrite", (m, f) => { m.delete(id); f.delete(id); }),
      clear: () => run(["conversions", "files"], "readwrite", (m, f) => { m.clear(); f.clear(); }),
    };
  })();

  const archiving = new Set();

  async function archiveJob(job) {
    const id = job.id;
    if (archiving.has(id) || history.some((h) => h.id === id)) return true;
    archiving.add(id);
    try {
      const base = `${API}/jobs/${id}`;
      const [pdf, txt] = await Promise.all(["pdf", "txt"].map(async (kind) => {
        const res = await fetch(`${base}/${kind}`);
        if (!res.ok) throw new Error(`${kind} ${res.status}`);
        return res.blob();
      }));
      const d = job.data;
      const meta = {
        id,
        name: d.result.output_name,
        files: d.files,
        options: d.options,
        result: d.result,
        created: d.created,
        finished: d.finished || Date.now() / 1000,
        size: pdf.size + txt.size,
      };
      await db.save(meta, { pdf, txt });
      await loadHistory();
      return true;
    } catch (err) {
      console.warn("Could not save conversion locally", err);
      if (err?.name === "QuotaExceededError") alertInline("Browser storage is full — delete some items from History to keep new results.");
      return false;
    } finally {
      archiving.delete(id);
    }
  }

  // ---------------------------------------------------------------- history sidebar

  async function loadHistory() {
    try {
      history = (await db.list()).sort((a, b) => b.finished - a.finished);
    } catch {
      history = [];
      el.historyEmpty.textContent = "History is unavailable: this browser blocks local storage.";
    }
    renderHistory();
    updateStorageNote();
  }

  function renderHistory() {
    const q = el.historySearch.value.trim().toLowerCase();
    const items = q ? history.filter((h) => h.name.toLowerCase().includes(q) || h.files.some((f) => f.name.toLowerCase().includes(q))) : history;
    const nodes = [];
    let group = null;
    let list = null;
    for (const h of items) {
      const g = dayGroup(h.finished);
      if (g !== group) {
        group = g;
        const head = document.createElement("h3");
        head.textContent = g;
        list = document.createElement("ul");
        nodes.push(head, list);
      }
      list.append(historyItem(h));
    }
    el.history.replaceChildren(el.historyEmpty, ...nodes);
    el.historyEmpty.hidden = items.length > 0;
    if (q && !items.length) el.historyEmpty.textContent = "No matches.";
    else if (!history.length) el.historyEmpty.textContent = "Finished conversions are saved in this browser and show up here.";
    el.historyCount.textContent = history.length ? String(history.length) : "";
    el.clearHistory.hidden = history.length === 0;
  }

  function historyItem(h) {
    const node = el.historyTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = h.id;
    node.classList.toggle("active", current?.id === h.id);
    const names = h.files.map((f) => f.name);
    node.querySelector(".h-icon").textContent = names.length > 1 ? `×${names.length}` : (extOf(names[0]).slice(1, 5).toUpperCase() || "PDF");
    node.querySelector(".h-name").textContent = h.name;
    node.querySelector(".h-name").title = names.join("\n");
    const r = h.result;
    node.querySelector(".h-meta").textContent = `${fmtDate(h.finished)} · ${r.pages} page${r.pages === 1 ? "" : "s"}`;
    node.querySelector(".h-open").addEventListener("click", () => {
      openPreview(h.id);
      if (isDrawer()) setSidebar(false);
    });
    const rm = node.querySelector(".h-remove");
    rm.setAttribute("aria-label", `Delete ${h.name}`);
    rm.title = "Delete";
    rm.addEventListener("click", async () => {
      if (current?.id === h.id) closePreview();
      await db.remove(h.id).catch(() => {});
      loadHistory();
    });
    return node;
  }

  function updateStorageNote() {
    const used = history.reduce((n, h) => n + (h.size || 0), 0);
    el.storageNote.textContent = history.length ? `${fmtBytes(used)} stored in this browser` : "";
  }

  let clearArmed;
  function clearHistoryClicked() {
    // Two-step confirm without a blocking dialog.
    if (!clearArmed) {
      el.clearHistory.textContent = "Confirm";
      el.clearHistory.classList.add("danger");
      clearArmed = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    if (current && history.some((h) => h.id === current.id)) closePreview();
    db.clear().catch(() => {}).then(loadHistory);
  }
  function disarmClear() {
    clearTimeout(clearArmed);
    clearArmed = null;
    el.clearHistory.textContent = "Clear all";
    el.clearHistory.classList.remove("danger");
  }

  const drawerQuery = matchMedia("(max-width: 1099px)");
  const isDrawer = () => drawerQuery.matches;

  function setSidebar(open, persist = !isDrawer()) {
    el.shell.classList.toggle("sidebar-open", open);
    el.toggleSidebar.setAttribute("aria-expanded", String(open));
    el.toggleSidebar.setAttribute("aria-label", open ? "Hide history" : "Show history");
    el.scrim.hidden = !(open && isDrawer());
    el.sidebar.inert = !open;
    if (persist) storage.set(STORE_SIDEBAR, open);
  }

  // ---------------------------------------------------------------- preview

  async function openPreview(id, page) {
    let src = null;
    const meta = history.find((h) => h.id === id);
    if (meta) {
      const files = await db.files(id).catch(() => null);
      if (files?.pdf) {
        const pdfUrl = URL.createObjectURL(files.pdf);
        const txtUrl = URL.createObjectURL(files.txt);
        src = {
          id, name: meta.name, result: meta.result, finished: meta.finished, pdfUrl, txtUrl,
          loadText: () => files.txt.text(),
          revoke: () => { URL.revokeObjectURL(pdfUrl); URL.revokeObjectURL(txtUrl); },
        };
      }
    }
    if (!src) {
      // Not archived (yet): fall back to the server copy.
      const job = jobs.get(id);
      if (!job || job.data.status !== "done") return;
      const base = `${API}/jobs/${id}`;
      src = {
        id, name: job.data.result.output_name, result: job.data.result, finished: job.data.finished,
        pdfUrl: `${base}/pdf?inline=true`, txtUrl: `${base}/txt`,
        loadText: async () => { const r = await fetch(`${base}/txt?inline=true`); if (!r.ok) throw new Error(); return r.text(); },
        revoke: () => {},
      };
    }
    showPreview(src, page);
  }

  function showPreview(src, page) {
    const same = current?.id === src.id;
    current?.revoke();
    current = src;
    const r = src.result;
    el.previewName.textContent = src.name;
    el.previewName.title = src.name;
    el.previewMeta.textContent = [
      src.finished && fmtDate(src.finished),
      `${r.pages} page${r.pages === 1 ? "" : "s"}`,
      fmtBytes(r.size_bytes),
    ].filter(Boolean).join(" · ");

    const options = r.sections.map((s) => {
      const o = document.createElement("option");
      o.value = s.page;
      o.textContent = `${"\u2003".repeat(s.level - 1)}${s.title} — p. ${s.page}`;
      return o;
    });
    const placeholder = new Option(`Jump to section (${r.section_count})`, "");
    el.previewSections.replaceChildren(placeholder, ...options);
    el.previewSections.hidden = !r.sections.length;

    setPreviewTab("pdf");
    el.textBody.textContent = "";
    el.textBody.dataset.loaded = "";
    showPdfPage(page);

    if (el.preview.hidden) {
      el.preview.hidden = false;
      el.shell.classList.add("preview-open");
      if (!reducedMotion.matches && !same) {
        el.preview.animate(
          [{ opacity: 0, transform: "translateX(1.5rem)" }, { opacity: 1, transform: "none" }],
          { duration: 360, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
        );
      }
    }
    document.body.classList.toggle("sheet-open", isSheet());
    markActive();
  }

  function showPdfPage(page) {
    if (!current) return;
    // The fragment is understood by the built-in PDF viewers (Chrome, Firefox, Safari).
    const frag = page ? `#page=${page}` : "";
    el.previewFrame.src = `${current.pdfUrl}${frag}`;
    el.previewOpen.href = `${current.pdfUrl}${frag}`;
    el.previewDl.href = current.pdfUrl;
    el.previewDl.download = current.name;
  }

  async function setPreviewTab(tab) {
    el.previewTab.querySelector(`input[value="${tab}"]`).checked = true;
    const text = tab === "text";
    el.previewFrame.hidden = text;
    el.previewText.hidden = !text;
    el.previewSections.disabled = text;
    if (!current) return;
    el.previewDl.href = text ? current.txtUrl : current.pdfUrl;
    el.previewDl.download = text ? current.result.text_name : current.name;
    if (text && !el.textBody.dataset.loaded) {
      const src = current;
      el.textNote.textContent = "Loading…";
      try {
        const body = await src.loadText();
        if (current !== src) return;
        el.textBody.textContent = body.trim() ? body : "";
        el.textBody.dataset.loaded = "1";
        el.textNote.textContent = body.trim()
          ? `${src.result.text_chars.toLocaleString()} characters`
          : "No text was recognized in this document.";
      } catch {
        if (current === src) el.textNote.textContent = "Could not load the text.";
      }
    }
  }

  function closePreview() {
    if (!current) return;
    const src = current;
    current = null;
    const finish = () => {
      el.preview.hidden = true;
      el.shell.classList.remove("preview-open");
      document.body.classList.remove("sheet-open");
      el.previewFrame.removeAttribute("src");
      src.revoke();
    };
    if (reducedMotion.matches) finish();
    else {
      el.preview.animate(
        [{ opacity: 1, transform: "none" }, { opacity: 0, transform: isSheet() ? "translateY(2rem)" : "translateX(1.5rem)" }],
        { duration: 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
      ).finished.catch(() => {}).then(() => { if (!current) finish(); });
    }
    markActive();
  }

  const sheetQuery = matchMedia("(max-width: 899px)");
  const isSheet = () => sheetQuery.matches;

  function markActive() {
    for (const node of el.history.querySelectorAll(".h-item")) node.classList.toggle("active", node.dataset.id === current?.id);
  }

  // ---------------------------------------------------------------- options

  function renderLanguages(selected) {
    const name = (code) => LANG_NAMES[code] || code;
    const ordered = [...config.languages].sort((a, b) =>
      (b === config.default_language) - (a === config.default_language) || name(a).localeCompare(name(b)));
    el.languages.replaceChildren(
      ...ordered.map((code) => {
        const label = document.createElement("label");
        label.className = "chip";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.value = code;
        input.checked = selected.includes(code);
        const span = document.createElement("span");
        span.textContent = name(code);
        span.title = code;
        label.append(input, span);
        return label;
      }),
    );
  }

  function readOptions() {
    const languages = [...el.languages.querySelectorAll("input:checked")].map((i) => i.value);
    return {
      languages: languages.length ? languages : [config.default_language],
      mode: document.querySelector('input[name="mode"]:checked').value,
      rotate: el.rotate.checked,
      deskew: el.deskew.checked,
      clean: el.clean.checked,
      combine: el.combine.checked,
    };
  }

  function applyOptions(o) {
    renderLanguages((o.languages || []).filter((l) => config.languages.includes(l)).length
      ? o.languages : [config.default_language]);
    const mode = document.querySelector(`input[name="mode"][value="${o.mode}"]`);
    if (mode) mode.checked = true;
    if (typeof o.rotate === "boolean") el.rotate.checked = o.rotate;
    if (typeof o.deskew === "boolean") el.deskew.checked = o.deskew;
    if (typeof o.clean === "boolean") el.clean.checked = o.clean;
    if (typeof o.combine === "boolean") el.combine.checked = o.combine;
    syncOptionUI();
  }

  function syncOptionUI() {
    const o = readOptions();
    el.modeHint.textContent = MODE_HINTS[o.mode];
    el.deskew.disabled = o.mode === "redo";
    el.deskew.parentElement.title = o.mode === "redo" ? "Not available in Redo mode" : "";
    el.combineBox.hidden = staged.length < 2;
    el.title.hidden = !(o.combine && staged.length > 1);
    const n = staged.length;
    el.start.textContent = n > 1 && o.combine ? `Combine & process ${n} files` : `Process ${n} file${n === 1 ? "" : "s"}`;
  }

  // ---------------------------------------------------------------- staging

  function addFiles(fileList) {
    const accepted = new Set(config.accepted_extensions);
    const rejected = [];
    for (const f of fileList) {
      if (accepted.size && !accepted.has(extOf(f.name))) rejected.push(`${f.name} (unsupported type)`);
      else if (f.size > config.max_file_mb * 1024 * 1024) rejected.push(`${f.name} (over ${config.max_file_mb} MB)`);
      else if (f.size === 0) rejected.push(`${f.name} (empty)`);
      else if (!staged.some((s) => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified)) staged.push(f);
    }
    if (rejected.length) alertInline(`Skipped: ${rejected.join(", ")}`);
    renderStaged();
  }

  function renderStaged() {
    el.staging.hidden = staged.length === 0;
    el.stagedList.replaceChildren(
      ...staged.map((f, i) => {
        const li = document.createElement("li");
        if (shownStaged.has(f)) li.style.animation = "none";
        shownStaged.add(f);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = f.name;
        name.title = f.name;
        const size = document.createElement("span");
        size.className = "muted";
        size.textContent = fmtBytes(f.size);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "icon-btn";
        rm.setAttribute("aria-label", `Remove ${f.name}`);
        rm.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        rm.addEventListener("click", () => { staged.splice(i, 1); renderStaged(); });
        li.append(name, size, rm);
        return li;
      }),
    );
    syncOptionUI();
  }

  let alertTimer;
  function alertInline(msg) {
    let box = $("#inline-alert");
    if (!box) {
      box = document.createElement("div");
      box.id = "inline-alert";
      box.className = "job-error";
      box.style.marginLeft = "0";
      box.setAttribute("role", "status");
      el.dropzone.after(box);
    }
    box.textContent = msg;
    box.hidden = false;
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => { box.hidden = true; }, 7000);
  }

  function startProcessing() {
    if (!staged.length) return;
    const o = readOptions();
    storage.set(STORE_OPTS, o);
    const groups = o.combine && staged.length > 1
      ? chunk(staged, config.max_files_per_job)
      : staged.map((f) => [f]);
    for (const files of groups) submit(files, o);
    staged = [];
    el.title.value = "";
    renderStaged();
  }

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // ---------------------------------------------------------------- jobs

  function submit(files, o) {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    form.append("languages", o.languages.join("+"));
    form.append("mode", o.mode);
    form.append("rotate", o.rotate);
    form.append("deskew", o.deskew && o.mode !== "redo");
    form.append("clean", o.clean);
    if (files.length > 1 && el.title.value.trim()) form.append("title", el.title.value.trim());

    const tempId = `tmp-${Math.random().toString(36).slice(2)}`;
    const job = createJobCard(tempId, {
      status: "uploading", stage: "Uploading…", progress: 0,
      files: files.map((f) => ({ name: f.name, size: f.size })),
    });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API}/jobs`);
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = e.loaded / e.total;
      updateJob(job, { status: "uploading", stage: `Uploading… ${Math.round(pct * 100)}%`, progress: pct });
    };
    xhr.onload = () => {
      if (xhr.status === 202 && xhr.response?.id) {
        jobs.delete(tempId);
        job.id = xhr.response.id;
        job.node.dataset.id = job.id;
        jobs.set(job.id, job);
        persistJobs();
        updateJob(job, xhr.response);
        schedulePoll(0);
      } else {
        const detail = xhr.response?.detail;
        updateJob(job, { status: "error", error: typeof detail === "string" ? detail : `Upload failed (${xhr.status}).` });
      }
    };
    xhr.onerror = () => updateJob(job, { status: "error", error: "Network error during upload." });
    xhr.send(form);
  }

  function createJobCard(id, data) {
    const node = el.template.content.firstElementChild.cloneNode(true);
    node.dataset.id = id;
    const refs = {
      icon: node.querySelector(".job-icon"),
      name: node.querySelector(".job-name"),
      stage: node.querySelector(".job-stage"),
      pill: node.querySelector(".pill"),
      bar: node.querySelector(".bar span"),
      done: node.querySelector(".job-done"),
      meta: node.querySelector(".job-meta"),
      dlPdf: node.querySelector(".dl-pdf"),
      showPreview: node.querySelector(".show-preview"),
      dlTxt: node.querySelector(".dl-txt"),
      toggleSections: node.querySelector(".toggle-sections"),
      outline: node.querySelector(".outline"),
      error: node.querySelector(".job-error"),
      remove: node.querySelector(".job-remove"),
    };
    const job = { id, data: {}, node, refs, outlineRendered: false };
    const names = data.files.map((f) => f.name);
    refs.name.textContent = names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0];
    refs.name.title = names.join("\n");
    refs.icon.textContent = names.length > 1 ? `×${names.length}` : (extOf(names[0]).slice(1, 5).toUpperCase() || "FILE");
    refs.remove.addEventListener("click", () => removeJob(job));
    refs.showPreview.addEventListener("click", () => openPreview(job.id));
    refs.toggleSections.addEventListener("click", () => {
      const open = refs.outline.hidden;
      if (open && !job.outlineRendered) renderOutline(job);
      refs.outline.hidden = !open;
      refs.toggleSections.setAttribute("aria-expanded", String(open));
    });
    jobs.set(id, job);
    el.jobList.prepend(node);
    el.results.hidden = false;
    updateJob(job, data);
    return job;
  }

  function updateJob(job, data) {
    const wasDone = job.data.status === "done";
    const d = Object.assign(job.data, data);
    if (d.status === "done" && !wasDone && !job.id.startsWith("tmp-")) {
      // Jobs finishing while the page is open get previewed; restored ones are only archived.
      const live = !job.restored;
      archiveJob(job).then(() => { if (live && jobs.has(job.id)) openPreview(job.id); });
    }
    const { refs, node } = job;
    node.dataset.status = d.status;
    refs.pill.textContent = STATUS_LABEL[d.status] || d.status;

    if (d.status === "queued") {
      refs.stage.textContent = d.queue_position > 1 ? `Waiting in queue (#${d.queue_position})` : "Waiting for a free worker…";
    } else if (d.status === "uploading" || d.status === "processing") {
      refs.stage.textContent = d.status === "processing" ? `${d.stage} · ${Math.round(d.progress * 100)}%` : d.stage;
      refs.bar.style.width = `${Math.max(2, d.progress * 100)}%`;
    } else if (d.status === "done") {
      const r = d.result;
      refs.stage.textContent = `Finished in ${fmtSeconds(r.duration)}`;
      const sourceNote = {
        existing: "from document",
        detected: "detected",
        pages: "per page",
        files: "per file",
        "files+headings": "per file + detected",
        none: "",
      }[r.section_source] || "";
      const parts = [
        `${r.pages} page${r.pages === 1 ? "" : "s"}`,
        r.section_count ? `${r.section_count} section${r.section_count === 1 ? "" : "s"}${sourceNote ? ` (${sourceNote})` : ""}` : "no sections",
        fmtBytes(r.size_bytes),
        r.text_chars ? `${r.text_chars.toLocaleString()} characters` : "no text found",
      ];
      refs.meta.textContent = parts.join(" · ");
      const base = `${API}/jobs/${job.id}`;
      refs.dlPdf.href = `${base}/pdf`;
      refs.dlTxt.href = `${base}/txt`;
      refs.toggleSections.hidden = !r.section_count;
      refs.done.hidden = false;
    } else if (d.status === "error") {
      refs.stage.textContent = "";
      refs.error.textContent = d.error || "Something went wrong.";
      refs.error.hidden = false;
    }
  }

  function renderOutline(job) {
    const r = job.data.result;
    const href = `${API}/jobs/${job.id}/pdf?inline=true`;
    const items = r.sections.map((s) => {
      const li = document.createElement("li");
      li.className = `l${s.level}`;
      const a = document.createElement("a");
      a.href = `${href}#page=${s.page}`;
      a.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        if (current?.id === job.id) { setPreviewTab("pdf"); showPdfPage(s.page); }
        else openPreview(job.id, s.page);
      });
      a.style.paddingLeft = `${8 + (s.level - 1) * 16}px`;
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = s.title;
      t.title = s.title;
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = `p. ${s.page}`;
      a.append(t, p);
      li.append(a);
      return li;
    });
    if (r.section_count > r.sections.length) {
      const li = document.createElement("li");
      li.className = "more";
      li.textContent = `…and ${r.section_count - r.sections.length} more in the PDF`;
      items.push(li);
    }
    job.refs.outline.replaceChildren(...items);
    job.outlineRendered = true;
  }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  async function removeJob(job) {
    jobs.delete(job.id);
    persistJobs();
    // Leave along the path it arrived on (up and out), starting from where it is now.
    const exit = reducedMotion.matches
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{}, { opacity: 0, transform: "translateY(-0.75rem) scale(0.98)" }];
    job.node.style.pointerEvents = "none";
    job.node.animate(exit, { duration: reducedMotion.matches ? 150 : 220, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "forwards" })
      .finished.catch(() => {}).then(() => {
        job.node.remove();
        el.results.hidden = jobs.size === 0;
      });
    if (!job.id.startsWith("tmp-")) {
      try { await api(`jobs/${job.id}`, { method: "DELETE" }); } catch { /* already gone */ }
    }
  }

  function persistJobs() {
    storage.set(STORE_JOBS, [...jobs.keys()].filter((id) => !id.startsWith("tmp-")));
  }

  // ---------------------------------------------------------------- polling

  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay ?? (document.hidden ? POLL_HIDDEN_MS : POLL_MS));
  }

  async function poll() {
    const active = [...jobs.values()].filter((j) => !j.id.startsWith("tmp-") && (j.data.status === "queued" || j.data.status === "processing"));
    if (!active.length) return;
    await Promise.all(active.map(async (job) => {
      try {
        updateJob(job, await api(`jobs/${job.id}`));
      } catch (err) {
        if (err.status === 404) updateJob(job, { status: "error", error: "This job no longer exists on the server." });
      }
    }));
    schedulePoll();
  }

  async function restoreJobs() {
    const ids = storage.get(STORE_JOBS, []);
    const results = await Promise.all(ids.map((id) => api(`jobs/${id}`).catch(() => null)));
    // Stored newest-last; prepend oldest first so the newest ends up on top.
    results.forEach((data, i) => {
      if (!data) return;
      const job = createJobCard(ids[i], { status: "queued", files: data.files });
      job.restored = data.status === "done";
      updateJob(job, data);
    });
    persistJobs();
    schedulePoll(0);
  }

  // ---------------------------------------------------------------- wiring

  function wire() {
    el.input.addEventListener("change", () => { addFiles(el.input.files); el.input.value = ""; });
    el.dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.input.click(); }
    });

    let depth = 0;
    window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; el.dropzone.classList.add("over"); });
    window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.dropzone.classList.remove("over"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      el.dropzone.classList.remove("over");
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });

    window.addEventListener("paste", (e) => {
      if (e.target.closest?.("input, textarea")) return;
      const files = [...(e.clipboardData?.items || [])]
        .filter((it) => it.kind === "file")
        .map((it, i) => {
          const f = it.getAsFile();
          if (!f) return null;
          const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg");
          return f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}-${i}.${ext}`, { type: f.type });
        })
        .filter(Boolean);
      if (files.length) addFiles(files);
    });

    document.querySelector(".options").addEventListener("change", () => {
      syncOptionUI();
      storage.set(STORE_OPTS, readOptions());
    });
    el.start.addEventListener("click", startProcessing);
    el.clearStaged.addEventListener("click", () => { staged = []; renderStaged(); });
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && staged.length) startProcessing();
    });
    el.clearFinished.addEventListener("click", () => {
      for (const job of [...jobs.values()]) {
        if (job.data.status === "done" || job.data.status === "error") removeJob(job);
      }
    });
    el.toggleSidebar.addEventListener("click", () => setSidebar(!el.shell.classList.contains("sidebar-open")));
    el.scrim.addEventListener("click", () => setSidebar(false));
    el.historySearch.addEventListener("input", renderHistory);
    el.clearHistory.addEventListener("click", clearHistoryClicked);
    drawerQuery.addEventListener("change", () => setSidebar(isDrawer() ? false : storage.get(STORE_SIDEBAR, true), false));
    sheetQuery.addEventListener("change", () => document.body.classList.toggle("sheet-open", Boolean(current) && isSheet()));

    el.previewClose.addEventListener("click", closePreview);
    el.previewTab.addEventListener("change", (e) => setPreviewTab(e.target.value));
    el.previewSections.addEventListener("change", () => {
      const page = Number(el.previewSections.value);
      if (page) showPdfPage(page);
      el.previewSections.value = "";
    });
    el.textCopy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.textBody.textContent);
        el.textCopy.textContent = "Copied";
        setTimeout(() => { el.textCopy.textContent = "Copy"; }, 1500);
      } catch { /* clipboard blocked */ }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (isDrawer() && el.shell.classList.contains("sidebar-open")) setSidebar(false);
      else if (current && !e.target.closest?.("input, select, textarea")) closePreview();
    });

    const syncTopbar = () => el.topbar.classList.toggle("scrolled", window.scrollY > 4);
    window.addEventListener("scroll", syncTopbar, { passive: true });
    syncTopbar();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); });
  }

  async function init() {
    wire();
    setSidebar(isDrawer() ? false : storage.get(STORE_SIDEBAR, true), false);
    // Ask the browser not to evict saved results under storage pressure (best effort).
    navigator.storage?.persist?.().catch(() => {});
    await loadHistory();
    try {
      config = { ...config, ...(await api("config")) };
    } catch {
      alertInline("Could not reach the server. Check that the backend is running.");
    }
    el.ttlNote.textContent = `Server copies are deleted after ${Math.round(config.job_ttl_minutes / 60 * 10) / 10} h · results stay in this browser`;
    el.acceptedNote.textContent = `PDF, JPG, PNG, TIFF, HEIC, TXT, MD… up to ${config.max_file_mb} MB each`;
    el.input.accept = config.accepted_extensions.join(",");
    applyOptions(storage.get(STORE_OPTS, {}));
    restoreJobs();
  }

  init();
})();
