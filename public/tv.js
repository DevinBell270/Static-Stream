let PIXELS_PER_MINUTE = 10;
const MARKER_MINUTES = 30;
const WINDOW_BEFORE_MINUTES = 0;
const WINDOW_AFTER_MINUTES = 540;
const CHANNEL_NUMBER_START = 101;
const LIVE_TICK_MS = 1000;
const SCHEDULE_REBUILD_BUFFER_MINUTES = 60;
const OVERLAY_HIDE_DELAY_MS = 2800;

const clockFormatter = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
});

const markerLabelFormatter = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
  weekday: "short",
});

const state = {
  guide: { categories: {} },
  rows: [],
  playerReady: null,
  youtubeReady: null,
  currentCategory: null,
  focusedCategory: null,
  currentVideoId: null,
  liveTimer: null,
  guideHideTimer: null,
  scheduleWindowStartMs: 0,
  scheduleWindowEndMs: 0,
  scheduleWidthPx: 0,
  hasCenteredOnNow: false,
  hasUserSelectedChannel: false,
};

const elements = {
  overlay: document.querySelector("#guide-overlay"),
  hoverSurface: document.querySelector("#hover-surface"),
  currentCategory: document.querySelector("#current-category"),
  currentTitle: document.querySelector("#current-title"),
  currentMeta: document.querySelector("#current-meta"),
  status: document.querySelector("#tv-status"),
  subtitle: document.querySelector("#guide-subtitle"),
  timebarScroll: document.querySelector("#timebar-scroll"),
  timebarTrack: document.querySelector("#timebar-track"),
  guideGrid: document.querySelector("#guide-grid"),
  playhead: document.querySelector("#playhead"),
};

function setStatus(message) {
  elements.status.textContent = message;
}

function clearOverlayHideTimer() {
  window.clearTimeout(state.guideHideTimer);
  state.guideHideTimer = null;
}

function hideOverlay() {
  elements.overlay.classList.remove("visible");
}

function showOverlay({ persist = false, mode = "full" } = {}) {
  elements.overlay.classList.add("visible");
  
  if (mode === "info") {
    elements.overlay.classList.add("info-only");
  } else {
    elements.overlay.classList.remove("info-only");
  }

  clearOverlayHideTimer();

  if (persist) {
    return;
  }

  state.guideHideTimer = window.setTimeout(() => {
    hideOverlay();
  }, OVERLAY_HIDE_DELAY_MS);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(timestampMs) {
  return clockFormatter.format(new Date(timestampMs));
}

function formatMarkerLabel(timestampMs) {
  return markerLabelFormatter.format(new Date(timestampMs));
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function getGuideEpochMs() {
  return Date.parse(state.guide.epochStart || new Date().toISOString());
}

function getScheduleWindow(nowMs = Date.now()) {
  const markerMs = MARKER_MINUTES * 60 * 1000;
  const rawStart = nowMs - (WINDOW_BEFORE_MINUTES * 60 * 1000);
  const startMs = Math.floor(rawStart / markerMs) * markerMs;
  const endMs = startMs + ((WINDOW_BEFORE_MINUTES + WINDOW_AFTER_MINUTES) * 60 * 1000);

  return { startMs, endMs };
}

function minutesToPixels(minutes) {
  return minutes * PIXELS_PER_MINUTE;
}

function getRowByCategory(categoryName) {
  return state.rows.find((row) => row.categoryName === categoryName) || null;
}

function getPlayableRows() {
  return state.rows.filter((row) => row.videos.length > 0 && row.totalDurationSeconds);
}

function getPixelsFromWindowStart(timestampMs) {
  return minutesToPixels((timestampMs - state.scheduleWindowStartMs) / 60000);
}

function buildRows() {
  const entries = Object.entries(state.guide.categories || {}).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  state.rows = entries.map(([categoryName, category], index) => ({
    categoryName,
    channelNumber: CHANNEL_NUMBER_START + index,
    videos: Array.isArray(category.videos) ? category.videos : [],
    totalDurationSeconds: category.totalDurationSeconds || 0,
  }));
}

function resolveLiveSlot(row, atMs = Date.now()) {
  if (!row || !row.videos.length || !row.totalDurationSeconds) {
    return null;
  }

  const epochMs = getGuideEpochMs();
  const loopMs = row.totalDurationSeconds * 1000;
  const liveOffsetMs = positiveModulo(atMs - epochMs, loopMs);
  let runningOffsetMs = 0;

  for (let index = 0; index < row.videos.length; index += 1) {
    const video = row.videos[index];
    const durationMs = (video.durationSeconds || 0) * 1000;
    const videoEndMs = runningOffsetMs + durationMs;

    if (liveOffsetMs < videoEndMs) {
      const startOffsetMs = liveOffsetMs - runningOffsetMs;
      return {
        row,
        video,
        currentIndex: index,
        startSeconds: Math.floor(startOffsetMs / 1000),
        absoluteStartMs: atMs - startOffsetMs,
        absoluteEndMs: atMs + (durationMs - startOffsetMs),
      };
    }

    runningOffsetMs = videoEndMs;
  }

  const fallbackVideo = row.videos[0];
  return {
    row,
    video: fallbackVideo,
    currentIndex: 0,
    startSeconds: 0,
    absoluteStartMs: atMs,
    absoluteEndMs: atMs + ((fallbackVideo.durationSeconds || 0) * 1000),
  };
}

function buildSegmentsForRow(row, nowMs) {
  if (!row.videos.length || !row.totalDurationSeconds) {
    return [];
  }

  const epochMs = getGuideEpochMs();
  const loopMs = row.totalDurationSeconds * 1000;
  const firstLoopStartMs = epochMs + (Math.floor((state.scheduleWindowStartMs - epochMs) / loopMs) * loopMs);
  const segments = [];

  for (let loopStartMs = firstLoopStartMs - loopMs; loopStartMs < state.scheduleWindowEndMs; loopStartMs += loopMs) {
    let runningOffsetMs = 0;

    row.videos.forEach((video, index) => {
      const durationMs = (video.durationSeconds || 0) * 1000;
      const segmentStartMs = loopStartMs + runningOffsetMs;
      const segmentEndMs = segmentStartMs + durationMs;
      runningOffsetMs += durationMs;

      if (segmentEndMs <= state.scheduleWindowStartMs || segmentStartMs >= state.scheduleWindowEndMs) {
        return;
      }

      const visibleStartMs = Math.max(segmentStartMs, state.scheduleWindowStartMs);
      const visibleEndMs = Math.min(segmentEndMs, state.scheduleWindowEndMs);

      segments.push({
        index,
        row,
        video,
        absoluteStartMs: segmentStartMs,
        absoluteEndMs: segmentEndMs,
        leftPx: getPixelsFromWindowStart(visibleStartMs),
        widthPx: getPixelsFromWindowStart(visibleEndMs) - getPixelsFromWindowStart(visibleStartMs),
        isLive: nowMs >= segmentStartMs && nowMs < segmentEndMs,
      });
    });
  }

  return segments;
}

function updateCurrentChannelDisplay() {
  const row = getRowByCategory(state.currentCategory);
  const liveSlot = resolveLiveSlot(row);

  if (!row || !liveSlot) {
    elements.currentCategory.textContent = "No category selected";
    elements.currentTitle.textContent = "Choose a category to tune in.";
    elements.currentMeta.textContent = "Static Stream syncs each category to the same live timeline for every viewer.";
    return;
  }

  const channelSuffix = liveSlot.video.channelTitle ? ` · ${liveSlot.video.channelTitle}` : "";
  elements.currentCategory.textContent = row.categoryName;
  elements.currentTitle.textContent = liveSlot.video.title;
  elements.currentMeta.textContent = `${formatClock(liveSlot.absoluteStartMs)} - ${formatClock(liveSlot.absoluteEndMs)} · Channel ${row.channelNumber}${channelSuffix}`;
}

function renderTimebar() {
  elements.timebarTrack.replaceChildren();
  elements.timebarTrack.style.width = `${state.scheduleWidthPx}px`;

  const markerMs = MARKER_MINUTES * 60 * 1000;

  for (let timestampMs = state.scheduleWindowStartMs; timestampMs < state.scheduleWindowEndMs; timestampMs += markerMs) {
    const marker = document.createElement("div");
    const strong = document.createElement("strong");
    const secondary = document.createElement("span");

    marker.className = "time-marker";
    marker.style.width = `${minutesToPixels(MARKER_MINUTES)}px`;
    strong.textContent = formatClock(timestampMs);
    secondary.textContent = formatMarkerLabel(timestampMs);

    marker.append(strong, secondary);
    elements.timebarTrack.append(marker);
  }
}

function createEmptyRow(row) {
  const rowElement = document.createElement("div");
  const label = document.createElement("button");
  const scroller = document.createElement("div");
  const track = document.createElement("div");
  const emptyBlock = document.createElement("div");
  const number = document.createElement("span");
  const name = document.createElement("strong");
  const count = document.createElement("span");

  rowElement.className = "epg-row";
  rowElement.dataset.category = row.categoryName;

  label.type = "button";
  label.className = "channel-label";
  label.dataset.category = row.categoryName;
  number.className = "channel-number";
  name.className = "channel-name";
  count.className = "channel-count";
  number.textContent = `CH ${row.channelNumber}`;
  name.textContent = row.categoryName;
  count.textContent = "0 playable videos";

  label.append(number, name, count);

  scroller.className = "timeline-scroller";
  track.className = "timeline-track";
  track.style.width = `${state.scheduleWidthPx}px`;

  emptyBlock.className = "program-block empty";
  emptyBlock.style.left = "12px";
  emptyBlock.style.width = `${Math.max(state.scheduleWidthPx - 24, 120)}px`;
  emptyBlock.textContent = "No playable videos in this category yet.";
  track.append(emptyBlock);
  scroller.append(track);
  rowElement.append(label, scroller);

  return rowElement;
}

function createRowElement(row, nowMs) {
  if (!row.videos.length || !row.totalDurationSeconds) {
    return createEmptyRow(row);
  }

  const rowElement = document.createElement("div");
  const label = document.createElement("button");
  const scroller = document.createElement("div");
  const track = document.createElement("div");
  const number = document.createElement("span");
  const name = document.createElement("strong");
  const count = document.createElement("span");
  const segments = buildSegmentsForRow(row, nowMs);

  rowElement.className = "epg-row";
  rowElement.dataset.category = row.categoryName;

  label.type = "button";
  label.className = "channel-label";
  label.dataset.category = row.categoryName;
  number.className = "channel-number";
  name.className = "channel-name";
  count.className = "channel-count";
  number.textContent = `CH ${row.channelNumber}`;
  name.textContent = row.categoryName;
  count.textContent = `${row.videos.length} playable video${row.videos.length === 1 ? "" : "s"}`;
  label.append(number, name, count);

  scroller.className = "timeline-scroller";
  track.className = "timeline-track";
  track.style.width = `${state.scheduleWidthPx}px`;

  segments.forEach((segment) => {
    const block = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("span");

    block.type = "button";
    block.className = "program-block";
    block.dataset.category = row.categoryName;
    block.dataset.videoId = segment.video.videoId;
    block.dataset.live = String(segment.isLive);
    block.dataset.absoluteStart = String(segment.absoluteStartMs);
    block.dataset.absoluteEnd = String(segment.absoluteEndMs);
    block.style.left = `${segment.leftPx}px`;
    block.style.width = `${segment.widthPx}px`;
    block.setAttribute(
      "aria-label",
      `${row.categoryName}, ${segment.video.title}, ${formatClock(segment.absoluteStartMs)} to ${formatClock(segment.absoluteEndMs)}`,
    );

    if (segment.isLive) {
      block.classList.add("live");
    }

    title.className = "program-title";
    meta.className = "program-meta";
    title.textContent = segment.video.title;
    meta.textContent = `${formatClock(segment.absoluteStartMs)} - ${formatClock(segment.absoluteEndMs)} · ${formatDuration(segment.video.durationSeconds || 0)}`;

    block.append(title, meta);
    track.append(block);
  });

  scroller.append(track);
  rowElement.append(label, scroller);

  return rowElement;
}

function refreshSelectionStyles() {
  const rows = elements.guideGrid.querySelectorAll(".epg-row");
  const blocks = elements.guideGrid.querySelectorAll(".program-block");

  rows.forEach((row) => {
    row.classList.toggle("selected", row.dataset.category === state.currentCategory);
    row.classList.toggle("focused", row.dataset.category === state.focusedCategory);
  });

  blocks.forEach((block) => {
    const isSelectedRow = block.dataset.category === state.currentCategory;
    const isLiveBlock = block.dataset.live === "true";
    block.classList.toggle("selected", isSelectedRow && isLiveBlock);
  });
}

function renderGrid(nowMs = Date.now()) {
  elements.guideGrid.replaceChildren();

  if (state.rows.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "No categories available yet. Add one from the admin dashboard.";
    elements.guideGrid.append(emptyState);
    return;
  }

  const fragment = document.createDocumentFragment();
  state.rows.forEach((row) => {
    fragment.append(createRowElement(row, nowMs));
  });
  elements.guideGrid.append(fragment);
  refreshSelectionStyles();
}

function syncTimebarScroll() {
  elements.timebarScroll.scrollLeft = elements.guideGrid.scrollLeft;
}

function updatePlayheadPosition() {
  if (!state.scheduleWidthPx) {
    elements.playhead.classList.remove("visible");
    return;
  }

  const timelineOffsetPx = getPixelsFromWindowStart(Date.now()) - elements.guideGrid.scrollLeft;
  const labelWidth = document.querySelector(".timebar-label")?.offsetWidth || 0;
  const visibleLeft = labelWidth;
  const visibleRight = elements.guideGrid.clientWidth;
  const playheadLeft = labelWidth + timelineOffsetPx;

  if (playheadLeft < visibleLeft || playheadLeft > visibleRight) {
    elements.playhead.classList.remove("visible");
    return;
  }

  elements.playhead.style.left = `${playheadLeft}px`;
  elements.playhead.classList.add("visible");
}

function centerScheduleOnNow() {
  if (!state.scheduleWidthPx) {
    return;
  }

  const labelWidth = document.querySelector(".timebar-label")?.offsetWidth || 0;
  const viewportTimelineWidth = Math.max(elements.guideGrid.clientWidth - labelWidth, 0);
  const currentTimePx = getPixelsFromWindowStart(Date.now());
  const desiredOffsetPx = 0;
  const maxScrollLeft = Math.max((labelWidth + state.scheduleWidthPx) - elements.guideGrid.clientWidth, 0);
  const targetScrollLeft = Math.min(Math.max(currentTimePx - desiredOffsetPx, 0), maxScrollLeft);

  elements.guideGrid.scrollLeft = targetScrollLeft;
  syncTimebarScroll();
  updatePlayheadPosition();
  state.hasCenteredOnNow = true;
}

function renderSchedule({ centerOnNow = false } = {}) {
  const nowMs = Date.now();
  const previousScrollTop = elements.guideGrid.scrollTop;
  const previousScrollLeft = elements.guideGrid.scrollLeft;
  
  const labelWidth = document.querySelector(".timebar-label")?.offsetWidth || 220;
  const viewportWidth = Math.max(elements.guideGrid.clientWidth - labelWidth, 300);
  PIXELS_PER_MINUTE = Math.max(10, viewportWidth / 120);

  const { startMs, endMs } = getScheduleWindow(nowMs);

  state.scheduleWindowStartMs = startMs;
  state.scheduleWindowEndMs = endMs;
  state.scheduleWidthPx = getPixelsFromWindowStart(endMs);

  renderTimebar();
  renderGrid(nowMs);
  elements.guideGrid.scrollTop = previousScrollTop;

  if (centerOnNow) {
    centerScheduleOnNow();
  } else {
    elements.guideGrid.scrollLeft = previousScrollLeft;
  }

  syncTimebarScroll();
  updatePlayheadPosition();
}

function shouldRebuildSchedule(nowMs = Date.now()) {
  const bufferMs = SCHEDULE_REBUILD_BUFFER_MINUTES * 60 * 1000;
  return nowMs <= state.scheduleWindowStartMs + bufferMs || nowMs >= state.scheduleWindowEndMs - bufferMs;
}

function refreshLiveBlockState() {
  const blocks = elements.guideGrid.querySelectorAll(".program-block:not(.empty)");
  const nowMs = Date.now();

  blocks.forEach((block) => {
    const startMs = Number(block.dataset.absoluteStart);
    const endMs = Number(block.dataset.absoluteEnd);
    const isLive = nowMs >= startMs && nowMs < endMs;

    block.dataset.live = String(isLive);
    block.classList.toggle("live", isLive);
  });

  refreshSelectionStyles();
}

function tickLiveState() {
  if (!state.rows.length) {
    return;
  }

  if (shouldRebuildSchedule()) {
    renderSchedule({ centerOnNow: true });
  } else {
    refreshLiveBlockState();
    updatePlayheadPosition();
  }

  updateCurrentChannelDisplay();
}

function startLiveUpdates() {
  window.clearInterval(state.liveTimer);
  state.liveTimer = window.setInterval(tickLiveState, LIVE_TICK_MS);
}

function loadYouTubeApi() {
  if (state.youtubeReady) {
    return state.youtubeReady;
  }

  state.youtubeReady = new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => {
      resolve();
    };

    if (window.YT?.Player) {
      resolve();
    }
  });

  return state.youtubeReady;
}

async function ensurePlayer() {
  if (state.playerReady) {
    return state.playerReady;
  }

  state.playerReady = (async () => {
    await loadYouTubeApi();

    return new Promise((resolve) => {
      state.player = new window.YT.Player("player", {
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => resolve(state.player),
          onStateChange: (event) => {
            if (event.data === window.YT.PlayerState.ENDED) {
              playNextVideo();
            }
          },
        },
      });
    });
  })();

  return state.playerReady;
}

async function loadGuide() {
  const response = await fetch("/api/guide");
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Unable to load the TV guide.");
  }

  state.guide = payload;
  buildRows();

  elements.subtitle.textContent = state.rows.length
    ? "Click any listing below to tune the player to that channel's live feed."
    : "No guide data exists yet. Add channels from the admin dashboard first.";
}

function findVideoInCurrentCategory(videoId) {
  const row = getRowByCategory(state.currentCategory);

  if (!row || !Array.isArray(row.videos)) {
    return { row, index: -1 };
  }

  const index = row.videos.findIndex((video) => video.videoId === videoId);
  return { row, index };
}

async function playNextVideo() {
  const { row, index } = findVideoInCurrentCategory(state.currentVideoId);

  if (!row || !row.videos.length || !state.player) {
    return;
  }

  const nextIndex = index >= 0 ? (index + 1) % row.videos.length : 0;
  const nextVideo = row.videos[nextIndex];

  state.currentVideoId = nextVideo.videoId;
  updateCurrentChannelDisplay();
  setStatus(`Advancing to the next scheduled program on ${row.categoryName}.`);
  state.player.loadVideoById({ videoId: nextVideo.videoId, startSeconds: 0 });
}

async function tuneIntoCategory(categoryName, { userInitiated = false, mode = "full" } = {}) {
  const row = getRowByCategory(categoryName);

  if (!row || !row.videos.length) {
    setStatus(`No playable videos are available on ${categoryName}.`);
    return;
  }

  if (userInitiated) {
    const selectedRow = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
      (element) => element.dataset.category === categoryName
    );

    if (selectedRow) {
      const rowRect = selectedRow.getBoundingClientRect();
      const gridRect = elements.guideGrid.getBoundingClientRect();

      if (rowRect.top < gridRect.top) {
        elements.guideGrid.scrollBy({ top: rowRect.top - gridRect.top, behavior: "smooth" });
      } else if (rowRect.bottom > gridRect.bottom) {
        elements.guideGrid.scrollBy({ top: rowRect.bottom - gridRect.bottom, behavior: "smooth" });
      }
    }
  }

  state.currentCategory = categoryName;
  state.focusedCategory = categoryName;
  updateCurrentChannelDisplay();
  refreshSelectionStyles();
  showOverlay({ mode });
  setStatus(`Tuning into ${categoryName}...`);

  try {
    await ensurePlayer();

    const response = await fetch(`/api/tune-in/${encodeURIComponent(categoryName)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Unable to tune into ${categoryName}.`);
    }

    state.currentVideoId = payload.videoId;
    updateCurrentChannelDisplay();
    setStatus(`Now playing ${payload.title}.`);

    state.player.loadVideoById({
      videoId: payload.videoId,
      startSeconds: payload.startSeconds,
    });

    showOverlay({ mode });
  } catch (error) {
    showOverlay({ persist: true, mode });
    setStatus(error.message);
  }
}

function changeChannel(step, mode = "full") {
  const playableRows = getPlayableRows();

  if (!playableRows.length) {
    return;
  }

  const currentIndex = playableRows.findIndex((row) => row.categoryName === state.currentCategory);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + step + playableRows.length) % playableRows.length;
  const nextRow = playableRows[nextIndex];

  if (!nextRow) {
    return;
  }

  tuneIntoCategory(nextRow.categoryName, { userInitiated: true, mode });
}

function handleGuideClick(event) {
  const label = event.target.closest(".channel-label");

  if (label?.dataset.category) {
    tuneIntoCategory(label.dataset.category, { userInitiated: true });
    return;
  }

  const block = event.target.closest(".program-block:not(.empty)");

  if (!block) {
    return;
  }

  tuneIntoCategory(block.dataset.category, { userInitiated: true });
}

function scrollToFocusedRow() {
  const targetCategory = state.focusedCategory || state.currentCategory;
  if (!targetCategory) return;

  const rowElement = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
    (el) => el.dataset.category === targetCategory
  );

  if (rowElement) {
    const rowRect = rowElement.getBoundingClientRect();
    const gridRect = elements.guideGrid.getBoundingClientRect();

    if (rowRect.top < gridRect.top) {
      elements.guideGrid.scrollBy({ top: rowRect.top - gridRect.top, behavior: "smooth" });
    } else if (rowRect.bottom > gridRect.bottom) {
      elements.guideGrid.scrollBy({ top: rowRect.bottom - gridRect.bottom, behavior: "smooth" });
    }
  }
}

function handleVerticalNav(step) {
  const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");
  
  if (!isFullMode) {
    showOverlay({ mode: "full" });
    state.focusedCategory = state.currentCategory;
    refreshSelectionStyles();
    window.setTimeout(scrollToFocusedRow, 10);
    return;
  }

  showOverlay({ mode: "full" });

  const playableRows = getPlayableRows();
  if (!playableRows.length) return;

  const currentFocus = state.focusedCategory || state.currentCategory;
  const currentIndex = playableRows.findIndex((row) => row.categoryName === currentFocus);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  
  let nextIndex = safeIndex + step;
  if (nextIndex < 0) nextIndex = playableRows.length - 1;
  if (nextIndex >= playableRows.length) nextIndex = 0;

  state.focusedCategory = playableRows[nextIndex].categoryName;
  refreshSelectionStyles();
  scrollToFocusedRow();
}

function initializeInteractions() {
  elements.hoverSurface.addEventListener("mousemove", () => {
    showOverlay({ mode: "full" });
  });
  elements.overlay.addEventListener("mousemove", () => {
    showOverlay({ mode: "full" });
  });
  elements.overlay.addEventListener("click", () => {
    showOverlay({ mode: "full" });
  });

  elements.guideGrid.addEventListener("click", handleGuideClick);
  elements.guideGrid.addEventListener("scroll", () => {
    showOverlay({ mode: "full" });
    syncTimebarScroll();
    updatePlayheadPosition();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      handleVerticalNav(-1);
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      handleVerticalNav(1);
      return;
    }

    if (event.key === "Enter") {
      const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");
      if (isFullMode && state.focusedCategory && state.focusedCategory !== state.currentCategory) {
        event.preventDefault();
        tuneIntoCategory(state.focusedCategory, { userInitiated: true, mode: "full" });
      } else if (isFullMode) {
        event.preventDefault();
        showOverlay({ mode: "info" });
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      changeChannel(-1, "info");
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      changeChannel(1, "info");
      return;
    }

    showOverlay({ mode: "full" });
  });
  window.addEventListener("resize", () => {
    if (state.rows.length) {
      renderSchedule();
    }
  });
}

async function initializeTv() {
  initializeInteractions();
  showOverlay({ persist: true, mode: "info" });
  setStatus("Loading TV guide...");

  try {
    await loadGuide();
    renderSchedule({ centerOnNow: true });
    startLiveUpdates();

    const availableCategory = state.rows.find((row) => row.videos.length > 0);

    if (availableCategory) {
      await tuneIntoCategory(availableCategory.categoryName, { mode: "info" });
    } else {
      elements.currentCategory.textContent = "Guide empty";
      elements.currentTitle.textContent = "No playable videos available";
      elements.currentMeta.textContent = "Add a valid YouTube API key and at least one working channel ID in the admin dashboard.";
      setStatus("No playable categories were found in the local guide.");
    }
  } catch (error) {
    elements.currentCategory.textContent = "Connection issue";
    elements.currentTitle.textContent = "Unable to load Static Stream";
    elements.currentMeta.textContent = "The local server may still be starting up, or the guide request failed.";
    setStatus(error.message);
  }
}

initializeTv();
