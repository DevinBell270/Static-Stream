const state = {
  config: { categories: {} },
  guide: { categories: {} },
  csrfToken: null,
  isSaving: false,
  refreshingCategories: new Set(), // category names currently being refreshed
  collapsedCategories: new Set(),
  filterQuery: "",
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
  toggleAllCategoriesButton: document.querySelector("#toggle-all-categories-button"),
  globalFilterInput: document.querySelector("#global-channel-filter"),
  clearGlobalFilterButton: document.querySelector("#clear-global-filter-button"),
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

function normalizeFilterQuery(value) {
  return String(value || "").trim().toLowerCase();
}

function hasActiveFilterQuery() {
  return normalizeFilterQuery(state.filterQuery).length > 0;
}

function syncGuideFilterControls() {
  if (elements.globalFilterInput && elements.globalFilterInput.value !== state.filterQuery) {
    elements.globalFilterInput.value = state.filterQuery;
  }

  if (elements.clearGlobalFilterButton) {
    elements.clearGlobalFilterButton.hidden = normalizeFilterQuery(state.filterQuery).length === 0;
  }
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

function isCategoryCollapsed(categoryName) {
  return state.collapsedCategories.has(categoryName);
}

function setCategoryCollapsed(categoryName, collapsed) {
  if (collapsed) {
    state.collapsedCategories.add(categoryName);
  } else {
    state.collapsedCategories.delete(categoryName);
  }
}

function areAllCategoriesCollapsed() {
  const entries = getCategoryEntries();
  return entries.length > 0 && entries.every(([categoryName]) => isCategoryCollapsed(categoryName));
}

function pruneCollapsedCategories() {
  const currentCategories = new Set(getCategoryEntries().map(([categoryName]) => categoryName));

  for (const categoryName of state.collapsedCategories) {
    if (!currentCategories.has(categoryName)) {
      state.collapsedCategories.delete(categoryName);
    }
  }
}

function syncToggleAllCategoriesButton() {
  const entries = getCategoryEntries();
  const hasCategories = entries.length > 0;
  const filterLocked = hasActiveFilterQuery();
  elements.toggleAllCategoriesButton.disabled = !hasCategories || filterLocked;
  elements.toggleAllCategoriesButton.textContent =
    filterLocked || !hasCategories
      ? "Collapse All"
      : areAllCategoriesCollapsed()
        ? "Expand All"
        : "Collapse All";
  elements.toggleAllCategoriesButton.title = filterLocked
    ? "Clear the global filter to collapse or expand categories."
    : "";
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

function getGuideChannelTitleLookup() {
  const titlesByCategory = new Map();

  Object.entries(state.guide.categories || {}).forEach(([categoryName, guideCategory]) => {
    const titlesByChannelId = new Map();

    (guideCategory?.videos || []).forEach((video) => {
      const channelId = String(video.channelId || "").trim();
      const channelTitle = String(video.channelTitle || "").trim();

      if (channelId && channelTitle && !titlesByChannelId.has(channelId)) {
        titlesByChannelId.set(channelId, channelTitle);
      }
    });

    titlesByCategory.set(categoryName, titlesByChannelId);
  });

  return titlesByCategory;
}

function getChannelDerivedTitle(categoryName, channelEntry, guideChannelTitleLookup) {
  const channelId = String(channelEntry.channelId || "").trim();

  if (!channelId) {
    return "";
  }

  return guideChannelTitleLookup.get(categoryName)?.get(channelId) || "";
}

function channelEntryMatchesFilter(categoryName, channelEntry, normalizedQuery, guideChannelTitleLookup) {
  const derivedTitle = getChannelDerivedTitle(categoryName, channelEntry, guideChannelTitleLookup);
  return [derivedTitle, channelEntry.handle, channelEntry.channelId].some((value) =>
    normalizeFilterQuery(value).includes(normalizedQuery),
  );
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
  state.collapsedCategories.delete(trimmedCategory);
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
  state.collapsedCategories.delete(categoryName);
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
  const normalizedFilterQuery = normalizeFilterQuery(state.filterQuery);

  if (entries.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent =
      "No categories yet. Create a category above, then add YouTube handles in each category card below.";
    elements.categoriesContainer.replaceChildren(emptyState);
    return;
  }

  const guideChannelTitleLookup = getGuideChannelTitleLookup();
  const filteredEntries =
    normalizedFilterQuery.length === 0
      ? entries.map(([categoryName, channelEntries]) => ({
          categoryName,
          channelEntries,
          visibleChannelEntries: channelEntries,
        }))
      : entries.flatMap(([categoryName, channelEntries]) => {
          const visibleChannelEntries = channelEntries.filter((channelEntry) =>
            channelEntryMatchesFilter(
              categoryName,
              channelEntry,
              normalizedFilterQuery,
              guideChannelTitleLookup,
            ),
          );
          const categoryMatches = normalizeFilterQuery(categoryName).includes(normalizedFilterQuery);

          if (!categoryMatches && visibleChannelEntries.length === 0) {
            return [];
          }

          return [
            {
              categoryName,
              channelEntries,
              visibleChannelEntries,
            },
          ];
        });

  if (filteredEntries.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    emptyState.textContent = `No categories or channels match "${state.filterQuery.trim()}".`;
    elements.categoriesContainer.replaceChildren(emptyState);
    return;
  }

  elements.categoriesContainer.replaceChildren(
    ...filteredEntries.map(({ categoryName, channelEntries, visibleChannelEntries }) => {
      const card = document.createElement("article");
      card.className = "category-card";
      const collapsed = normalizedFilterQuery.length > 0 ? false : isCategoryCollapsed(categoryName);
      card.classList.toggle("collapsed", collapsed);

      const guideCategory = state.guide.categories?.[categoryName];
      const cachedVideoCount = guideCategory?.videos?.length || 0;

      const header = document.createElement("div");
      header.className = "category-card-header";
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "category-card-toggle";
      toggleButton.setAttribute("aria-expanded", String(!collapsed));
      if (normalizedFilterQuery.length > 0) {
        toggleButton.setAttribute("aria-disabled", "true");
        toggleButton.title = "Clear the global filter to collapse this category.";
      }

      const toggleButtonLabel = document.createElement("div");
      toggleButtonLabel.className = "category-card-heading";

      const title = document.createElement("h3");
      title.textContent = categoryName;

      const meta = document.createElement("p");
      meta.className = "category-meta";
      meta.textContent =
        normalizedFilterQuery.length > 0
          ? `${visibleChannelEntries.length} matching channel${visibleChannelEntries.length === 1 ? "" : "s"} of ${channelEntries.length} · ${cachedVideoCount} cached video${cachedVideoCount === 1 ? "" : "s"}`
          : `${channelEntries.length} channel${channelEntries.length === 1 ? "" : "s"} · ${cachedVideoCount} cached video${cachedVideoCount === 1 ? "" : "s"}`;

      const toggleIcon = document.createElement("span");
      toggleIcon.className = "category-card-toggle-icon";
      toggleIcon.textContent = "▾";
      toggleIcon.setAttribute("aria-hidden", "true");

      toggleButtonLabel.append(title, meta);
      toggleButton.append(toggleButtonLabel, toggleIcon);
      toggleButton.addEventListener("click", () => {
        if (normalizedFilterQuery.length > 0) {
          return;
        }

        setCategoryCollapsed(categoryName, !isCategoryCollapsed(categoryName));
        render();
      });
      header.append(toggleButton);

      const headerActions = document.createElement("div");
      headerActions.className = "category-card-actions";
      headerActions.append(
        buildCategoryRefreshButton(categoryName),
        buildCategoryDeleteButton(categoryName),
      );
      header.append(headerActions);

      const list = document.createElement("div");
      list.className = "channel-list";
      list.hidden = collapsed;

      if (visibleChannelEntries.length === 0) {
        const emptyNote = document.createElement("p");
        emptyNote.className = "category-empty-note";
        emptyNote.textContent =
          normalizedFilterQuery.length > 0
            ? "No channels in this category match the current filter."
            : "No channels in this category yet.";
        list.append(emptyNote);
      } else {
        visibleChannelEntries.forEach((channelEntry) => {
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
  pruneCollapsedCategories();
  syncGuideFilterControls();
  renderStats();
  renderCategories();
  syncToggleAllCategoriesButton();
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

elements.globalFilterInput.addEventListener("input", (event) => {
  state.filterQuery = event.target.value;
  render();
});

elements.clearGlobalFilterButton.addEventListener("click", () => {
  state.filterQuery = "";
  render();
  elements.globalFilterInput.focus();
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

elements.toggleAllCategoriesButton.addEventListener("click", () => {
  const collapseAll = !areAllCategoriesCollapsed();

  getCategoryEntries().forEach(([categoryName]) => {
    setCategoryCollapsed(categoryName, collapseAll);
  });

  render();
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
