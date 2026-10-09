"use strict";

(() => {
  const API = "api";
  const STORE_JOBS = "ocrdesk.jobs";
  const STORE_OPTS = "ocrdesk.options";
  const STORE_LIB = "ocrdesk.library";
  const POLL_MS = 700;
  const POLL_HIDDEN_MS = 3000;
  const THUMB_W = 360; // library thumbnail width in px (cards show ~180 CSS px)
  const RAIL_W = 120; // page strip thumbnail width in CSS px
  const PAGE_MAX_W = 960; // widest a page is drawn in the viewer, in CSS px
  const A4 = 297 / 210;

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
  // Natural direction for each sort key the first time it is picked.
  const SORT_DEFAULT_DIR = { date: -1, name: 1, pages: -1, size: -1 };

  const $ = (sel) => document.querySelector(sel);
  const storage = {
    get(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
    },
  };
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
    main: $("main"),
    library: $("#library"),
    librarySub: $("#library-sub"),
    libSearch: $("#lib-search"),
    libSort: $("#lib-sort"),
    libView: $("#lib-view"),
    libGrid: $("#lib-grid"),
    libTableWrap: $("#lib-table-wrap"),
    libRows: $("#lib-rows"),
    libEmpty: $("#lib-empty"),
    libEmptyTitle: $("#lib-empty-title"),
    libEmptyText: $("#lib-empty-text"),
    libFoot: $("#lib-foot"),
    storageNote: $("#storage-note"),
    clearLibrary: $("#clear-library"),
    tileTemplate: $("#tile-template"),
    viewer: $("#viewer"),
    viewerBackdrop: $("#viewer-backdrop"),
    viewerPanel: $("#viewer-panel"),
    viewerName: $("#viewer-name"),
    viewerMeta: $("#viewer-meta"),
    viewerTab: $("#viewer-tab"),
    viewerOpen: $("#viewer-open"),
    viewerDl: $("#viewer-dl"),
    viewerClose: $("#viewer-close"),
    rail: $("#rail"),
    railTab: $("#rail-tab"),
    railPages: $("#rail-pages"),
    railSections: $("#rail-sections"),
    viewerSections: $("#viewer-sections"),
    docView: $("#doc-view"),
    docPages: $("#doc-pages"),
    viewerText: $("#viewer-text"),
    textNote: $("#text-note"),
    textBody: $("#text-body"),
    textCopy: $("#text-copy"),
  };

  let config = { languages: ["eng"], default_language: "eng", accepted_extensions: [], max_file_mb: 100, max_files_per_job: 20 };
  let staged = [];
  const shownStaged = new WeakSet(); // files whose chip has already animated in
  const jobs = new Map(); // id -> { data, node, refs }
  let pollTimer = null;
  let library = []; // saved conversions (metadata + thumbnail, no files)
  const libState = { view: "grid", sort: "date", dir: -1, ...storage.get(STORE_LIB, {}) };
  const thumbUrls = new Map(); // id -> object URL of the card thumbnail
  let current = null; // what the viewer shows: { id, name, result, finished, pdfUrl, txtUrl, loadPdf, loadText, revoke }

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const SPRING = "cubic-bezier(0.32, 0.72, 0, 1)";

  // ---------------------------------------------------------------- utils

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function fmtSeconds(s) {
    return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  }

  function fmtPages(n) {
    return `${n} page${n === 1 ? "" : "s"}`;
  }

  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  function fmtDate(ts) {
    const d = new Date(ts * 1000);
    const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 864e5);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (days === 0) return `Today, ${time}`;
    if (days === 1) return `Yesterday, ${time}`;
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function extOf(name) {
    const i = name.lastIndexOf(".");
    return i >= 0 ? name.slice(i).toLowerCase() : "";
  }

  function badgeFor(files) {
    return files.length > 1 ? `×${files.length}` : (extOf(files[0].name).slice(1, 5).toUpperCase() || "FILE");
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

  function icon(path) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
  }
  const ICON_X = icon('<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>');
  const ICON_DL = icon('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>');

  // ---------------------------------------------------------------- PDF rendering (pdf.js, loaded on demand)

  let pdfjsLoading;
  function pdfjs() {
    pdfjsLoading ??= import("./vendor/pdfjs/pdf.min.js").then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
      return lib;
    });
    return pdfjsLoading;
  }

  async function openPdf(blob) {
    const lib = await pdfjs();
    return lib.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      isEvalSupported: false,
      standardFontDataUrl: "vendor/pdfjs/standard_fonts/",
    }).promise;
  }

  async function renderPage(doc, number, width) {
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    return canvas;
  }

  async function makeThumb(pdfBlob) {
    const doc = await openPdf(pdfBlob);
    try {
      const canvas = await renderPage(doc, 1, THUMB_W);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      return { thumb: blob, ratio: canvas.height / canvas.width };
    } finally {
      doc.destroy();
    }
  }

  // ---------------------------------------------------------------- local archive (IndexedDB)

  // Output files are kept in the browser so the library outlives the server's TTL.
  // Metadata (with the small thumbnail) and the files live in separate stores so
  // listing the library never loads the PDFs.
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
      files: (id) => run("files", "readonly", (s) => s.get(id)),
      putMeta: (meta) => run("conversions", "readwrite", (s) => { s.put(meta); }),
      save: (meta, files) => run(["conversions", "files"], "readwrite", (m, f) => { f.put(files, meta.id); m.put(meta); }),
      remove: (id) => run(["conversions", "files"], "readwrite", (m, f) => { m.delete(id); f.delete(id); }),
      clear: () => run(["conversions", "files"], "readwrite", (m, f) => { m.clear(); f.clear(); }),
    };
  })();

  const archiving = new Map(); // id -> promise

  function archiveJob(job) {
    const id = job.id;
    if (library.some((h) => h.id === id)) return Promise.resolve(true);
    if (!archiving.has(id)) {
      archiving.set(id, doArchive(job).finally(() => archiving.delete(id)));
    }
    return archiving.get(id);
  }

  async function doArchive(job) {
    const id = job.id;
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
        ...(await makeThumb(pdf).catch(() => ({}))),
      };
      await db.save(meta, { pdf, txt });
      await loadLibrary();
      return true;
    } catch (err) {
      console.warn("Could not save conversion locally", err);
      if (err?.name === "QuotaExceededError") alertInline("Browser storage is full — delete some documents from the Library to keep new results.");
      return false;
    }
  }

  // Records saved before thumbnails existed get one the first time they are listed.
  const backfilling = new Set();
  async function backfillThumbs() {
    for (const meta of library) {
      if (meta.thumb || backfilling.has(meta.id)) continue;
      backfilling.add(meta.id);
      try {
        const files = await db.files(meta.id);
        if (!files?.pdf) continue;
        Object.assign(meta, await makeThumb(files.pdf));
        await db.putMeta(meta);
        renderLibrary();
        refreshJobThumb(meta.id);
      } catch { /* leave the placeholder */ }
    }
  }

  function thumbUrl(meta) {
    if (!meta?.thumb) return null;
    if (!thumbUrls.has(meta.id)) thumbUrls.set(meta.id, URL.createObjectURL(meta.thumb));
    return thumbUrls.get(meta.id);
  }

  function forgetThumb(id) {
    const url = thumbUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    thumbUrls.delete(id);
  }

  async function deleteDocument(id) {
    if (current?.id === id) closeViewer();
    await db.remove(id).catch(() => {});
    forgetThumb(id);
    loadLibrary();
  }

  // ---------------------------------------------------------------- library

  async function loadLibrary() {
    try {
      library = await db.list();
    } catch {
      library = [];
      el.libEmptyTitle.textContent = "Library unavailable";
      el.libEmptyText.textContent = "This browser is blocking local storage, so converted files can't be kept.";
    }
    const ids = new Set(library.map((m) => m.id));
    for (const id of [...thumbUrls.keys()]) if (!ids.has(id)) forgetThumb(id);
    renderLibrary();
    backfillThumbs();
  }

  function sortedLibrary() {
    const q = el.libSearch.value.trim().toLowerCase();
    const items = q
      ? library.filter((m) => m.name.toLowerCase().includes(q) || m.files.some((f) => f.name.toLowerCase().includes(q)))
      : [...library];
    const key = {
      date: (m) => m.finished,
      name: (m) => m.name.toLowerCase(),
      pages: (m) => m.result.pages,
      size: (m) => m.result.size_bytes,
    }[libState.sort];
    return items.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = typeof ka === "string" ? ka.localeCompare(kb, undefined, { numeric: true }) : ka - kb;
      return c * libState.dir || b.finished - a.finished;
    });
  }

  function renderLibrary() {
    const items = sortedLibrary();
    const n = library.length;
    const total = library.reduce((s, m) => s + (m.size || 0), 0);
    el.librarySub.textContent = n
      ? `${n} document${n === 1 ? "" : "s"}, kept in this browser.`
      : "Converted files are kept in this browser.";
    el.storageNote.textContent = n ? `Using ${fmtBytes(total)} of browser storage` : "";
    el.libFoot.hidden = n === 0;

    const searching = n > 0 && items.length === 0;
    el.libEmpty.hidden = items.length > 0;
    if (searching) {
      el.libEmptyTitle.textContent = "No matches";
      el.libEmptyText.textContent = `Nothing in your library matches “${el.libSearch.value.trim()}”.`;
    } else if (!n && el.libEmptyTitle.textContent === "No matches") {
      el.libEmptyTitle.textContent = "No documents yet";
      el.libEmptyText.textContent = "Files you convert are saved here, in this browser.";
    }

    const grid = libState.view === "grid";
    el.libGrid.hidden = !grid || !items.length;
    el.libTableWrap.hidden = grid || !items.length;
    el.libView.querySelector(`input[value="${libState.view}"]`).checked = true;
    el.libSort.value = libState.sort;
    for (const b of el.libTableWrap.querySelectorAll("th button")) {
      const th = b.parentElement;
      if (b.dataset.sort === libState.sort) th.setAttribute("aria-sort", libState.dir > 0 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    }

    if (grid) el.libGrid.replaceChildren(...items.map(libraryTile));
    else el.libRows.replaceChildren(...items.map(libraryRow));
    markActive();
  }

  function fillThumb(box, meta) {
    const url = thumbUrl(meta);
    box.style.setProperty("--ratio", String(Math.min(meta.ratio || A4, 1.6)));
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.decoding = "async";
      box.replaceChildren(img);
      box.classList.add("has-img");
    } else {
      box.querySelector(".thumb-ext").textContent = badgeFor(meta.files);
    }
  }

  function libraryTile(meta) {
    const node = el.tileTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = meta.id;
    fillThumb(node.querySelector(".thumb"), meta);
    const name = node.querySelector(".tile-name");
    name.textContent = meta.name;
    name.title = meta.files.map((f) => f.name).join("\n");
    node.querySelector(".tile-meta").textContent = `${fmtDate(meta.finished)} · ${fmtPages(meta.result.pages)}`;
    node.querySelector(".tile-open").addEventListener("click", () => openViewer(meta.id));
    const rm = node.querySelector(".tile-remove");
    rm.setAttribute("aria-label", `Delete ${meta.name}`);
    rm.addEventListener("click", () => deleteDocument(meta.id));
    return node;
  }

  function libraryRow(meta) {
    const tr = document.createElement("tr");
    tr.dataset.id = meta.id;

    const nameCell = document.createElement("td");
    nameCell.className = "c-name";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "row-open";
    const thumb = document.createElement("span");
    thumb.className = "thumb thumb-sm";
    thumb.innerHTML = '<span class="thumb-ext" aria-hidden="true"></span>';
    fillThumb(thumb, meta);
    const label = document.createElement("span");
    label.className = "row-name";
    label.textContent = meta.name;
    open.title = meta.files.map((f) => f.name).join("\n");
    open.append(thumb, label);
    open.addEventListener("click", () => openViewer(meta.id));
    nameCell.append(open);

    const cell = (cls, text) => {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      return td;
    };

    const act = document.createElement("td");
    act.className = "c-act";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "icon-btn";
    dl.title = "Download PDF";
    dl.setAttribute("aria-label", `Download ${meta.name}`);
    dl.innerHTML = ICON_DL;
    dl.addEventListener("click", () => downloadLocal(meta));
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "icon-btn";
    rm.title = "Delete";
    rm.setAttribute("aria-label", `Delete ${meta.name}`);
    rm.innerHTML = ICON_X;
    rm.addEventListener("click", () => deleteDocument(meta.id));
    act.append(dl, rm);

    tr.append(
      nameCell,
      cell("c-num", meta.result.pages.toLocaleString()),
      cell("c-num", fmtBytes(meta.result.size_bytes)),
      cell("c-date", fmtDate(meta.finished)),
      act,
    );
    tr.addEventListener("dblclick", () => openViewer(meta.id));
    return tr;
  }

  async function downloadLocal(meta) {
    const files = await db.files(meta.id).catch(() => null);
    if (!files?.pdf) return;
    const url = URL.createObjectURL(files.pdf);
    const a = document.createElement("a");
    a.href = url;
    a.download = meta.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function setSort(key, toggle) {
    if (toggle && libState.sort === key) libState.dir = -libState.dir;
    else { libState.sort = key; libState.dir = SORT_DEFAULT_DIR[key]; }
    storage.set(STORE_LIB, libState);
    renderLibrary();
  }

  let clearArmed;
  function clearLibraryClicked() {
    // Two-step confirm without a blocking dialog.
    if (!clearArmed) {
      el.clearLibrary.textContent = "Click again to delete all";
      el.clearLibrary.classList.add("danger");
      clearArmed = setTimeout(disarmClear, 3000);
      return;
    }
    disarmClear();
    if (current && library.some((m) => m.id === current.id)) closeViewer();
    db.clear().catch(() => {}).then(loadLibrary);
  }
  function disarmClear() {
    clearTimeout(clearArmed);
    clearArmed = null;
    el.clearLibrary.textContent = "Delete all";
    el.clearLibrary.classList.remove("danger");
  }

  function markActive() {
    for (const node of el.library.querySelectorAll("[data-id]")) node.classList.toggle("active", node.dataset.id === current?.id);
  }

  // ---------------------------------------------------------------- viewer

  async function sourceFor(id) {
    const meta = library.find((m) => m.id === id);
    if (meta) {
      const files = await db.files(id).catch(() => null);
      if (files?.pdf) {
        const pdfUrl = URL.createObjectURL(files.pdf);
        const txtUrl = URL.createObjectURL(files.txt);
        return {
          id, name: meta.name, result: meta.result, finished: meta.finished, ratio: meta.ratio, pdfUrl, txtUrl,
          loadPdf: async () => files.pdf,
          loadText: () => files.txt.text(),
          revoke: () => { URL.revokeObjectURL(pdfUrl); URL.revokeObjectURL(txtUrl); },
        };
      }
    }
    // Not archived (yet): fall back to the server copy.
    const job = jobs.get(id);
    if (!job || job.data.status !== "done") return null;
    const base = `${API}/jobs/${id}`;
    const fetchOk = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r; };
    return {
      id, name: job.data.result.output_name, result: job.data.result, finished: job.data.finished,
      pdfUrl: `${base}/pdf?inline=true`, txtUrl: `${base}/txt`,
      loadPdf: async () => (await fetchOk(`${base}/pdf?inline=true`)).blob(),
      loadText: async () => (await fetchOk(`${base}/txt?inline=true`)).text(),
      revoke: () => {},
    };
  }

  let viewerDoc = null; // pdf.js document backing the page strip
  let pageObserver = null;
  let lastFocus = null;

  async function openViewer(id, page) {
    const src = await sourceFor(id);
    if (!src) return;
    const opening = el.viewer.hidden;
    teardownDocument();
    current?.revoke();
    current = src;

    const r = src.result;
    el.viewerName.textContent = src.name;
    el.viewerName.title = src.name;
    el.viewerMeta.textContent = [src.finished && fmtDate(src.finished), fmtPages(r.pages), fmtBytes(r.size_bytes)]
      .filter(Boolean).join(" · ");

    buildSections(r);
    const docPromise = src.loadPdf().then(openPdf);
    viewerDoc = docPromise;
    buildPageStrip(src, docPromise);
    buildStage(src, docPromise);
    setViewerTab("pdf");
    el.textBody.textContent = "";
    el.textBody.dataset.loaded = "";

    if (opening) {
      lastFocus = document.activeElement;
      el.viewer.hidden = false;
      document.body.classList.add("viewer-open");
      el.main.inert = true;
      el.topbar.inert = true;
      if (!reducedMotion.matches) {
        el.viewerBackdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
        el.viewerPanel.animate(
          [{ opacity: 0, transform: "translateY(1rem) scale(0.985)" }, { opacity: 1, transform: "none" }],
          { duration: 380, easing: SPRING },
        );
      }
      el.viewerClose.focus({ preventScroll: true });
    }
    // Positions are only known once the viewer is visible.
    showPdfPage(page || 1, Boolean(page));
    markActive();
  }

  function buildSections(r) {
    // One-section-per-page outlines add nothing next to the page strip.
    const sections = r.section_source === "pages" ? [] : r.sections;
    const hasSections = sections.length > 0;
    el.railSections.replaceChildren(...sections.map((s) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = `l${Math.min(s.level, 4)}`;
      b.style.setProperty("--level", String(s.level - 1));
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = s.title;
      t.title = s.title;
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = s.page;
      b.append(t, p);
      b.addEventListener("click", () => { setViewerTab("pdf"); showPdfPage(s.page); });
      li.append(b);
      return li;
    }));
    if (hasSections && r.section_count > sections.length) {
      const li = document.createElement("li");
      li.className = "more muted small";
      li.textContent = `…and ${r.section_count - r.sections.length} more in the PDF's bookmarks`;
      el.railSections.append(li);
    }
    el.railTab.querySelector('input[value="sections"]').disabled = !hasSections;
    el.railTab.classList.toggle("single", !hasSections);

    // Compact jump menu for narrow screens, where the rail is hidden.
    const options = sections.map((s) => new Option(`${" ".repeat(s.level - 1)}${s.title} — p. ${s.page}`, s.page));
    el.viewerSections.replaceChildren(new Option(`Jump to section (${r.section_count})`, ""), ...options);
    el.viewerSections.hidden = !hasSections;

    setRailTab(hasSections && r.pages > 1 && sections.length > 1 ? "sections" : "pages");
  }

  function buildPageStrip(src, docPromise) {
    const total = src.result.pages;
    const ratio = src.ratio || A4;
    el.railPages.style.setProperty("--ratio", String(Math.min(ratio, 1.6)));
    const items = [];
    for (let n = 1; n <= total; n++) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "page";
      b.dataset.page = n;
      b.setAttribute("aria-label", `Page ${n}`);
      b.innerHTML = `<span class="page-img"></span><span class="page-no">${n}</span>`;
      b.addEventListener("click", () => { setViewerTab("pdf"); showPdfPage(n); });
      li.append(b);
      items.push(li);
    }
    el.railPages.replaceChildren(...items);
    el.railPages.scrollTop = 0;

    // Render thumbnails lazily as they scroll into view.
    docPromise.catch(() => {
      if (viewerDoc !== docPromise) return;
      el.railPages.classList.add("no-render");
    });
    const width = Math.round(RAIL_W * Math.min(window.devicePixelRatio || 1, 2));
    pageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const btn = entry.target;
        pageObserver.unobserve(btn);
        docPromise.then(async (doc) => {
          if (viewerDoc !== docPromise) return;
          const canvas = await renderPage(doc, Number(btn.dataset.page), width);
          if (viewerDoc !== docPromise) return;
          btn.querySelector(".page-img").replaceChildren(canvas);
          btn.style.setProperty("--ratio", String(canvas.height / canvas.width));
        }).catch(() => {});
      }
    }, { root: el.railPages, rootMargin: "400px 0px" });
    for (const btn of el.railPages.querySelectorAll(".page")) pageObserver.observe(btn);
  }

  // The main view: one slot per page, sized up front so jumps are just a scroll. Pages near
  // the viewport get a canvas plus a text layer (OCR text stays selectable); pages that
  // scroll far away drop them again so long documents stay light.
  let stageObserver = null;
  let stageResize = null;
  let stageWidth = 0;
  let shownPage = 0;
  let scrollFrame = 0;
  let jumpTop = -1; // scroll position set by the last jump; tracking leaves its highlight alone

  function buildStage(src, docPromise) {
    const total = src.result.pages;
    const ratio = String(src.ratio || A4);
    const slots = [];
    for (let n = 1; n <= total; n++) {
      const li = document.createElement("li");
      li.className = "doc-page";
      li.dataset.page = n;
      li.style.setProperty("--ratio", ratio);
      li.setAttribute("aria-label", `Page ${n}`);
      slots.push(li);
    }
    el.docPages.replaceChildren(...slots);
    el.docView.scrollTop = 0;
    shownPage = 0;
    stageWidth = 0;

    docPromise.then(async (doc) => {
      // Exact page shapes, so mixed-size documents still land on the right spot.
      for (const slot of slots) {
        if (viewerDoc !== docPromise) return;
        const page = await doc.getPage(Number(slot.dataset.page));
        const { width, height } = page.getViewport({ scale: 1 });
        slot.style.setProperty("--ratio", String(height / width));
      }
    }).catch(() => {
      if (viewerDoc !== docPromise) return;
      const p = document.createElement("p");
      p.className = "doc-error muted";
      p.textContent = "This PDF can't be shown here. Use Open to view it in your browser.";
      el.docPages.replaceChildren(p);
    });

    stageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const slot = entry.target;
        if (!entry.isIntersecting) {
          if (slot.dataset.drawn) { slot.replaceChildren(); delete slot.dataset.drawn; }
          continue;
        }
        if (slot.dataset.drawn === String(stageWidth)) continue;
        const width = stageWidth;
        slot.dataset.drawn = width;
        docPromise.then((doc) => renderStagePage(doc, Number(slot.dataset.page), width)).then((layers) => {
          if (viewerDoc !== docPromise || slot.dataset.drawn !== String(width)) return;
          slot.replaceChildren(...layers);
        }).catch(() => {});
      }
    }, { root: el.docView, rootMargin: "100% 0px" });

    stageResize = new ResizeObserver(fitStage);
    stageResize.observe(el.docView);
  }

  function fitStage() {
    const width = Math.min(PAGE_MAX_W, Math.max(200, el.docView.clientWidth - 32));
    if (!stageObserver || !el.docView.clientWidth || width === stageWidth) return;
    stageWidth = width;
    el.docPages.style.setProperty("--page-w", `${width}px`);
    // Redraw at the new width: re-observing reports the visible pages again.
    for (const slot of el.docPages.children) { stageObserver.unobserve(slot); stageObserver.observe(slot); }
  }

  async function renderStagePage(doc, number, width) {
    const lib = await pdfjs();
    const canvas = await renderPage(doc, number, Math.round(width * Math.min(window.devicePixelRatio || 1, 2)));
    const page = await doc.getPage(number);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const text = document.createElement("div");
    text.className = "textLayer";
    text.style.setProperty("--scale-factor", String(viewport.scale));
    await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
    return [canvas, text];
  }

  function teardownDocument() {
    pageObserver?.disconnect();
    pageObserver = null;
    stageObserver?.disconnect();
    stageObserver = null;
    stageResize?.disconnect();
    stageResize = null;
    const doc = viewerDoc;
    viewerDoc = null;
    el.railPages.classList.remove("no-render");
    doc?.then((d) => d.destroy()).catch(() => {});
  }

  function showPdfPage(page, scroll = true) {
    if (!current) return;
    fitStage(); // page sizes must be final before measuring where to scroll
    const slot = el.docPages.querySelector(`.doc-page[data-page="${page}"]`);
    if (slot) {
      el.docView.scrollTop = slot.offsetTop - 16;
      jumpTop = el.docView.scrollTop;
    }
    markPage(page, scroll ? (reducedMotion.matches ? "auto" : "smooth") : null);
    if (!el.viewerText.hidden) return;
    el.viewerDl.href = current.pdfUrl;
    el.viewerDl.download = current.name;
  }

  // Highlight the page being read in the strip; scrollRail is a scroll behavior, or null.
  function markPage(page, scrollRail) {
    if (page === shownPage) return;
    shownPage = page;
    el.viewerOpen.href = `${current.pdfUrl}#page=${page}`;
    for (const b of el.railPages.querySelectorAll(".page.active")) b.classList.remove("active");
    const btn = el.railPages.querySelector(`.page[data-page="${page}"]`);
    if (!btn) return;
    btn.classList.add("active");
    if (scrollRail) btn.scrollIntoView({ block: "nearest", behavior: scrollRail });
  }

  // The page whose slot crosses the upper third of the view counts as the one being read.
  function trackScroll() {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!current || el.docView.hidden) return;
      // Pages near the end can't reach the top, so the jump target keeps the highlight.
      if (el.docView.scrollTop === jumpTop) return;
      jumpTop = -1;
      const slots = el.docPages.children;
      const y = el.docView.scrollTop + el.docView.clientHeight / 3;
      let lo = 0, hi = slots.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (slots[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
      }
      const page = Number(slots[lo]?.dataset.page);
      if (page) markPage(page, "auto");
    });
  }

  function setRailTab(tab) {
    el.railTab.querySelector(`input[value="${tab}"]`).checked = true;
    el.railPages.hidden = tab !== "pages";
    el.railSections.hidden = tab !== "sections";
  }

  async function setViewerTab(tab) {
    el.viewerTab.querySelector(`input[value="${tab}"]`).checked = true;
    const text = tab === "text";
    el.docView.hidden = text;
    el.viewerText.hidden = !text;
    el.viewerSections.disabled = text;
    if (!current) return;
    el.viewerDl.href = text ? current.txtUrl : current.pdfUrl;
    el.viewerDl.download = text ? current.result.text_name : current.name;
    el.viewerDl.textContent = text ? "Download text" : "Download PDF";
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

  function closeViewer() {
    if (!current) return;
    const src = current;
    current = null;
    teardownDocument();
    const finish = () => {
      if (current) return;
      el.viewer.hidden = true;
      document.body.classList.remove("viewer-open");
      el.main.inert = false;
      el.topbar.inert = false;
      el.docPages.replaceChildren();
      src.revoke();
      lastFocus?.focus?.({ preventScroll: true });
    };
    if (reducedMotion.matches) finish();
    else {
      el.viewerBackdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" });
      el.viewerPanel.animate(
        [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(0.75rem) scale(0.985)" }],
        { duration: 200, easing: SPRING, fill: "forwards" },
      ).finished.catch(() => {}).then(() => {
        finish();
        for (const a of [...el.viewerBackdrop.getAnimations(), ...el.viewerPanel.getAnimations()]) a.cancel();
      });
    }
    markActive();
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
        rm.innerHTML = ICON_X;
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
      error: node.querySelector(".job-error"),
      remove: node.querySelector(".job-remove"),
    };
    const job = { id, data: {}, node, refs };
    const names = data.files.map((f) => f.name);
    refs.name.textContent = names.length > 1 ? `${names[0]} + ${names.length - 1} more` : names[0];
    refs.name.title = names.join("\n");
    refs.icon.textContent = badgeFor(data.files);
    refs.remove.addEventListener("click", () => removeJob(job));
    refs.showPreview.addEventListener("click", () => openViewer(job.id));
    refs.icon.addEventListener("click", () => { if (job.data.status === "done") openViewer(job.id); });
    jobs.set(id, job);
    el.jobList.prepend(node);
    el.results.hidden = false;
    updateJob(job, data);
    return job;
  }

  function refreshJobThumb(id) {
    const job = jobs.get(id);
    const url = thumbUrl(library.find((m) => m.id === id));
    if (!job || !url || job.refs.icon.querySelector("img")) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    job.refs.icon.replaceChildren(img);
    job.refs.icon.classList.add("has-thumb");
    job.refs.icon.title = "View";
  }

  function shouldAutoOpen() {
    // Pop the viewer only when it won't interrupt anything.
    return el.viewer.hidden && !staged.length && !document.hidden;
  }

  function updateJob(job, data) {
    const wasDone = job.data.status === "done";
    const d = Object.assign(job.data, data);
    if (d.status === "done" && !wasDone && !job.id.startsWith("tmp-")) {
      // Jobs finishing while the page is open get shown; restored ones are only archived.
      const live = !job.restored;
      archiveJob(job).then(() => {
        refreshJobThumb(job.id);
        if (live && jobs.has(job.id) && shouldAutoOpen()) openViewer(job.id);
      });
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
      refs.name.textContent = r.output_name;
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
        fmtPages(r.pages),
        r.section_count ? `${r.section_count} section${r.section_count === 1 ? "" : "s"}${sourceNote ? ` (${sourceNote})` : ""}` : "no sections",
        fmtBytes(r.size_bytes),
        r.text_chars ? `${r.text_chars.toLocaleString()} characters` : "no text found",
      ];
      refs.meta.textContent = parts.join(" · ");
      const base = `${API}/jobs/${job.id}`;
      refs.dlPdf.href = `${base}/pdf`;
      refs.dlTxt.href = `${base}/txt`;
      refs.done.hidden = false;
      refreshJobThumb(job.id);
    } else if (d.status === "error") {
      refs.stage.textContent = "";
      refs.error.textContent = d.error || "Something went wrong.";
      refs.error.hidden = false;
    }
  }

  async function removeJob(job) {
    jobs.delete(job.id);
    persistJobs();
    // Leave along the path it arrived on (up and out), starting from where it is now.
    const exit = reducedMotion.matches
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{}, { opacity: 0, transform: "translateY(-0.75rem) scale(0.98)" }];
    job.node.style.pointerEvents = "none";
    job.node.animate(exit, { duration: reducedMotion.matches ? 150 : 220, easing: SPRING, fill: "forwards" })
      .finished.catch(() => {}).then(() => {
        job.node.remove();
        el.results.hidden = jobs.size === 0;
      });
    if (!job.id.startsWith("tmp-")) {
      // The library keeps its own copy, so the server copy can go.
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
    const draggingFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      depth++;
      el.dropzone.classList.add("over");
    });
    window.addEventListener("dragleave", (e) => {
      if (!draggingFiles(e)) return;
      if (--depth <= 0) { depth = 0; el.dropzone.classList.remove("over"); }
    });
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

    el.libSearch.addEventListener("input", renderLibrary);
    el.libSort.addEventListener("change", () => setSort(el.libSort.value, false));
    el.libView.addEventListener("change", (e) => {
      libState.view = e.target.value;
      storage.set(STORE_LIB, libState);
      renderLibrary();
    });
    for (const b of el.libTableWrap.querySelectorAll("th button")) {
      b.addEventListener("click", () => setSort(b.dataset.sort, true));
    }
    el.clearLibrary.addEventListener("click", clearLibraryClicked);

    el.viewerClose.addEventListener("click", closeViewer);
    el.viewerBackdrop.addEventListener("click", closeViewer);
    el.viewerTab.addEventListener("change", (e) => setViewerTab(e.target.value));
    el.docView.addEventListener("scroll", trackScroll, { passive: true });
    el.railTab.addEventListener("change", (e) => setRailTab(e.target.value));
    el.viewerSections.addEventListener("change", () => {
      const page = Number(el.viewerSections.value);
      if (page) showPdfPage(page);
      el.viewerSections.value = "";
    });
    el.textCopy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.textBody.textContent);
        el.textCopy.textContent = "Copied";
        setTimeout(() => { el.textCopy.textContent = "Copy"; }, 1500);
      } catch { /* clipboard blocked */ }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && current) closeViewer();
    });

    const syncTopbar = () => el.topbar.classList.toggle("scrolled", window.scrollY > 4);
    window.addEventListener("scroll", syncTopbar, { passive: true });
    syncTopbar();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); });
  }

  async function init() {
    wire();
    // Ask the browser not to evict saved documents under storage pressure (best effort).
    navigator.storage?.persist?.().catch(() => {});
    await loadLibrary();
    try {
      config = { ...config, ...(await api("config")) };
    } catch {
      alertInline("Could not reach the server. Check that the backend is running.");
    }
    el.ttlNote.textContent = `Uploads are removed from the server after ${Math.round(config.job_ttl_minutes / 60 * 10) / 10} h`;
    el.acceptedNote.textContent = `PDF, JPG, PNG, TIFF, HEIC, TXT, MD… up to ${config.max_file_mb} MB each`;
    el.input.accept = config.accepted_extensions.join(",");
    applyOptions(storage.get(STORE_OPTS, {}));
    restoreJobs();
  }

  init();
})();
