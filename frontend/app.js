"use strict";

(() => {
  const API = "api";
  const STORE_JOBS = "ocrdesk.jobs";
  const STORE_OPTS = "ocrdesk.options";
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
  };

  let config = { languages: ["eng"], default_language: "eng", accepted_extensions: [], max_file_mb: 100, max_files_per_job: 20 };
  let staged = [];
  const jobs = new Map(); // id -> { data, node, refs }
  let pollTimer = null;

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
      openPdf: node.querySelector(".open-pdf"),
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
    const d = Object.assign(job.data, data);
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
      refs.openPdf.href = `${base}/pdf?inline=true`;
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
      a.target = "_blank";
      a.rel = "noopener";
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

  async function removeJob(job) {
    job.node.remove();
    jobs.delete(job.id);
    persistJobs();
    el.results.hidden = jobs.size === 0;
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
      createJobCard(ids[i], data);
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
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); });
  }

  async function init() {
    wire();
    try {
      config = { ...config, ...(await api("config")) };
    } catch {
      alertInline("Could not reach the server. Check that the backend is running.");
    }
    el.ttlNote.textContent = `Files are deleted automatically after ${Math.round(config.job_ttl_minutes / 60 * 10) / 10} h`;
    el.acceptedNote.textContent = `PDF, Word, ODT, RTF, TXT, JPG, PNG, TIFF, HEIC… up to ${config.max_file_mb} MB each`;
    el.input.accept = config.accepted_extensions.join(",");
    applyOptions(storage.get(STORE_OPTS, {}));
    restoreJobs();
  }

  init();
})();
