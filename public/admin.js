const state = {
  config: { categories: {} },
  guide: { categories: {} },
  csrfToken: null,
  isSaving: false,
  refreshingCategories: new Set(), // category names currently being refreshed
};

const elements = {
  categoryForm: document.querySelector("#category-form"),
  newCategoryName: document.querySelector("#new-category-name"),
  form: document.querySelector("#channel-form"),
  categoryName: document.querySelector("#category-name"),
  channelInput: document.querySelector("#channel-id"),
  channelPreview: document.querySelector("#channel-preview"),
  addCategoryButton: document.querySelector("#add-category-button"),
  addChannelButton: document.querySelector("#add-channel-button"),
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

function setSaving(isSaving) {
  state.isSaving = isSaving;
  elements.saveButton.disabled = isSaving;
  elements.addCategoryButton.disabled = isSaving;
  elements.addChannelButton.disabled = isSaving;
  elements.saveButton.textContent = isSaving ? "Refreshing YouTube Cache..." : "Save Changes";

  // Disable all per-category refresh buttons while a global save is running.
  document.querySelectorAll(".category-refresh-button").forEach((btn) => {
    btn.disabled = isSaving || state.refreshingCategories.has(btn.dataset.category);
  });

  syncChannelFormState();
}

function getCategoryEntries() {
  return Object.entries(state.config.categories).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
}

function getSelectedCategoryName() {
  return elements.categoryName.value;
}

function normalizeChannelInput(channelValue) {
  const trimmedChannel = channelValue.trim();

  if (!trimmedChannel) {
    return null;
  }

  return trimmedChannel.startsWith("@")
    ? { handle: trimmedChannel }
    : { channelId: trimmedChannel };
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

function setSelectedCategoryName(categoryName) {
  elements.categoryName.value = categoryName;
}

function syncChannelFormState() {
  const hasCategories = getCategoryEntries().length > 0;
  elements.categoryName.disabled = state.isSaving || !hasCategories;
  elements.channelInput.disabled = state.isSaving || !hasCategories;
  elements.addChannelButton.disabled = state.isSaving || !hasCategories;
}

function renderCategoryOptions() {
  const selectedCategoryName = getSelectedCategoryName();
  const entries = getCategoryEntries();

  elements.categoryName.replaceChildren();

  if (entries.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Create a category first";
    elements.categoryName.append(option);
    setSelectedCategoryName("");
    syncChannelFormState();
    return;
  }

  entries.forEach(([categoryName]) => {
    const option = document.createElement("option");
    option.value = categoryName;
    option.textContent = categoryName;
    elements.categoryName.append(option);
  });

  const categoryNames = entries.map(([categoryName]) => categoryName);
  const nextSelectedCategory = categoryNames.includes(selectedCategoryName)
    ? selectedCategoryName
    : categoryNames[0];

  setSelectedCategoryName(nextSelectedCategory);
  syncChannelFormState();
}

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
  render();
  setSelectedCategoryName(trimmedCategory);
  syncChannelFormState();
  setStatus("Category created locally. Save changes when you're ready.");
}

function deleteCategoryFromConfig(categoryName) {
  const nextConfig = cloneConfig();
  delete nextConfig.categories[categoryName];
  state.config = nextConfig;
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
  ];

  elements.statsStrip.replaceChildren(
    ...cards.map((card) => {
      const article = document.createElement("article");
      article.className = "stat-card";
      article.innerHTML = `<strong>${card.value}</strong><span>${card.label}</span>`;
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

function renderCategories() {
  const entries = getCategoryEntries();

  if (entries.length === 0) {
    elements.categoriesContainer.innerHTML =
      '<div class="empty-state">No categories yet. Add a category and channel above to start building your guide.</div>';
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

      card.append(header, list);
      return card;
    }),
  );
}

function render() {
  renderCategoryOptions();
  renderStats();
  renderCategories();
}

function addChannelToConfig(categoryName, channelValue) {
  const trimmedCategory = categoryName.trim();
  const nextChannelEntry = normalizeChannelInput(channelValue);

  if (!trimmedCategory || !nextChannelEntry) {
    setStatus("Enter both a category name and a YouTube handle.", "error");
    return;
  }

  const nextConfig = cloneConfig();
  const existingChannelEntries = nextConfig.categories[trimmedCategory] || [];

  if (existingChannelEntries.some((channelEntry) => channelEntriesMatch(channelEntry, nextChannelEntry))) {
    setStatus("That channel already exists in this category.", "error");
    return;
  }

  nextConfig.categories[trimmedCategory] = [...existingChannelEntries, nextChannelEntry];
  state.config = nextConfig;
  elements.form.reset();
  render();
  setSelectedCategoryName(trimmedCategory);
  setStatus("Channel added locally. Save changes to rebuild the cached guide.");
}

async function saveConfig() {
  clearStatus();

  if (!state.csrfToken) {
    setStatus("Cannot save: CSRF token is missing. Try reloading the page.", "error");
    return;
  }

  setSaving(true);

  try {
    const response = await fetch("/api/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": state.csrfToken,
      },
      body: JSON.stringify(state.config),
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Unable to save config.");
    }

    state.config = payload.config;
    state.guide = payload.guide;
    render();
    setStatus("Static Stream updated successfully. The local guide cache has been rebuilt.", "success");
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
    const response = await fetch(
      `/api/guide/refresh/${encodeURIComponent(categoryName)}`,
      {
        method: "POST",
        headers: { "X-CSRF-Token": state.csrfToken },
      },
    );

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || `Failed to refresh "${categoryName}".`);
    }

    state.guide = payload.guide;
    render();
    setStatus(`"${categoryName}" refreshed successfully — ${payload.guide.categories[categoryName]?.videos?.length ?? 0} videos cached.`, "success");
  } catch (error) {
    setStatus(error.message, "error");

    // Restore button on failure without a full re-render.
    document.querySelectorAll(".category-refresh-button").forEach((btn) => {
      if (btn.dataset.category === categoryName) {
        btn.disabled = state.isSaving;
        btn.textContent = "↻ Refresh";
      }
    });
  } finally {
    state.refreshingCategories.delete(categoryName);
  }
}

async function loadDashboard() {
  setSaving(true);
  clearStatus();

  try {
    const [configResponse, guideResponse, csrfResponse] = await Promise.all([
      fetch("/api/config"),
      fetch("/api/guide"),
      fetch("/api/csrf-token"),
    ]);

    const [configPayload, guidePayload, csrfPayload] = await Promise.all([
      configResponse.json(),
      guideResponse.json(),
      csrfResponse.json(),
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

    state.config = configPayload;
    state.guide = guidePayload;
    state.csrfToken = csrfPayload.csrfToken;
    render();

    if (!Object.keys(state.config.categories).length) {
      setStatus("Create your first category to begin building the guide.", "success");
    }
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setSaving(false);
  }
}

elements.categoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addCategoryToConfig(elements.newCategoryName.value);
});

// ── Channel preview ──────────────────────────────────────────────────────────

/** Clears the preview pane without animation. */
function clearChannelPreview() {
  elements.channelPreview.replaceChildren();
}

/** Renders a loading spinner while the API call is in flight. */
function showPreviewLoading() {
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
  elements.channelPreview.replaceChildren(card);
}

/** Renders the resolved channel card with avatar + name. */
function showPreviewResult(data) {
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
  elements.channelPreview.replaceChildren(card);
}

/** Renders an error chip below the input. */
function showPreviewError(message) {
  const card = document.createElement("div");
  card.className = "channel-preview-card error";

  const errorText = document.createElement("span");
  errorText.className = "channel-preview-error";
  errorText.textContent = message;
  card.append(errorText);

  elements.channelPreview.replaceChildren(card);
}

/**
 * Debounced handler: fires a preview API call 600 ms after the user stops
 * typing a string that looks like a YouTube handle.
 */
let previewTimer = null;

function schedulePreview(rawValue) {
  clearTimeout(previewTimer);
  const handle = rawValue.trim();

  if (!handle) {
    clearChannelPreview();
    return;
  }

  // Require the leading "@" before hitting the network.
  if (!handle.startsWith("@") || handle.length < 2) {
    clearChannelPreview();
    return;
  }

  showPreviewLoading();

  previewTimer = setTimeout(async () => {
    try {
      const response = await fetch(
        `/api/channel-preview?handle=${encodeURIComponent(handle)}`,
      );
      const payload = await response.json();

      if (!response.ok) {
        showPreviewError(payload.error || "Channel not found.");
        return;
      }

      showPreviewResult(payload);
    } catch {
      showPreviewError("Could not reach the server. Check your connection.");
    }
  }, 600);
}

elements.channelInput.addEventListener("input", (event) => {
  schedulePreview(event.target.value);
});

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(previewTimer);
  clearChannelPreview();
  addChannelToConfig(elements.categoryName.value, elements.channelInput.value);
});

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
