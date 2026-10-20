"use strict";

// The Windows 95 dressing around the app: taskbar clock, Start menu, visitor counter and pop-up ads.
// Nothing here touches the conversion flow; app.js works the same without this file.
(() => {
  const STORE_BLOCKER = "ocrdesk.popupBlocker";
  const STORE_VISITS = "ocrdesk.visits";
  const FIRST_POPUP_MS = 15000;
  const POPUP_GAP_MS = [40000, 75000]; // random wait between unprompted pop-ups
  const MAX_AMBIENT = 2; // unprompted pop-ups on screen at once

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
    layer: $("#popup-layer"),
    startBtn: $("#start-btn"),
    startMenu: $("#start-menu"),
    popupToggle: $("#popup-toggle"),
    clock: $("#tray-clock"),
    counter: $("#hit-counter"),
    dropzone: $("#dropzone"),
    library: $("#library"),
  };

  // ---------- pop-up catalog

  const scrollToUpload = () => {
    el.dropzone.scrollIntoView({ block: "center", behavior: "smooth" });
    el.dropzone.focus({ preventScroll: true });
  };

  // Each ad: window title, look, art, headline, text, and buttons ([label, next pop-up id or function]).
  const ADS = {
    winner: {
      title: "CONGRATULATIONS!!!", look: "p-loud", art: "\u{1F3C6}",
      head: "YOU WON!!!", text: "You are the 1,000,000th person to OCR a document today!",
      buttons: [["CLAIM PRIZE", "claim"], ["No thanks", null]],
    },
    claim: {
      title: "Prize Claim Wizard", look: "p-dialog", art: "\u{1F381}",
      head: "Your prize has been delivered.", text: "It is a searchable PDF. You have to make it yourself, though.",
      buttons: [["Make one now", scrollToUpload], ["OK", null]],
    },
    ram: {
      title: "RAM Doubler 98", look: "p-dark", art: "\u{1F4BE}",
      head: "DOWNLOADING MORE RAM...", text: "Please do not turn off your computer.", progress: true,
      buttons: [["Cancel", "ramFail"]],
    },
    ramFail: {
      title: "RAM Doubler 98", look: "p-dialog", art: "⚠️",
      head: "This program has performed an illegal operation and will be shut down.",
      text: "If the problem persists, contact the program vendor.",
      buttons: [["Close", null], ["Details >>", "ramDetails"]],
    },
    ramDetails: {
      title: "RAM Doubler 98", look: "p-dark", art: "",
      head: "RAMDBL caused a general protection fault", text: "in module OCRDESK.EXE at 0137:00004A2F. Registers: EAX=00000000 CS=0137 EIP=00004a2f. Too much RAM was downloaded.",
      buttons: [["Close", null]],
    },
    virus: {
      title: "AntiVirus Pro 98 - ALERT", look: "p-dialog", art: "\u{1F6A8}",
      head: "WARNING: 3 unsearchable PDFs were found on your computer!",
      text: "Scanned documents without a text layer cannot be searched or copied from. Run OCR to remove the threat.",
      buttons: [["Scan Now", scrollToUpload], ["Ignore", null]],
    },
    singles: {
      title: "Hot Single Pages!!", look: "p-pink", art: "\u{1F498}",
      head: "HOT SINGLE PAGES IN YOUR AREA", text: "Lonely scans near you are waiting to become searchable tonight.",
      buttons: [["Meet them »", scrollToUpload], ["Close", null]],
    },
    aol: {
      title: "OCR Online 4.0", look: "p-loud", art: "\u{1F4BF}",
      head: "500 HOURS FREE!", text: "Get on the Information Superhighway today. You've got mail!",
      buttons: [["INSTALL", "aolDisk"], ["Later", null]],
    },
    aolDisk: {
      title: "OCR Online 4.0 Setup", look: "p-dialog", art: "\u{1F4BE}",
      head: "Please insert Disk 2 of 47.", text: "Setup will continue once the disk is inserted.",
      buttons: [["OK", "aolDisk"], ["Cancel", null]],
    },
    toolbar: {
      title: "Security Warning", look: "p-dialog", art: "❓",
      head: "Do you want to install the OCR Desk Toolbar?",
      text: "It adds 14 extra search bars, a weather widget and a talking paperclip to your browser.",
      buttons: [["Yes", "toolbarDone"], ["Also yes", "toolbarDone"]],
    },
    toolbarDone: {
      title: "OCR Desk Toolbar", look: "p-dialog", art: "\u{1F4CE}",
      head: "It looks like you're trying to OCR a document.", text: "Would you like help? Drop a file in the box that says “Drop files to convert”.",
      buttons: [["Show me", scrollToUpload], ["Don't show this tip again", null]],
    },
    y2k: {
      title: "Y2K Alert!!", look: "p-loud", art: "\u{1F4A3}",
      head: "IS YOUR PDF Y2K READY?", text: "Documents without a text layer may stop working on January 1st, 2000!",
      buttons: [["Make it ready", scrollToUpload], ["Risk it", null]],
    },
    monkey: {
      title: "WINNER!!!", look: "p-loud", art: "\u{1F94A}",
      head: "YOU PUNCHED THE TYPO!", text: "You win $20!* — *in OCR Desk Bucks. Not redeemable anywhere.",
      buttons: [["YAY!", null]],
    },
    guestbook: {
      title: "Guestbook", look: "p-dialog", art: "\u{1F4D6}",
      head: "Thanks for stopping by!", text: "The guestbook is down for maintenance due to excessive spam (3 entries).",
      buttons: [["OK", null]],
    },
    webring: {
      title: "OCR WebRing", look: "p-dialog", art: "\u{1F48D}",
      head: "The OCR WebRing has exactly one member.", text: "You are already on it. Welcome back!",
      buttons: [["OK", null]],
    },
    bin: {
      title: "Recycle Bin", look: "p-dialog", art: "\u{1F5D1}️",
      head: "The Recycle Bin is empty.", text: "Files deleted from the Library are gone for good. Sorry, 1998 was a harsh time.",
      buttons: [["OK", null]],
    },
  };
  const AMBIENT = ["winner", "ram", "virus", "singles", "aol", "toolbar", "y2k"];

  // ---------- pop-up windows

  let zTop = 1;
  let ambientTimer = null;
  let lastAmbient = null;

  const blocked = () => storage.get(STORE_BLOCKER, false);
  const openCount = (kind) => el.layer.querySelectorAll(kind ? `.popup[data-kind="${kind}"]` : ".popup").length;

  function focusPopup(win) {
    for (const w of el.layer.querySelectorAll(".popup")) w.classList.toggle("inactive", w !== win);
    win.style.zIndex = String(++zTop);
  }

  function closePopup(win) {
    win.remove();
    const rest = el.layer.querySelectorAll(".popup");
    if (rest.length) focusPopup(rest[rest.length - 1]);
  }

  function place(win, near) {
    const box = el.layer.getBoundingClientRect();
    const w = win.offsetWidth;
    const h = win.offsetHeight;
    let x;
    let y;
    if (near) {
      // Chained pop-ups land a little down and right of the one that spawned them, like real ones did.
      x = near.offsetLeft + 28;
      y = near.offsetTop + 28;
    } else {
      x = Math.random() * Math.max(0, box.width - w);
      y = Math.random() * Math.max(0, box.height - h);
    }
    win.style.left = `${Math.max(0, Math.min(x, box.width - w))}px`;
    win.style.top = `${Math.max(0, Math.min(y, box.height - h))}px`;
  }

  function makeDraggable(win, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const box = el.layer.getBoundingClientRect();
      const dx = e.clientX - win.offsetLeft;
      const dy = e.clientY - win.offsetTop;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        win.style.left = `${Math.max(-win.offsetWidth + 60, Math.min(ev.clientX - dx, box.width - 60))}px`;
        win.style.top = `${Math.max(0, Math.min(ev.clientY - dy, box.height - 20))}px`;
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  function showPopup(kind, near) {
    const ad = ADS[kind];
    if (!ad) return null;
    const win = document.createElement("div");
    win.className = `popup window ${ad.look}`;
    win.dataset.kind = kind;
    win.setAttribute("role", "dialog");
    win.setAttribute("aria-label", ad.title);

    const bar = document.createElement("div");
    bar.className = "title-bar";
    const name = document.createElement("span");
    name.className = "brand";
    const label = document.createElement("span");
    label.textContent = ad.title;
    name.append(label);
    const controls = document.createElement("span");
    controls.className = "title-controls";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tc-close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => closePopup(win));
    controls.append(close);
    bar.append(name, controls);

    const body = document.createElement("div");
    body.className = "popup-body";
    if (ad.art) {
      const art = document.createElement("div");
      art.className = "popup-art";
      art.setAttribute("aria-hidden", "true");
      art.textContent = ad.art;
      body.append(art);
    }
    const msg = document.createElement("div");
    msg.className = "popup-msg";
    const head = document.createElement("h3");
    head.textContent = ad.head;
    const text = document.createElement("p");
    text.textContent = ad.text;
    msg.append(head, text);
    if (ad.progress) {
      const bar2 = document.createElement("div");
      bar2.className = "popup-fake-progress";
      bar2.append(document.createElement("span"));
      msg.append(bar2);
    }
    body.append(msg);

    const actions = document.createElement("div");
    actions.className = "popup-actions";
    ad.buttons.forEach(([text, next], i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = i === 0 ? "btn primary" : "btn";
      b.textContent = text;
      b.addEventListener("click", () => {
        if (typeof next === "string") showPopup(next, win);
        closePopup(win);
        if (typeof next === "function") next();
      });
      actions.append(b);
    });
    body.append(actions);

    win.append(bar, body);
    win.addEventListener("pointerdown", () => focusPopup(win));
    makeDraggable(win, bar);
    el.layer.append(win);
    place(win, near);
    focusPopup(win);
    return win;
  }

  // Unprompted pop-ups: never while the viewer is open, a file is being dragged in, or the tab is hidden.
  function scheduleAmbient(delay) {
    clearTimeout(ambientTimer);
    const [lo, hi] = POPUP_GAP_MS;
    ambientTimer = setTimeout(ambientTick, delay ?? lo + Math.random() * (hi - lo));
  }
  function ambientTick() {
    const busy = document.hidden
      || document.body.classList.contains("viewer-open")
      || el.dropzone.classList.contains("over")
      || openCount() >= MAX_AMBIENT;
    if (!blocked() && !busy) {
      const choices = AMBIENT.filter((k) => k !== lastAmbient && !openCount(k));
      lastAmbient = choices[Math.floor(Math.random() * choices.length)];
      showPopup(lastAmbient);
    }
    scheduleAmbient();
  }

  // ---------- Start menu

  function setMenu(open) {
    el.startMenu.hidden = !open;
    el.startBtn.setAttribute("aria-expanded", String(open));
    if (open) el.startMenu.querySelector("button").focus();
  }

  function syncBlocker() {
    el.popupToggle.setAttribute("role", "menuitemcheckbox");
    el.popupToggle.setAttribute("aria-checked", String(blocked()));
  }

  function shutDown() {
    const screen = document.createElement("div");
    screen.className = "safe-off";
    screen.tabIndex = 0;
    screen.setAttribute("role", "button");
    screen.innerHTML = "<div>It's now safe to turn off<br>your computer.<small>(click anywhere to restart)</small></div>";
    const restart = () => screen.remove();
    screen.addEventListener("click", restart);
    screen.addEventListener("keydown", restart);
    document.body.append(screen);
    screen.focus();
  }

  const ACTIONS = {
    top: scrollToUpload,
    library: () => el.library.scrollIntoView({ behavior: "smooth" }),
    popups: () => {
      const on = !blocked();
      storage.set(STORE_BLOCKER, on);
      syncBlocker();
      if (on) for (const w of el.layer.querySelectorAll(".popup")) w.remove();
      else scheduleAmbient(4000);
    },
    shutdown: shutDown,
  };

  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-retro]");
    if (target) {
      e.preventDefault();
      const action = target.dataset.retro;
      if (target.closest("#start-menu")) setMenu(false);
      if (ACTIONS[action]) ACTIONS[action]();
      else showPopup(action === "ad" ? target.dataset.ad : action);
      return;
    }
    if (e.target.closest("#start-btn")) setMenu(el.startMenu.hidden);
    else if (!e.target.closest("#start-menu")) setMenu(false);
  });

  el.startMenu.addEventListener("keydown", (e) => {
    const items = [...el.startMenu.querySelectorAll("button")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { setMenu(false); el.startBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });

  // ---------- taskbar clock and visitor counter

  function tick() {
    el.clock.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  function countVisit() {
    const visits = storage.get(STORE_VISITS, 0) + 1;
    storage.set(STORE_VISITS, visits);
    el.counter.textContent = String(1337 + visits * 7).padStart(7, "0");
  }

  tick();
  setInterval(tick, 15000);
  countVisit();
  syncBlocker();
  scheduleAmbient(FIRST_POPUP_MS);
})();
