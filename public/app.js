(() => {
  "use strict";

  const STATUS = {
    ACTIVE: { glyph: "●", label: "사용 중" },
    INACTIVE: { glyph: "◐", label: "과거 사용" },
    AVAILABLE: { glyph: "○", label: "미사용 추정" },
  };

  const NOTE_MAX = 1000;

  const els = {
    lastScan: document.getElementById("last-scan"),
    scanBadge: document.getElementById("scan-badge"),
    scanBadgeLabel: document.getElementById("scan-badge-label"),
    scanNow: document.getElementById("scan-now"),
    scanFeedback: document.getElementById("scan-feedback"),
    scanErrorBanner: document.getElementById("scan-error-banner"),
    scanErrorText: document.getElementById("scan-error-text"),
    connection: document.getElementById("connection-status"),
    search: document.getElementById("search"),
    grid: document.getElementById("ip-grid"),
    empty: document.getElementById("empty-grid"),
    drawer: document.getElementById("drawer"),
    scrim: document.getElementById("drawer-scrim"),
    drawerClose: document.getElementById("drawer-close"),
    drawerIp: document.getElementById("drawer-ip"),
    drawerStatus: document.getElementById("drawer-status"),
    drawerReserved: document.getElementById("drawer-reserved"),
    drawerMac: document.getElementById("drawer-mac"),
    drawerFirstSeen: document.getElementById("drawer-first-seen"),
    drawerLastSeen: document.getElementById("drawer-last-seen"),
    drawerLastChecked: document.getElementById("drawer-last-checked"),
    drawerWarning: document.getElementById("drawer-available-warning"),
    drawerNote: document.getElementById("drawer-note"),
    noteCount: document.getElementById("note-count"),
    drawerError: document.getElementById("drawer-error"),
    toggleReserved: document.getElementById("toggle-reserved"),
    saveNote: document.getElementById("save-note"),
  };

  const state = {
    records: [],
    recordsByIp: new Map(),
    summary: null,
    scan: null,
    statusFilter: "all",
    reservationFilter: "all",
    query: "",
    selectedIp: null,
    noteDirty: false,
    patching: false,
    loaded: false,
  };

  function statusMeta(observedStatus) {
    return STATUS[observedStatus] ?? STATUS.AVAILABLE;
  }

  function isCandidate(record) {
    return record.observedStatus === "AVAILABLE" && !record.isReserved;
  }

  function formatLocal(iso) {
    if (!iso) {
      return "없음";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "없음";
    }
    return date.toLocaleString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function lastOctet(ip) {
    const parts = ip.split(".");
    return parts[parts.length - 1] ?? ip;
  }

  function tileLabel(record) {
    const status = statusMeta(record.observedStatus).label;
    return record.isReserved
      ? `${record.ipAddress} · ${status} · (예약)`
      : `${record.ipAddress} · ${status}`;
  }

  function setHidden(el, hidden) {
    el.hidden = hidden;
  }

  function setText(el, value) {
    el.textContent = value;
  }

  function matchesFilters(record) {
    const q = state.query.trim().toLowerCase();
    if (q) {
      const hay = `${record.ipAddress} ${record.macAddress ?? ""} ${record.note}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }

    if (state.statusFilter === "ACTIVE" || state.statusFilter === "INACTIVE" || state.statusFilter === "AVAILABLE") {
      if (record.observedStatus !== state.statusFilter) {
        return false;
      }
    } else if (state.statusFilter === "candidate" && !isCandidate(record)) {
      return false;
    }

    if (state.reservationFilter === "reserved" && !record.isReserved) {
      return false;
    }
    if (state.reservationFilter === "unreserved" && record.isReserved) {
      return false;
    }

    return true;
  }

  function renderStrip() {
    const scan = state.scan;
    if (!scan) {
      return;
    }

    els.lastScan.removeAttribute("data-loading");
    setText(els.lastScan, formatLocal(scan.lastSuccessfulScanAt));

    let badgeState = "idle";
    let badgeLabel = "정상";
    if (scan.isScanning) {
      badgeState = "scanning";
      badgeLabel = "스캔 중";
    } else if (scan.lastError) {
      badgeState = "error";
      badgeLabel = "스캔 오류";
    }

    els.scanBadge.className = `badge badge--${badgeState}`;
    els.scanBadge.dataset.state = badgeState;
    setText(els.scanBadgeLabel, badgeLabel);

    if (scan.lastError) {
      setText(
        els.scanErrorText,
        `스캔에 실패했습니다. ${scan.lastError.message} 기존 IP 상태는 그대로 두었습니다(기존 상태 유지).`,
      );
      setHidden(els.scanErrorBanner, false);
    } else {
      setHidden(els.scanErrorBanner, true);
      setText(els.scanErrorText, "");
    }
  }

  function renderStats() {
    if (!state.summary) {
      return;
    }
    for (const [key, value] of Object.entries(state.summary)) {
      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) {
        el.classList.remove("skeleton");
        setText(el, String(value));
      }
    }
  }

  function renderSkeletonGrid() {
    els.grid.replaceChildren();
    for (let i = 0; i < 48; i += 1) {
      const tile = document.createElement("div");
      tile.className = "ip-tile ip-tile--placeholder";
      tile.setAttribute("aria-hidden", "true");
      els.grid.append(tile);
    }
  }

  function renderGrid() {
    if (!state.loaded) {
      renderSkeletonGrid();
      setHidden(els.empty, true);
      return;
    }

    const visible = state.records.filter(matchesFilters);
    els.grid.classList.remove("is-loading");
    els.grid.setAttribute("aria-busy", "false");
    els.grid.replaceChildren();

    if (visible.length === 0) {
      setHidden(els.empty, false);
      return;
    }

    setHidden(els.empty, true);
    const fragment = document.createDocumentFragment();
    for (const record of visible) {
      const status = statusMeta(record.observedStatus);
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = `ip-tile ip-tile--${record.observedStatus}`;
      tile.dataset.ip = record.ipAddress;
      tile.setAttribute("aria-label", tileLabel(record));
      tile.setAttribute("aria-pressed", record.ipAddress === state.selectedIp ? "true" : "false");
      if (record.isReserved) {
        tile.classList.add("is-reserved");
      }
      if (record.ipAddress === state.selectedIp) {
        tile.classList.add("is-selected");
      }

      const glyph = document.createElement("span");
      glyph.className = "ip-tile__glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.textContent = status.glyph;

      const octet = document.createElement("span");
      octet.className = "ip-tile__octet";
      octet.textContent = lastOctet(record.ipAddress);

      tile.append(glyph, octet);

      if (record.isReserved) {
        const lock = document.createElement("span");
        lock.className = "ip-tile__lock";
        lock.setAttribute("aria-hidden", "true");
        lock.textContent = "🔒";
        tile.append(lock);
      }

      fragment.append(tile);
    }
    els.grid.append(fragment);
  }

  function renderDrawer() {
    if (!state.selectedIp) {
      setHidden(els.drawer, true);
      setHidden(els.scrim, true);
      return;
    }

    const record = state.recordsByIp.get(state.selectedIp);
    if (!record) {
      return;
    }

    const status = statusMeta(record.observedStatus);
    setText(els.drawerIp, record.ipAddress);
    setText(els.drawerStatus, `${status.glyph} ${status.label}`);
    els.drawerStatus.dataset.status = record.observedStatus;
    setHidden(els.drawerReserved, !record.isReserved);
    setText(els.drawerMac, record.macAddress ?? "없음");
    setText(els.drawerFirstSeen, formatLocal(record.firstSeenAt));
    setText(els.drawerLastSeen, formatLocal(record.lastSeenAt));
    setText(els.drawerLastChecked, formatLocal(record.lastCheckedAt));
    setHidden(els.drawerWarning, record.observedStatus !== "AVAILABLE");
    setText(els.toggleReserved, record.isReserved ? "예약 해제" : "예약");

    if (!state.noteDirty) {
      els.drawerNote.value = record.note ?? "";
    }
    if (els.drawerNote.value.length > NOTE_MAX) {
      els.drawerNote.value = els.drawerNote.value.slice(0, NOTE_MAX);
    }
    setText(els.noteCount, String(els.drawerNote.value.length));

    const busy = state.patching;
    els.drawerNote.disabled = busy;
    els.saveNote.disabled = busy;
    els.toggleReserved.disabled = busy;

    setHidden(els.drawer, false);
    setHidden(els.scrim, false);
  }

  function renderAll() {
    renderStrip();
    renderStats();
    renderGrid();
    renderDrawer();
  }

  function applySnapshot(payload) {
    state.records = payload.records ?? [];
    state.recordsByIp = new Map(state.records.map((record) => [record.ipAddress, record]));
    state.summary = payload.summary;
    state.scan = payload.scan;
    state.loaded = true;
    renderAll();
  }

  async function fetchDashboard() {
    const response = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error("대시보드를 불러오지 못했습니다.");
    }
    return response.json();
  }

  async function refreshFromServer() {
    try {
      applySnapshot(await fetchDashboard());
    } catch (error) {
      setConnection("closed", "연결 끊김·재연결 중");
      console.error(error);
    }
  }

  function setConnection(kind, label) {
    els.connection.dataset.state = kind;
    setText(els.connection, label);
  }

  function openDrawer(ip, restoreFocus) {
    state.selectedIp = ip;
    state.noteDirty = false;
    setHidden(els.drawerError, true);
    setText(els.drawerError, "");
    renderGrid();
    renderDrawer();
    if (!restoreFocus) {
      els.drawerClose.focus();
    }
  }

  function closeDrawer() {
    const ip = state.selectedIp;
    state.selectedIp = null;
    state.noteDirty = false;
    state.patching = false;
    setHidden(els.drawerError, true);
    renderDrawer();
    renderGrid();
    if (ip) {
      const tile = els.grid.querySelector(`[data-ip="${CSS.escape(ip)}"]`);
      tile?.focus();
    }
  }

  function showDrawerError(message) {
    setText(els.drawerError, message);
    setHidden(els.drawerError, false);
  }

  async function patchIp(body) {
    const ip = state.selectedIp;
    if (!ip) {
      return;
    }
    state.patching = true;
    renderDrawer();
    try {
      const response = await fetch(`/api/ips/${encodeURIComponent(ip)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message ?? "저장에 실패했습니다. 입력 내용을 유지합니다.";
        showDrawerError(message);
        return;
      }
      setHidden(els.drawerError, true);
      if (payload && payload.ipAddress) {
        state.recordsByIp.set(payload.ipAddress, payload);
        state.records = state.records.map((record) =>
          record.ipAddress === payload.ipAddress ? payload : record,
        );
        if ("note" in body) {
          state.noteDirty = false;
        }
        renderAll();
      }
    } catch {
      showDrawerError("저장에 실패했습니다. 입력 내용을 유지합니다.");
    } finally {
      state.patching = false;
      renderDrawer();
    }
  }

  function bindUi() {
    els.search.addEventListener("input", () => {
      state.query = els.search.value;
      renderGrid();
    });

    document.querySelectorAll("[data-status-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.statusFilter = button.getAttribute("data-status-filter") ?? "all";
        document.querySelectorAll("[data-status-filter]").forEach((other) => {
          const selected = other === button;
          other.classList.toggle("is-selected", selected);
          other.setAttribute("aria-pressed", selected ? "true" : "false");
        });
        renderGrid();
      });
    });

    document.querySelectorAll("[data-reservation-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.reservationFilter = button.getAttribute("data-reservation-filter") ?? "all";
        document.querySelectorAll("[data-reservation-filter]").forEach((other) => {
          const selected = other === button;
          other.classList.toggle("is-selected", selected);
          other.setAttribute("aria-pressed", selected ? "true" : "false");
        });
        renderGrid();
      });
    });

    els.grid.addEventListener("click", (event) => {
      const tile = event.target.closest("button.ip-tile");
      if (!tile) {
        return;
      }
      openDrawer(tile.dataset.ip);
    });

    els.drawerClose.addEventListener("click", closeDrawer);
    els.scrim.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.selectedIp) {
        closeDrawer();
      }
    });

    els.drawerNote.addEventListener("input", () => {
      if (els.drawerNote.value.length > NOTE_MAX) {
        els.drawerNote.value = els.drawerNote.value.slice(0, NOTE_MAX);
      }
      state.noteDirty = true;
      setText(els.noteCount, String(els.drawerNote.value.length));
    });

    els.saveNote.addEventListener("click", () => {
      void patchIp({ note: els.drawerNote.value });
    });

    els.toggleReserved.addEventListener("click", () => {
      const record = state.recordsByIp.get(state.selectedIp);
      if (!record) {
        return;
      }
      void patchIp({ isReserved: !record.isReserved });
    });

    els.scanNow.addEventListener("click", async () => {
      setText(els.scanBadgeLabel, "스캔 중");
      els.scanBadge.className = "badge badge--scanning";
      els.scanBadge.dataset.state = "scanning";
      setHidden(els.scanFeedback, true);
      try {
        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setText(els.scanFeedback, payload?.error?.message ?? "스캔 요청에 실패했습니다.");
          setHidden(els.scanFeedback, false);
          return;
        }
        if (payload?.status === "skipped") {
          setText(els.scanFeedback, "이미 스캔이 진행 중입니다.");
          setHidden(els.scanFeedback, false);
        } else if (payload?.status === "failed") {
          setText(els.scanFeedback, "스캔 요청은 접수되었지만 실패로 끝났습니다. 배너를 확인하세요.");
          setHidden(els.scanFeedback, false);
        } else {
          setHidden(els.scanFeedback, true);
        }
      } catch {
        setText(els.scanFeedback, "스캔 요청에 실패했습니다.");
        setHidden(els.scanFeedback, false);
      }
    });
  }

  function connectSse() {
    const source = new EventSource("/events");
    source.addEventListener("open", () => {
      setConnection("open", "연결됨");
      void refreshFromServer();
    });
    source.addEventListener("dashboard.updated", () => {
      void refreshFromServer();
    });
    source.addEventListener("error", () => {
      setConnection("closed", "연결 끊김·재연결 중");
    });
  }

  bindUi();
  renderSkeletonGrid();
  void refreshFromServer();
  connectSse();
})();
