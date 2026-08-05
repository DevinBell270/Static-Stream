let PIXELS_PER_MINUTE = 10;
const MARKER_MINUTES = 30;
const WINDOW_BEFORE_MINUTES = 0;
const WINDOW_AFTER_MINUTES = 540;
const CHANNEL_NUMBER_START = 101;
const LIVE_TICK_MS = 1000;
const SCHEDULE_REBUILD_BUFFER_MINUTES = 60;
const OVERLAY_HIDE_DELAY_MS = 2800;
const SPONSOR_CHECK_MS = 1000;
const SPONSORBLOCK_API = "https://sponsor.ajay.app";
const STORAGE_KEY = "staticStreamCurrentCategory";
const SUBTITLES_STORAGE_KEY = "staticStreamSubtitlesEnabled";

function readSavedCategory() {
  if (typeof localStorage === "undefined") {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw || !String(raw).trim()) {
      return null;
    }
    return String(raw).trim();
  } catch {
    return null;
  }
}

function persistCurrentCategory(categoryName) {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, categoryName);
  } catch {
    // Private mode, quota, or disabled storage — ignore.
  }
}

function readSavedSubtitles() {
  if (typeof localStorage === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(SUBTITLES_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistSubtitles(enabled) {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    localStorage.setItem(SUBTITLES_STORAGE_KEY, String(enabled));
  } catch {
    // Private mode, quota, or disabled storage — ignore.
  }
}

const clockFormatter = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
});

const markerLabelFormatter = new Intl.DateTimeFormat([], {
  hour: "numeric",
  minute: "2-digit",
  weekday: "short",
});

let isPoweredOn = false;

const state = {
  isPoweredOn: false,
  guide: { categories: {} },
  rows: [],
  playerReady: null,
  youtubeReady: null,
  currentCategory: null,
  focusedCategory: null,
  focusedProgramIndex: null,
  currentVideoId: null,
  liveTimer: null,
  guideHideTimer: null,
  scheduleWindowStartMs: 0,
  scheduleWindowEndMs: 0,
  scheduleWidthPx: 0,
  hasCenteredOnNow: false,
  hasUserSelectedChannel: false,
  programmaticScroll: false,
  sponsorSegments: [],
  skippedSegmentIds: new Set(),
  sponsorCheckTimer: null,
  subtitlesEnabled: readSavedSubtitles(),
};

const elements = {
  standbyOverlay: document.querySelector("#standby-overlay"),
  powerOnBtn: document.querySelector("#power-on-btn"),
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
  staleBanner: document.querySelector("#stale-banner"),
  staleBannerDetail: document.querySelector("#stale-banner-detail"),
  staleBannerClose: document.querySelector("#stale-banner-close"),
  subtitleToggle: document.querySelector("#subtitle-toggle"),
  muteToggle: document.querySelector("#mute-toggle"),
};

function setStatus(message) {
  elements.status.textContent = message;
}

function applySubtitlesState(enabled) {
  if (!state.player) {
    return;
  }

  try {
    if (enabled) {
      if (typeof state.player.loadModule === "function") {
        state.player.loadModule("captions");
        state.player.loadModule("cc");
      }
      if (typeof state.player.setOption === "function") {
        state.player.setOption("captions", "track", { languageCode: "en" });
        state.player.setOption("cc", "track", { languageCode: "en" });
      }
    } else {
      if (typeof state.player.unloadModule === "function") {
        state.player.unloadModule("captions");
        state.player.unloadModule("cc");
      }
      if (typeof state.player.setOption === "function") {
        state.player.setOption("captions", "track", {});
        state.player.setOption("cc", "track", {});
      }
    }
  } catch {
    // Best effort caption toggle; ignore if unsupported on specific track
  }
}

function updateSubtitleToggleUI() {
  if (!elements.subtitleToggle) {
    return;
  }

  const enabled = state.subtitlesEnabled;
  elements.subtitleToggle.classList.toggle("active", enabled);
  elements.subtitleToggle.setAttribute("aria-pressed", String(enabled));

  const iconSpan = elements.subtitleToggle.querySelector(".control-icon");
  const labelSpan = elements.subtitleToggle.querySelector(".control-label");
  const pillSpan = elements.subtitleToggle.querySelector(".toggle-pill");

  if (iconSpan && labelSpan && pillSpan) {
    iconSpan.textContent = "💬";
    labelSpan.textContent = "Subtitles";
    pillSpan.textContent = enabled ? "ON" : "OFF";
  } else {
    elements.subtitleToggle.innerHTML = `<span class="control-icon" aria-hidden="true">💬</span><span class="control-label">Subtitles</span><span class="toggle-pill" aria-hidden="true">${enabled ? "ON" : "OFF"}</span>`;
  }
}

function updateMuteToggleUI(overrideIsMuted) {
  if (!elements.muteToggle) {
    return;
  }

  const isMuted = typeof overrideIsMuted === "boolean"
    ? overrideIsMuted
    : (state.player && typeof state.player.isMuted === "function" ? state.player.isMuted() : false);
  const soundActive = !isMuted;

  elements.muteToggle.classList.toggle("active", soundActive);
  elements.muteToggle.setAttribute("aria-pressed", String(soundActive));

  const iconSpan = elements.muteToggle.querySelector(".control-icon");
  const labelSpan = elements.muteToggle.querySelector(".control-label");
  const pillSpan = elements.muteToggle.querySelector(".toggle-pill");

  const icon = soundActive ? "🔊" : "🔇";
  const statusText = soundActive ? "ON" : "OFF";

  if (iconSpan && labelSpan && pillSpan) {
    iconSpan.textContent = icon;
    labelSpan.textContent = "Sound";
    pillSpan.textContent = statusText;
  } else {
    elements.muteToggle.innerHTML = `<span class="control-icon" aria-hidden="true">${icon}</span><span class="control-label">Sound</span><span class="toggle-pill" aria-hidden="true">${statusText}</span>`;
  }
}

function toggleSubtitles() {
  state.subtitlesEnabled = !state.subtitlesEnabled;
  persistSubtitles(state.subtitlesEnabled);
  applySubtitlesState(state.subtitlesEnabled);
  updateSubtitleToggleUI();
  setStatus(state.subtitlesEnabled ? "Subtitles enabled." : "Subtitles disabled.");
}

function toggleMute() {
  if (!state.player) {
    return;
  }

  const currentlyMuted = typeof state.player.isMuted === "function" ? state.player.isMuted() : false;

  if (currentlyMuted) {
    state.player.unMute();
    setStatus("Audio unmuted.");
    updateMuteToggleUI(false);
  } else {
    state.player.mute();
    setStatus("Audio muted.");
    updateMuteToggleUI(true);
  }
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
    if (!state.focusedCategory && state.currentCategory) {
      state.focusedCategory = state.currentCategory;
      refreshSelectionStyles();
    }
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

  rowElement.className = "epg-row";
  rowElement.dataset.category = row.categoryName;

  label.type = "button";
  label.className = "channel-label";
  label.dataset.category = row.categoryName;
  number.className = "channel-number";
  name.className = "channel-name";
  number.textContent = `CH ${row.channelNumber}`;
  name.textContent = row.categoryName;

  label.append(number, name);

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
  const segments = buildSegmentsForRow(row, nowMs);

  rowElement.className = "epg-row";
  rowElement.dataset.category = row.categoryName;

  label.type = "button";
  label.className = "channel-label";
  label.dataset.category = row.categoryName;
  number.className = "channel-number";
  name.className = "channel-name";
  number.textContent = `CH ${row.channelNumber}`;
  name.textContent = row.categoryName;
  label.append(number, name);

  scroller.className = "timeline-scroller";
  track.className = "timeline-track";
  track.style.width = `${state.scheduleWidthPx}px`;

  segments.forEach((segment) => {
    const block = document.createElement("button");
    const title = document.createElement("span");
    const titleText = document.createElement("span");
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
    block.title = `${segment.video.title} (${formatClock(segment.absoluteStartMs)} - ${formatClock(segment.absoluteEndMs)})`;
    block.setAttribute(
      "aria-label",
      `${row.categoryName}, ${segment.video.title}, ${formatClock(segment.absoluteStartMs)} to ${formatClock(segment.absoluteEndMs)}`,
    );

    if (segment.isLive) {
      block.classList.add("live");
    }

    title.className = "program-title";
    titleText.className = "program-title-text";
    titleText.textContent = segment.video.title;
    title.append(titleText);

    meta.className = "program-meta";
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

  let targetedBlock = null;
  if (state.focusedCategory && state.focusedProgramIndex !== null) {
    const focusedRowElement = Array.from(rows).find((r) => r.dataset.category === state.focusedCategory);
    if (focusedRowElement) {
      const rowBlocks = Array.from(focusedRowElement.querySelectorAll(".program-block:not(.empty)"));
      targetedBlock = rowBlocks[state.focusedProgramIndex] || null;
    }
  }

  rows.forEach((row) => {
    const isSelected = row.dataset.category === state.currentCategory;
    const isFocused = row.dataset.category === state.focusedCategory;
    row.classList.toggle("selected", isSelected);
    row.classList.toggle("focused", isFocused);
    row.classList.toggle("channel-focused", isFocused && state.focusedProgramIndex === null);
  });

  blocks.forEach((block) => {
    const isSelectedRow = block.dataset.category === state.currentCategory;
    const isLiveBlock = block.dataset.live === "true";
    block.classList.toggle("selected", isSelectedRow && isLiveBlock);
    block.classList.toggle("focused", block === targetedBlock);
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
  const currentTimePx = getPixelsFromWindowStart(Date.now());
  const desiredOffsetPx = 0;
  const maxScrollLeft = Math.max((labelWidth + state.scheduleWidthPx) - elements.guideGrid.clientWidth, 0);
  const targetScrollLeft = Math.min(Math.max(currentTimePx - desiredOffsetPx, 0), maxScrollLeft);

  state.programmaticScroll = true;
  elements.guideGrid.scrollLeft = targetScrollLeft;
  syncTimebarScroll();
  updatePlayheadPosition();
  state.hasCenteredOnNow = true;
  state.programmaticScroll = false;
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

  state.programmaticScroll = true;
  elements.guideGrid.scrollTop = previousScrollTop;

  if (centerOnNow) {
    centerScheduleOnNow();
  } else {
    elements.guideGrid.scrollLeft = previousScrollLeft;
  }

  syncTimebarScroll();
  updatePlayheadPosition();
  state.programmaticScroll = false;
}

function shouldRebuildSchedule(nowMs = Date.now()) {
  const bufferMs = SCHEDULE_REBUILD_BUFFER_MINUTES * 60 * 1000;
  return nowMs <= state.scheduleWindowStartMs + bufferMs || nowMs >= state.scheduleWindowEndMs - bufferMs;
}

function refreshLiveBlockState() {
  const blocks = elements.guideGrid.querySelectorAll(".program-block:not(.empty)");
  const nowMs = Date.now();
  let nextBoundaryMs = Infinity;

  blocks.forEach((block) => {
    const startMs = Number(block.dataset.absoluteStart);
    const endMs = Number(block.dataset.absoluteEnd);
    const isLive = nowMs >= startMs && nowMs < endMs;

    block.dataset.live = String(isLive);
    block.classList.toggle("live", isLive);

    if (isLive) {
      if (endMs > nowMs && endMs < nextBoundaryMs) {
        nextBoundaryMs = endMs;
      }
    } else if (startMs > nowMs && startMs < nextBoundaryMs) {
      nextBoundaryMs = startMs;
    }
  });

  state.nextLiveBoundaryMs = Number.isFinite(nextBoundaryMs) ? nextBoundaryMs : nowMs + 60000;
  refreshSelectionStyles();
}

function tickLiveState() {
  if (!state.rows.length) {
    return;
  }

  const nowMs = Date.now();

  if (shouldRebuildSchedule(nowMs)) {
    renderSchedule({ centerOnNow: true });
  } else {
    if (nowMs >= (state.nextLiveBoundaryMs || 0)) {
      refreshLiveBlockState();
    }
    updatePlayheadPosition();
  }

  updateCurrentChannelDisplay();
}

function startLiveUpdates() {
  window.clearInterval(state.liveTimer);
  state.liveTimer = window.setInterval(tickLiveState, LIVE_TICK_MS);
}

async function fetchSponsorSegments(videoId) {
  state.sponsorSegments = [];
  state.skippedSegmentIds = new Set();

  try {
    const url = `${SPONSORBLOCK_API}/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(JSON.stringify(["sponsor"]))}`;
    const response = await fetch(url);

    if (!response.ok) {
      return;
    }

    const data = await response.json();

    state.sponsorSegments = data
      .filter((entry) => Array.isArray(entry.segment) && entry.segment.length === 2)
      .map((entry) => ({ start: entry.segment[0], end: entry.segment[1], uuid: entry.UUID }))
      .sort((a, b) => a.start - b.start);
  } catch {
    // SponsorBlock is best-effort; silently degrade.
  }
}

function stopSponsorSkipLoop() {
  window.clearInterval(state.sponsorCheckTimer);
  state.sponsorCheckTimer = null;
}

function startSponsorSkipLoop() {
  stopSponsorSkipLoop();

  state.sponsorCheckTimer = window.setInterval(() => {
    if (!state.player || !state.sponsorSegments.length) {
      return;
    }

    const currentTime = state.player.getCurrentTime();

    for (const segment of state.sponsorSegments) {
      if (state.skippedSegmentIds.has(segment.uuid)) {
        continue;
      }

      if (currentTime >= segment.start && currentTime < segment.end) {
        state.skippedSegmentIds.add(segment.uuid);
        state.player.seekTo(segment.end, true);
        setStatus("Skipped sponsor segment.");
        break;
      }
    }
  }, SPONSOR_CHECK_MS);
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
          fs: 0,
          iv_load_policy: 3,
          cc_load_policy: 0,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            applySubtitlesState(state.subtitlesEnabled);
            updateSubtitleToggleUI();
            updateMuteToggleUI();
            resolve(state.player);
          },
          onStateChange: (event) => {
            if (event.data === window.YT.PlayerState.PLAYING) {
              applySubtitlesState(state.subtitlesEnabled);
              updateMuteToggleUI();
            }
            if (event.data === window.YT.PlayerState.ENDED) {
              stopSponsorSkipLoop();
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

  if (elements.subtitle) {
    elements.subtitle.textContent = state.rows.length
      ? "Click any listing below to tune the player to that channel's live feed."
      : "No guide data exists yet. Add channels from the admin dashboard first.";
  }
}

/**
 * Fetches /api/status and, if the last refresh failed, shows the stale-cache
 * warning banner. This runs fire-and-forget so it never blocks startup.
 */
async function checkAndShowStaleWarning() {
  try {
    const response = await fetch("/api/status");

    if (!response.ok) {
      return;
    }

    const status = await response.json();

    if (!status.isStale) {
      return;
    }

    const failedAt = status.failedAt
      ? new Date(status.failedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : null;

    const detail = [
      "The YouTube API was unavailable during the last scheduled refresh.",
      failedAt ? `Last failed: ${failedAt}.` : null,
      "Showing cached content from the previous successful update.",
    ]
      .filter(Boolean)
      .join(" ");

    if (elements.staleBannerDetail) {
      elements.staleBannerDetail.textContent = detail;
    }

    if (elements.staleBanner) {
      elements.staleBanner.hidden = false;
    }

    if (elements.staleBannerClose) {
      elements.staleBannerClose.addEventListener("click", () => {
        elements.staleBanner.hidden = true;
      }, { once: true });
    }
  } catch {
    // Status check is best-effort; never surface this error to the user.
  }
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
  applySubtitlesState(state.subtitlesEnabled);
  fetchSponsorSegments(nextVideo.videoId).then(startSponsorSkipLoop);
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

      if (rowRect.top < gridRect.top || rowRect.bottom > gridRect.bottom) {
        state.programmaticScroll = true;
        elements.guideGrid.scrollBy({
          top: rowRect.top < gridRect.top
            ? rowRect.top - gridRect.top
            : rowRect.bottom - gridRect.bottom,
          behavior: "smooth",
        });
        window.setTimeout(() => { state.programmaticScroll = false; }, 350);
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

    if (!isPoweredOn) {
      if (typeof state.player.mute === "function") {
        state.player.mute();
      }
    } else {
      if (typeof state.player.unMute === "function") {
        state.player.unMute();
      }
    }

    applySubtitlesState(state.subtitlesEnabled);

    fetchSponsorSegments(payload.videoId).then(startSponsorSkipLoop);
    persistCurrentCategory(categoryName);
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

  tuneIntoCategory(nextRow.categoryName, { mode });
}

function handleGuideClick(event) {
  const label = event.target.closest(".channel-label");

  if (label?.dataset.category) {
    state.focusedCategory = label.dataset.category;
    state.focusedProgramIndex = null;
    tuneIntoCategory(label.dataset.category, { userInitiated: true });
    return;
  }

  const block = event.target.closest(".program-block:not(.empty)");

  if (!block) {
    return;
  }

  state.focusedCategory = block.dataset.category;
  const rowElement = block.closest(".epg-row");
  if (rowElement) {
    const blocks = Array.from(rowElement.querySelectorAll(".program-block:not(.empty)"));
    const idx = blocks.indexOf(block);
    state.focusedProgramIndex = idx >= 0 ? idx : null;
  }

  tuneIntoCategory(block.dataset.category, { userInitiated: true });
}

function scrollToFocusedElement() {
  const targetCategory = state.focusedCategory || state.currentCategory;
  if (!targetCategory) return;

  const rowElement = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
    (el) => el.dataset.category === targetCategory
  );

  if (!rowElement) return;

  state.programmaticScroll = true;

  /* ── Vertical: keep the focused row visible ── */
  const gridRect = elements.guideGrid.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const VERTICAL_PAD = 10;

  let targetScrollTop = elements.guideGrid.scrollTop;

  if (rowRect.top < gridRect.top) {
    // Row is above the visible area — scroll up
    targetScrollTop += (rowRect.top - gridRect.top) - VERTICAL_PAD;
  } else if (rowRect.bottom > gridRect.bottom) {
    // Row is below the visible area — scroll down
    targetScrollTop += (rowRect.bottom - gridRect.bottom) + VERTICAL_PAD;
  }

  targetScrollTop = Math.max(0, targetScrollTop);

  /* ── Horizontal: keep the focused program block visible ── */
  let targetScrollLeft = elements.guideGrid.scrollLeft;
  const labelWidth = document.querySelector(".timebar-label")?.offsetWidth || 220;
  const HORIZONTAL_PAD = 40;

  if (state.focusedProgramIndex !== null) {
    const rowBlocks = Array.from(rowElement.querySelectorAll(".program-block:not(.empty)"));
    const focusedBlock = rowBlocks[state.focusedProgramIndex];

    if (focusedBlock) {
      const blockRect = focusedBlock.getBoundingClientRect();
      // The visible timeline area starts after the sticky channel label
      const timelineLeft = gridRect.left + labelWidth;
      const timelineRight = gridRect.right;

      if (blockRect.left < timelineLeft) {
        // Block is hidden behind or before the label column — scroll left
        targetScrollLeft += (blockRect.left - timelineLeft) - HORIZONTAL_PAD;
      } else if (blockRect.right > timelineRight) {
        // Block extends past the right edge — scroll right
        targetScrollLeft += (blockRect.right - timelineRight) + HORIZONTAL_PAD;
      }

      targetScrollLeft = Math.max(0, targetScrollLeft);
    }
  } else {
    // Channel-level focus (no program selected) — scroll to the "now" position
    const nowPx = getPixelsFromWindowStart(Date.now());
    const maxScrollLeft = Math.max((labelWidth + state.scheduleWidthPx) - elements.guideGrid.clientWidth, 0);
    targetScrollLeft = Math.min(Math.max(nowPx - 20, 0), maxScrollLeft);
  }

  elements.guideGrid.scrollTo({
    top: targetScrollTop,
    left: targetScrollLeft,
    behavior: "auto",
  });

  syncTimebarScroll();
  updatePlayheadPosition();

  // Reset programmatic scroll flag after a short delay so the UI doesn't
  // treat this as a user-initiated scroll.
  window.clearTimeout(state._scrollResetTimer);
  state._scrollResetTimer = window.setTimeout(() => {
    state.programmaticScroll = false;
    syncTimebarScroll();
    updatePlayheadPosition();
  }, 100);
}

function handleVerticalNav(step) {
  const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");

  if (!isFullMode) {
    showOverlay({ persist: true, mode: "full" });
    state.focusedCategory = state.currentCategory;
    state.focusedProgramIndex = null;
    refreshSelectionStyles();
    window.setTimeout(scrollToFocusedElement, 10);
    return;
  }

  showOverlay({ persist: true, mode: "full" });

  const playableRows = getPlayableRows();
  if (!playableRows.length) return;

  const currentFocus = state.focusedCategory || state.currentCategory;
  const currentIndex = playableRows.findIndex((row) => row.categoryName === currentFocus);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;

  let nextIndex = safeIndex + step;
  if (nextIndex < 0) nextIndex = playableRows.length - 1;
  if (nextIndex >= playableRows.length) nextIndex = 0;

  const targetCategory = playableRows[nextIndex].categoryName;
  const prevCategory = state.focusedCategory;
  state.focusedCategory = targetCategory;

  if (state.focusedProgramIndex !== null) {
    const prevRowElement = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
      (el) => el.dataset.category === prevCategory
    );
    const targetRowElement = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
      (el) => el.dataset.category === targetCategory
    );

    if (prevRowElement && targetRowElement) {
      const prevBlocks = Array.from(prevRowElement.querySelectorAll(".program-block:not(.empty)"));
      const targetBlocks = Array.from(targetRowElement.querySelectorAll(".program-block:not(.empty)"));
      const currentBlock = prevBlocks[state.focusedProgramIndex];

      if (currentBlock && targetBlocks.length) {
        const curStart = Number(currentBlock.dataset.absoluteStart);
        const curEnd = Number(currentBlock.dataset.absoluteEnd);
        const midTime = (curStart + curEnd) / 2;

        let bestIndex = 0;
        let minDiff = Infinity;

        targetBlocks.forEach((tb, i) => {
          const tStart = Number(tb.dataset.absoluteStart);
          const tEnd = Number(tb.dataset.absoluteEnd);

          if (midTime >= tStart && midTime < tEnd) {
            bestIndex = i;
            minDiff = 0;
          } else if (minDiff > 0) {
            const diff = Math.abs(midTime - (tStart + tEnd) / 2);
            if (diff < minDiff) {
              minDiff = diff;
              bestIndex = i;
            }
          }
        });

        state.focusedProgramIndex = bestIndex;
      } else if (targetBlocks.length) {
        state.focusedProgramIndex = Math.min(state.focusedProgramIndex, targetBlocks.length - 1);
      } else {
        state.focusedProgramIndex = null;
      }
    }
  }

  refreshSelectionStyles();
  scrollToFocusedElement();
}

function handleHorizontalNav(step) {
  const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");

  if (!isFullMode) {
    changeChannel(step, "info");
    return;
  }

  showOverlay({ persist: true, mode: "full" });

  const currentFocus = state.focusedCategory || state.currentCategory;
  const rowElement = Array.from(elements.guideGrid.querySelectorAll(".epg-row")).find(
    (el) => el.dataset.category === currentFocus
  );

  if (!rowElement) return;

  const rowBlocks = Array.from(rowElement.querySelectorAll(".program-block:not(.empty)"));

  if (!rowBlocks.length) return;

  if (state.focusedProgramIndex === null) {
    if (step > 0) {
      let liveIndex = rowBlocks.findIndex((b) => b.dataset.live === "true");
      if (liveIndex < 0) liveIndex = 0;
      state.focusedProgramIndex = liveIndex;
    }
  } else {
    const nextIndex = state.focusedProgramIndex + step;
    if (nextIndex < 0) {
      state.focusedProgramIndex = null;
    } else if (nextIndex < rowBlocks.length) {
      state.focusedProgramIndex = nextIndex;
    }
  }

  refreshSelectionStyles();
  scrollToFocusedElement();
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

  if (elements.subtitleToggle) {
    elements.subtitleToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSubtitles();
    });
  }

  if (elements.muteToggle) {
    elements.muteToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMute();
    });
  }

  elements.guideGrid.addEventListener("click", handleGuideClick);
  elements.guideGrid.addEventListener("scroll", () => {
    if (!state.programmaticScroll) {
      showOverlay({ mode: "full" });
    }
    syncTimebarScroll();
    updatePlayheadPosition();
  });
  window.addEventListener("keydown", (event) => {
    if (!isPoweredOn) {
      return;
    }

    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
      return;
    }

    if (event.key === "c" || event.key === "C") {
      event.preventDefault();
      toggleSubtitles();
      return;
    }

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
      event.preventDefault();
      const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");
      if (isFullMode && state.focusedCategory && state.focusedCategory !== state.currentCategory) {
        tuneIntoCategory(state.focusedCategory, { userInitiated: true, mode: "info" });
      } else {
        showOverlay({ mode: "info" });
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      handleHorizontalNav(-1);
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      handleHorizontalNav(1);
      return;
    }

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      toggleMute();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      const isFullMode = elements.overlay.classList.contains("visible") && !elements.overlay.classList.contains("info-only");
      if (isFullMode) {
        showOverlay({ mode: "info" });
      } else {
        hideOverlay();
      }
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

function handlePowerOnKey(event) {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
    return;
  }
  handlePowerOn();
}

function handlePowerOn() {
  if (isPoweredOn) {
    return;
  }
  isPoweredOn = true;
  state.isPoweredOn = true;

  window.removeEventListener("keydown", handlePowerOnKey);

  const standbyOverlay = elements.standbyOverlay || document.querySelector("#standby-overlay");
  if (standbyOverlay) {
    standbyOverlay.classList.add("crt-wake");
    window.setTimeout(() => {
      standbyOverlay.style.display = "none";
    }, 400);
  }

  if (state.player) {
    try {
      if (typeof state.player.unMute === "function") {
        state.player.unMute();
      }
      if (typeof state.player.setVolume === "function") {
        state.player.setVolume(100);
      }
      if (typeof state.player.playVideo === "function") {
        state.player.playVideo();
      }
      updateMuteToggleUI(false);
    } catch {
      // Ignore player call errors
    }
  }

  const availableCategory = state.rows.find((row) => row.videos.length > 0);
  const savedName = readSavedCategory();
  const savedRow = savedName ? getRowByCategory(savedName) : null;
  const categoryToTune = savedRow && savedRow.videos.length > 0 ? savedRow : availableCategory;

  if (categoryToTune) {
    tuneIntoCategory(categoryToTune.categoryName, { mode: "info" });
  } else {
    showOverlay({ mode: "info" });
  }
}

function setupStandbyOverlay() {
  const standbyOverlay = elements.standbyOverlay || document.querySelector("#standby-overlay");
  if (standbyOverlay) {
    standbyOverlay.addEventListener("click", handlePowerOn);
  }
  window.addEventListener("keydown", handlePowerOnKey);
}

async function initializeTv() {
  setupStandbyOverlay();
  initializeInteractions();
  updateSubtitleToggleUI();
  updateMuteToggleUI();
  showOverlay({ persist: true, mode: "info" });
  setStatus("Loading TV guide...");

  try {
    await loadGuide();
    // Fire-and-forget: check if we're serving stale data and notify the user.
    checkAndShowStaleWarning();
    renderSchedule({ centerOnNow: true });
    startLiveUpdates();

    const availableCategory = state.rows.find((row) => row.videos.length > 0);
    const savedName = readSavedCategory();
    const savedRow = savedName ? getRowByCategory(savedName) : null;
    const categoryToTune =
      savedRow && savedRow.videos.length > 0 ? savedRow : availableCategory;

    if (categoryToTune) {
      await tuneIntoCategory(categoryToTune.categoryName, { mode: "info" });
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
