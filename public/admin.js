const state = {
  config: { categories: {} },
  guide: { categories: {} },
  csrfToken: null,
  isSaving: false,
  refreshingCategories: new Set(), // category names currently being refreshed
  nextScheduledRefreshAt: null,
  refreshIntervalHours: null,
  /** After adding a channel, focus this category's inline input on next paint. */
  focusInlineAddAfterRender: null,
};

let nextRefreshCountdownIntervalId = null;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const previewTimersByCategory = new Map();

const elements = {
  categoryForm: document.querySelector("#category-form"),
  newCategoryName: document.querySelector("#new-category-name"),
  addCategoryButton: document.querySelector("#add-category-button"),
  saveButton: document.querySelector("#save-config-button"),
  categoriesContainer: document.querySelector("#categories-container"),
  statsStrip: document.querySelector("#stats-strip"),
  statusBanner: document.querySelector("#status-banner"),
  importButton: document.querySelector("#import-config-button"),
  importInput: document.querySelector("#import-config-input"),
};

function cloneConfig() {
  return structuredClone(state.config);
}

function setStatus(message, variant = "") {
  elements.statusBanner.textContent = message;
  elements.statusBanner.className = "status-banner visible";

  if (variant) {
    elements.statusBanner.classList.add(variant);
  }
}

function clearStatus() {
  elements.statusBanner.className = "status-banner";
  elements.statusBanner.textContent = "";
}

function syncInlineAddControls() {
  document.querySelectorAll(".category-inline-add-form").forEach((form) => {
    const input = form.querySelector(".inline-add-handle");
    const button = form.querySelector(".inline-add-button");
    if (input) {
      input.disabled = state.isSaving;
    }
    if (button) {
      button.disabled = state.isSaving;
    }
  });
}

function setSaving(isSaving) {
  state.isSaving = isSaving;
  elements.saveButton.disabled = isSaving;
  elements.addCategoryButton.disabled = isSaving;
  elements.saveButton.textContent = isSaving ? "Refreshing YouTube Cache..." : "Save Changes";

  // Disable all per-category refresh buttons while a global save is running.
  document.querySelectorAll(".category-refresh-button").forEach((btn) => {
    btn.disabled = isSaving || state.refreshingCategories.has(btn.dataset.category);
  });

  syncInlineAddControls();
}

function getCategoryEntries() {
  return Object.entries(state.config.categories).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
}

/**
 * Handle-only: leading @ and at least one character after @.
 * @param {string} channelValue
 * @returns {{ handle: string } | null}
 */
function normalizeChannelInput(channelValue) {
  const trimmedChannel = channelValue.trim();

  if (!trimmedChannel) {
    return null;
  }

  if (!trimmedChannel.startsWith("@") || trimmedChannel.length < 2) {
    return null;
  }

  return { handle: trimmedChannel };
}

function getChannelEntryKeys(channelEntry) {
  const keys = [];

  if (channelEntry.handle) {
    keys.push(`handle:${channelEntry.handle.toLowerCase()}`);
  }

  if (channelEntry.channelId) {
    keys.push(`id:${channelEntry.channelId}`);
  }

  return keys;
}

function channelEntriesMatch(leftEntry, rightEntry) {
  const leftKeys = new Set(getChannelEntryKeys(leftEntry));
  return getChannelEntryKeys(rightEntry).some((key) => leftKeys.has(key));
}

function getChannelPrimaryLabel(channelEntry) {
  return channelEntry.handle || channelEntry.channelId || "Unknown Channel";
}

function getChannelSecondaryLabel(channelEntry) {
  if (channelEntry.handle && channelEntry.channelId) {
    return channelEntry.channelId;
  }

  return "";
}

function clearNextRefreshCountdown() {
  if (nextRefreshCountdownIntervalId !== null) {
    clearInterval(nextRefreshCountdownIntervalId);
    nextRefreshCountdownIntervalId = null;
  }
}

function startNextRefreshCountdown() {
  clearNextRefreshCountdown();
  nextRefreshCountdownIntervalId = window.setInterval(() => {
    renderStats();
  }, 45_000);
}

/**
 * @param {string | null} isoString
 * @returns {string}
 */
function formatNextRefreshRemaining(isoString) {
  if (!isoString) {
    return "—";
  }

  const target = Date.parse(isoString);

  if (Number.isNaN(target)) {
    return "—";
  }

  const ms = Math.max(0, target - Date.now());
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return "<1m";
}

window.addEventListener("beforeunload", () => {
  clearNextRefreshCountdown();
});

function addCategoryToConfig(categoryName) {
  const trimmedCategory = categoryName.trim();

  if (!trimmedCategory) {
    setStatus("Enter a category name before creating it.", "error");
    return;
  }

  const nextConfig = cloneConfig();

  if (Object.hasOwn(nextConfig.categories, trimmedCategory)) {
    setStatus("That category already exists.", "error");
    return;
  }

  nextConfig.categories[trimmedCategory] = [];
  state.config = nextConfig;
  elements.categoryForm.reset();
  state.focusInlineAddAfterRender = trimmedCategory;
  render();
  setStatus("Category created locally. Save changes when you're ready.");
}

function deleteCategoryFromConfig(categoryName) {
  const nextConfig = cloneConfig();
  delete nextConfig.categories[categoryName];
  state.config = nextConfig;
  previewTimersByCategory.delete(categoryName);
  render();
  setStatus("Category removed locally. Save changes when you're ready.");
}

function buildCategoryDeleteButton(categoryName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-delete-button";
  button.textContent = "Delete Category";
  button.addEventListener("click", () => {
    deleteCategoryFromConfig(categoryName);
  });

  return button;
}

function buildCategoryRefreshButton(categoryName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-refresh-button";
  button.dataset.category = categoryName;
  button.textContent = "↻ Refresh";
  button.disabled = state.isSaving || state.refreshingCategories.has(categoryName);
  button.addEventListener("click", () => {
    refreshCategory(categoryName);
  });

  return button;
}

function renderStats() {
  const categories = getCategoryEntries();
  const totalChannels = categories.reduce((sum, [, channelEntries]) => sum + channelEntries.length, 0);
  const totalVideos = Object.values(state.guide.categories || {}).reduce(
    (sum, category) => sum + (category.videos?.length || 0),
    0,
  );

  const cards = [
    { value: categories.length, label: "Categories" },
    { value: totalChannels, label: "Tracked Channels" },
    { value: totalVideos, label: "Cached Videos" },
    {
      value: formatNextRefreshRemaining(state.nextScheduledRefreshAt),
      label: "Next scheduled refresh",
      title:
        state.refreshIntervalHours != null
          ? `Scheduled full guide refresh every ${state.refreshIntervalHours} hour${
              state.refreshIntervalHours === 1 ? "" : "s"
            }.`
          : "",
    },
  ];

  elements.statsStrip.replaceChildren(
    ...cards.map((card) => {
      const article = document.createElement("article");
      article.className = "stat-card";
      if (card.title) {
        article.title = card.title;
      }
      const strong = document.createElement("strong");
      strong.textContent = String(card.value);
      const span = document.createElement("span");
      span.textContent = card.label;
      article.append(strong, span);
      return article;
    }),
  );
}

function buildDeleteButton(categoryName, channelEntry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "delete-button";
  button.textContent = "Delete";
  button.addEventListener("click", () => {
    const nextConfig = cloneConfig();
    nextConfig.categories[categoryName] = nextConfig.categories[categoryName].filter(
      (currentEntry) => !channelEntriesMatch(currentEntry, channelEntry),
    );

    state.config = nextConfig;
    render();
    setStatus("Channel removed locally. Save changes when you're ready.");
  });

  return button;
}

/**
 * Inline add row + preview for one category.
 * @param {string} categoryName
 */
function buildInlineAddForm(categoryName) {
  const wrap = document.createElement("div");
  wrap.className = "inline-add-wrap";

  const form = document.createElement("form");
  form.className = "category-inline-add-form";
  form.dataset.category = categoryName;

  const row = document.createElement("div");
  row.className = "inline-add-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "inline-add-handle";
  input.name = "channelHandle";
  input.placeholder = "@youtubehandle";
  input.autocomplete = "off";
  input.setAttribute("aria-label", `Add channel to ${categoryName}`);
  input.disabled = state.isSaving;

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "inline-add-button";
  submitBtn.textContent = "+ Add";
  submitBtn.disabled = state.isSaving;

  const preview = document.createElement("div");
  preview.className = "inline-add-preview channel-preview";
  preview.setAttribute("aria-live", "polite");

  row.append(input, submitBtn);
  form.append(row, preview);
  wrap.append(form);

  input.addEventListener("input", () => {
    schedulePreviewForCategory(categoryName, input.value, preview);
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const existingTimer = previewTimersByCategory.get(categoryName);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      previewTimersByCategory.delete(categoryName);
    }
    clearChannelPreview(preview);

    const added = addChannelToConfig(categoryName, input.value, { skipRender: true });
    if (!added) {
      return;
    }

    input.value = "";
    state.focusInlineAddAfterRender = categoryName;
    render();
    setStatus("Channel added locally. Save changes to rebuild the cached guide.");
  });

  return wrap;
}

function renderCategories() {
  for (const timerId of previewTimersByCategory.values()) {
    clearTimeout(timerId);
  }
  previewTimersByCategory.clear();

  const entries = getCategoryEntries();

  if (entries.length === 0) {
    elements.categoriesContainer.innerHTML =
      '<div class="empty-state">No categories yet. Create a category above, then add YouTube handles in each category card below.</div>';
    return;
  }

  elements.categoriesContainer.replaceChildren(
    ...entries.map(([categoryName, channelEntries]) => {
      const card = document.createElement("article");
      card.className = "category-card";

      const guideCategory = state.guide.categories?.[categoryName];
      const cachedVideoCount = guideCategory?.videos?.length || 0;

      const header = document.createElement("div");
      header.className = "category-card-header";
      header.innerHTML = `
        <div>
          <h3>${categoryName}</h3>
          <p class="category-meta">${channelEntries.length} channel${channelEntries.length === 1 ? "" : "s"} · ${cachedVideoCount} cached video${cachedVideoCount === 1 ? "" : "s"}</p>
        </div>
      `;

      const headerActions = document.createElement("div");
      headerActions.className = "category-card-actions";
      headerActions.append(
        buildCategoryRefreshButton(categoryName),
        buildCategoryDeleteButton(categoryName),
      );
      header.append(headerActions);

      const list = document.createElement("div");
      list.className = "channel-list";

      if (channelEntries.length === 0) {
        const emptyNote = document.createElement("p");
        emptyNote.className = "category-empty-note";
        emptyNote.textContent = "No channels in this category yet.";
        list.append(emptyNote);
      } else {
        channelEntries.forEach((channelEntry) => {
          const pill = document.createElement("div");
          pill.className = "channel-pill";

          const content = document.createElement("div");
          content.className = "channel-pill-content";

          const code = document.createElement("code");
          code.textContent = getChannelPrimaryLabel(channelEntry);
          content.append(code);

          const secondaryLabel = getChannelSecondaryLabel(channelEntry);

          if (secondaryLabel) {
            const meta = document.createElement("span");
            meta.className = "channel-pill-meta";
            meta.textContent = secondaryLabel;
            content.append(meta);
          }

          pill.append(content, buildDeleteButton(categoryName, channelEntry));
          list.append(pill);
        });
      }

      const errors = guideCategory?.errors || [];

      if (errors.length > 0) {
        const errorNote = document.createElement("p");
        errorNote.className = "category-meta";
        errorNote.textContent = errors[0];
        list.append(errorNote);
      }

      list.append(buildInlineAddForm(categoryName));

      card.append(header, list);
      return card;
    }),
  );
}

function render() {
  renderStats();
  renderCategories();
  syncInlineAddControls();

  if (state.focusInlineAddAfterRender) {
    const cat = state.focusInlineAddAfterRender;
    state.focusInlineAddAfterRender = null;
    queueMicrotask(() => {
      const forms = document.querySelectorAll(".category-inline-add-form");
      const form = Array.from(forms).find((el) => el.dataset.category === cat);
      form?.querySelector(".inline-add-handle")?.focus();
    });
  }
}

/**
 * @param {string} categoryName
 * @param {string} channelValue
 * @param {{ skipRender?: boolean }} [options]
 * @returns {boolean} true if the channel was added
 */
function addChannelToConfig(categoryName, channelValue, options = {}) {
  const { skipRender = false } = options;
  const trimmedCategory = categoryName.trim();
  const trimmedValue = channelValue.trim();
  const nextChannelEntry = normalizeChannelInput(channelValue);

  if (!trimmedCategory) {
    setStatus("Could not determine category for this channel.", "error");
    return false;
  }

  if (!trimmedValue) {
    setStatus("Enter a YouTube handle starting with @.", "error");
    return false;
  }

  if (!trimmedValue.startsWith("@")) {
    setStatus("Handles must start with @ (e.g. @yourchannel).", "error");
    return false;
  }

  if (!nextChannelEntry) {
    setStatus("Enter a valid YouTube handle starting with @.", "error");
    return false;
  }

  const nextConfig = cloneConfig();
  const existingChannelEntries = nextConfig.categories[trimmedCategory] || [];

  if (existingChannelEntries.some((channelEntry) => channelEntriesMatch(channelEntry, nextChannelEntry))) {
    setStatus("That channel already exists in this category.", "error");
    return false;
  }

  nextConfig.categories[trimmedCategory] = [...existingChannelEntries, nextChannelEntry];
  state.config = nextConfig;

  if (!skipRender) {
    render();
    setStatus("Channel added locally. Save changes to rebuild the cached guide.");
  }

  return true;
}

const CSRF_EXPIRED_MESSAGE =
  "Your admin session token expired (for example after a server restart). Refresh the page, then try again.";

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function refreshCsrfToken() {
  const response = await fetch("/api/csrf-token");
  const payload = await parseResponseJson(response);

  if (!response.ok || !payload.csrfToken) {
    return false;
  }

  state.csrfToken = payload.csrfToken;
  return true;
}

async function saveConfig() {
  clearStatus();

  if (!state.csrfToken) {
    setStatus("Cannot save: CSRF token is missing. Try reloading the page.", "error");
    return;
  }

  setSaving(true);

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch("/api/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": state.csrfToken,
        },
        body: JSON.stringify(state.config),
      });

      const payload = await parseResponseJson(response);

      if (response.ok) {
        state.config = payload.config;
        state.guide = payload.guide;
        render();
        setStatus("Static Stream updated successfully. The local guide cache has been rebuilt.", "success");
        return;
      }

      if (response.status === 403 && attempt === 0) {
        if (await refreshCsrfToken()) {
          continue;
        }
        setStatus(
          `${CSRF_EXPIRED_MESSAGE}${payload.error ? ` ${payload.error}` : ""}`,
          "error",
        );
        return;
      }

      if (response.status === 403) {
        setStatus(
          `${CSRF_EXPIRED_MESSAGE}${payload.error ? ` ${payload.error}` : ""}`,
          "error",
        );
        return;
      }

      setStatus(payload.error || "Unable to save config.", "error");
      return;
    }
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setSaving(false);
  }
}

/**
 * Refreshes a single category's YouTube cache without touching any other
 * category or the saved config. Uses the dedicated
 * POST /api/guide/refresh/:category endpoint.
 */
function restoreCategoryRefreshButton(categoryName) {
  document.querySelectorAll(".category-refresh-button").forEach((btn) => {
    if (btn.dataset.category === categoryName) {
      btn.disabled = state.isSaving;
      btn.textContent = "↻ Refresh";
    }
  });
}

async function refreshCategory(categoryName) {
  if (!state.csrfToken) {
    setStatus("Cannot refresh: CSRF token is missing. Try reloading the page.", "error");
    return;
  }

  // Mark this category as refreshing and update button states.
  state.refreshingCategories.add(categoryName);
  clearStatus();

  // Update just the button for this category without a full re-render.
  document.querySelectorAll(".category-refresh-button").forEach((btn) => {
    if (btn.dataset.category === categoryName) {
      btn.disabled = true;
      btn.textContent = "↻ Refreshing…";
    }
  });

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(
        `/api/guide/refresh/${encodeURIComponent(categoryName)}`,
        {
          method: "POST",
          headers: { "X-CSRF-Token": state.csrfToken },
        },
      );

      const payload = await parseResponseJson(response);

      if (response.ok) {
        state.guide = payload.guide;
        render();
        setStatus(
          `"${categoryName}" refreshed successfully — ${payload.guide.categories[categoryName]?.videos?.length ?? 0} videos cached.`,
          "success",
        );
        return;
      }

      if (response.status === 403 && attempt === 0) {
        if (await refreshCsrfToken()) {
          continue;
        }
        setStatus(
          `${CSRF_EXPIRED_MESSAGE}${payload.error ? ` ${payload.error}` : ""}`,
          "error",
        );
        restoreCategoryRefreshButton(categoryName);
        return;
      }

      if (response.status === 403) {
        setStatus(
          `${CSRF_EXPIRED_MESSAGE}${payload.error ? ` ${payload.error}` : ""}`,
          "error",
        );
        restoreCategoryRefreshButton(categoryName);
        return;
      }

      setStatus(payload.error || `Failed to refresh "${categoryName}".`, "error");
      restoreCategoryRefreshButton(categoryName);
      return;
    }
  } catch (error) {
    setStatus(error.message, "error");
    restoreCategoryRefreshButton(categoryName);
  } finally {
    state.refreshingCategories.delete(categoryName);
  }
}

async function loadDashboard() {
  setSaving(true);
  clearStatus();

  try {
    const [configResponse, guideResponse, csrfResponse, statusResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/guide"),
      fetch("/api/csrf-token"),
      fetch("/api/status"),
    ]);

    const [configPayload, guidePayload, csrfPayload, statusPayload] = await Promise.all([
      configResponse.json(),
      guideResponse.json(),
      csrfResponse.json(),
      statusResponse.json(),
    ]);

    if (!configResponse.ok) {
      throw new Error(configPayload.error || "Unable to load configuration.");
    }

    if (!guideResponse.ok) {
      throw new Error(guidePayload.error || "Unable to load guide data.");
    }

    if (!csrfResponse.ok || !csrfPayload.csrfToken) {
      throw new Error("Unable to load security token. Reload the page to try again.");
    }

    if (statusResponse.ok) {
      state.nextScheduledRefreshAt = statusPayload.nextScheduledRefreshAt ?? null;
      state.refreshIntervalHours =
        typeof statusPayload.refreshIntervalHours === "number"
          ? statusPayload.refreshIntervalHours
          : null;
      startNextRefreshCountdown();
    } else {
      state.nextScheduledRefreshAt = null;
      state.refreshIntervalHours = null;
      clearNextRefreshCountdown();
    }

    state.config = configPayload;
    state.guide = guidePayload;
    state.csrfToken = csrfPayload.csrfToken;
    render();

    if (!Object.keys(state.config.categories).length) {
      setStatus("Create your first category to begin building the guide.", "success");
    }
  } catch (error) {
    setStatus(error.message, "error");
    state.nextScheduledRefreshAt = null;
    state.refreshIntervalHours = null;
    clearNextRefreshCountdown();
  } finally {
    setSaving(false);
  }
}

elements.categoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addCategoryToConfig(elements.newCategoryName.value);
});

// ── Channel preview (per-category inline) ───────────────────────────────────

/** @param {HTMLElement} container */
function clearChannelPreview(container) {
  container.replaceChildren();
}

/** @param {HTMLElement} container */
function showPreviewLoading(container) {
  const card = document.createElement("div");
  card.className = "channel-preview-card loading";

  const spinner = document.createElement("div");
  spinner.className = "channel-preview-spinner";

  const info = document.createElement("div");
  info.className = "channel-preview-info";

  const title = document.createElement("span");
  title.className = "channel-preview-title";
  title.textContent = "Looking up channel…";
  info.append(title);

  card.append(spinner, info);
  container.replaceChildren(card);
}

/** @param {HTMLElement} container */
function showPreviewResult(data, container) {
  const card = document.createElement("div");
  card.className = "channel-preview-card";

  if (data.thumbnail) {
    const img = document.createElement("img");
    img.src = data.thumbnail;
    img.alt = data.title;
    img.className = "channel-preview-avatar";
    img.width = 40;
    img.height = 40;
    card.append(img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "channel-preview-avatar-placeholder";
    placeholder.textContent = "📺";
    card.append(placeholder);
  }

  const info = document.createElement("div");
  info.className = "channel-preview-info";

  const title = document.createElement("span");
  title.className = "channel-preview-title";
  title.textContent = data.title;
  info.append(title);

  if (data.channelId) {
    const id = document.createElement("span");
    id.className = "channel-preview-id";
    id.textContent = data.channelId;
    info.append(id);
  }

  card.append(info);
  container.replaceChildren(card);
}

/** @param {HTMLElement} container */
function showPreviewError(message, container) {
  const card = document.createElement("div");
  card.className = "channel-preview-card error";

  const errorText = document.createElement("span");
  errorText.className = "channel-preview-error";
  errorText.textContent = message;
  card.append(errorText);

  container.replaceChildren(card);
}

/**
 * Debounced: preview API 600ms after typing stops, for one category's preview pane.
 * @param {string} categoryName
 * @param {string} rawValue
 * @param {HTMLElement} previewContainer
 */
function schedulePreviewForCategory(categoryName, rawValue, previewContainer) {
  const prev = previewTimersByCategory.get(categoryName);
  if (prev !== undefined) {
    clearTimeout(prev);
  }

  const handle = rawValue.trim();

  if (!handle) {
    clearChannelPreview(previewContainer);
    previewTimersByCategory.delete(categoryName);
    return;
  }

  if (!handle.startsWith("@") || handle.length < 2) {
    clearChannelPreview(previewContainer);
    previewTimersByCategory.delete(categoryName);
    return;
  }

  showPreviewLoading(previewContainer);

  const timerId = setTimeout(async () => {
    previewTimersByCategory.delete(categoryName);
    try {
      const response = await fetch(
        `/api/channel-preview?handle=${encodeURIComponent(handle)}`,
      );
      const payload = await response.json();

      if (!response.ok) {
        showPreviewError(payload.error || "Channel not found.", previewContainer);
        return;
      }

      showPreviewResult(payload, previewContainer);
    } catch {
      showPreviewError("Could not reach the server. Check your connection.", previewContainer);
    }
  }, 600);

  previewTimersByCategory.set(categoryName, timerId);
}

elements.saveButton.addEventListener("click", () => {
  saveConfig();
});

// ── Import / Export ──────────────────────────────────────────────────────────

/**
 * Opens the hidden file picker when the "Import config.json" button is clicked.
 */
elements.importButton.addEventListener("click", () => {
  elements.importInput.value = "";
  elements.importInput.click();
});

/**
 * Reads the selected JSON file, validates its top-level shape client-side,
 * then loads it into the in-memory state exactly as if the user had typed it
 * in manually.  The user still needs to press "Save Changes" to persist it —
 * giving them a chance to review or tweak before committing.
 */
elements.importInput.addEventListener("change", () => {
  const file = elements.importInput.files?.[0];

  if (!file) {
    return;
  }

  const reader = new FileReader();

  reader.addEventListener("load", (event) => {
    let parsed;

    try {
      parsed = JSON.parse(event.target.result);
    } catch {
      setStatus("Import failed: the selected file is not valid JSON.", "error");
      return;
    }

    // Minimal client-side shape check before touching state.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed.categories !== "object" ||
      parsed.categories === null ||
      Array.isArray(parsed.categories)
    ) {
      setStatus(
        'Import failed: the file must be a JSON object with a "categories" key.',
        "error",
      );
      return;
    }

    state.config = parsed;
    render();
    setStatus(
      `"${file.name}" loaded into the editor. Review the config below, then click Save Changes to apply it.`,
      "success",
    );
  });

  reader.addEventListener("error", () => {
    setStatus("Import failed: unable to read the selected file.", "error");
  });

  reader.readAsText(file);
});

loadDashboard();
