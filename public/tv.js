const state = {
  guide: { categories: {} },
  player: null,
  playerReady: null,
  youtubeReady: null,
  currentCategory: null,
  currentVideoId: null,
  guideHideTimer: null,
};

const elements = {
  overlay: document.querySelector("#guide-overlay"),
  hoverSurface: document.querySelector("#hover-surface"),
  categoriesList: document.querySelector("#categories-list"),
  currentCategory: document.querySelector("#current-category"),
  currentTitle: document.querySelector("#current-title"),
  currentMeta: document.querySelector("#current-meta"),
  status: document.querySelector("#tv-status"),
  subtitle: document.querySelector("#guide-subtitle"),
};

function setStatus(message) {
  elements.status.textContent = message;
}

function showOverlay() {
  elements.overlay.classList.add("visible");
  window.clearTimeout(state.guideHideTimer);
  state.guideHideTimer = window.setTimeout(() => {
    elements.overlay.classList.remove("visible");
  }, 2800);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getCategory(categoryName) {
  return state.guide.categories?.[categoryName] || null;
}

function updateNowPlaying(details) {
  elements.currentCategory.textContent = details.category || "No category selected";
  elements.currentTitle.textContent = details.title || "Choose a category to tune in.";
  elements.currentMeta.textContent = details.meta;
}

function renderCategories() {
  const entries = Object.entries(state.guide.categories || {}).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );

  if (entries.length === 0) {
    elements.categoriesList.innerHTML = '<p class="current-meta">No categories available yet. Add one from the admin dashboard.</p>';
    return;
  }

  elements.categoriesList.replaceChildren(
    ...entries.map(([categoryName, category]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "category-button";

      if (categoryName === state.currentCategory) {
        button.classList.add("active");
      }

      const videoCount = category.videos?.length || 0;
      button.disabled = videoCount === 0;
      button.innerHTML = `
        <strong>${categoryName}</strong>
        <span>${videoCount} playable video${videoCount === 1 ? "" : "s"}</span>
      `;

      if (!button.disabled) {
        button.addEventListener("click", () => {
          tuneIntoCategory(categoryName);
        });
      }

      return button;
    }),
  );
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
  renderCategories();

  const categoryCount = Object.keys(state.guide.categories || {}).length;
  elements.subtitle.textContent = categoryCount
    ? "Move your mouse to reveal the guide and jump between custom channels."
    : "No guide data exists yet. Add channels from the admin dashboard first.";
}

function findVideoInCurrentCategory(videoId) {
  const category = getCategory(state.currentCategory);

  if (!category || !Array.isArray(category.videos)) {
    return { category, index: -1 };
  }

  const index = category.videos.findIndex((video) => video.videoId === videoId);
  return { category, index };
}

async function playNextVideo() {
  const { category, index } = findVideoInCurrentCategory(state.currentVideoId);

  if (!category || !category.videos?.length) {
    return;
  }

  const nextIndex = index >= 0 ? (index + 1) % category.videos.length : 0;
  const nextVideo = category.videos[nextIndex];

  state.currentVideoId = nextVideo.videoId;
  updateNowPlaying({
    category: state.currentCategory,
    title: nextVideo.title,
    meta: `Playing next in the loop · ${formatDuration(nextVideo.durationSeconds)} runtime`,
  });
  setStatus("Advancing to the next scheduled video.");
  state.player.loadVideoById({ videoId: nextVideo.videoId, startSeconds: 0 });
}

async function tuneIntoCategory(categoryName) {
  showOverlay();
  setStatus(`Tuning into ${categoryName}...`);

  try {
    await ensurePlayer();

    const response = await fetch(`/api/tune-in/${encodeURIComponent(categoryName)}`);
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Unable to tune into ${categoryName}.`);
    }

    state.currentCategory = categoryName;
    state.currentVideoId = payload.videoId;
    renderCategories();

    updateNowPlaying({
      category: categoryName,
      title: payload.title,
      meta: `Joined ${formatDuration(payload.startSeconds)} into the live broadcast · ${payload.playlistDurationSeconds} seconds in the full loop`,
    });
    setStatus(`Now playing ${payload.title}.`);

    state.player.loadVideoById({
      videoId: payload.videoId,
      startSeconds: payload.startSeconds,
    });
  } catch (error) {
    setStatus(error.message);
  }
}

function initializeInteractions() {
  elements.hoverSurface.addEventListener("mousemove", showOverlay);
  elements.overlay.addEventListener("mousemove", showOverlay);
  window.addEventListener("keydown", showOverlay);
}

async function initializeTv() {
  initializeInteractions();
  showOverlay();
  setStatus("Loading TV guide...");

  try {
    await loadGuide();
    const availableCategory = Object.entries(state.guide.categories || {}).find(
      ([, category]) => (category.videos?.length || 0) > 0,
    );

    if (availableCategory) {
      await tuneIntoCategory(availableCategory[0]);
    } else {
      updateNowPlaying({
        category: "Guide empty",
        title: "No playable videos available",
        meta: "Add a valid YouTube API key and at least one working channel ID in the admin dashboard.",
      });
      setStatus("No playable categories were found in the local guide.");
    }
  } catch (error) {
    updateNowPlaying({
      category: "Connection issue",
      title: "Unable to load Static Stream",
      meta: "The local server may still be starting up, or the guide request failed.",
    });
    setStatus(error.message);
  }
}

initializeTv();
