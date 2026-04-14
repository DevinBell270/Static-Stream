const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const dotenv = require("dotenv");
const express = require("express");
const helmet = require("helmet");
const basicAuth = require("express-basic-auth");
const striptags = require("striptags");
const rateLimit = require("express-rate-limit");
const pLimit = require("p-limit");

const ROOT_DIR = __dirname;
const ENV_PATH = path.join(ROOT_DIR, ".env");

// Always load `.env` from the project root so `npm start` works the same
// no matter which directory the process was launched from.
dotenv.config({ path: ENV_PATH });

function readRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    console.error(
      `FATAL ERROR: Missing ${name}. Copy .env.example to ${ENV_PATH} and set ${name} before starting Static Stream.`,
    );
    process.exit(1);
  }

  return value;
}

/** Caps concurrent YouTube channel fetches per category (quota / burst control). */
const CHANNEL_FETCH_CONCURRENCY = 3;
const channelFetchLimit = pLimit(CHANNEL_FETCH_CONCURRENCY);

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a reverse proxy, set TRUST_PROXY (e.g. 1) so req.ip is the real client — needed for fair per-IP limits.
if (process.env.TRUST_PROXY) {
  const hops = Number.parseInt(process.env.TRUST_PROXY, 10);
  app.set("trust proxy", Number.isNaN(hops) ? 1 : hops);
}

const ADMIN_USERNAME = readRequiredEnv("ADMIN_USERNAME");
const ADMIN_PASSWORD = readRequiredEnv("ADMIN_PASSWORD");
const YOUTUBE_API_KEY = readRequiredEnv("YOUTUBE_API_KEY");

const adminAuth = basicAuth({
  users: { [ADMIN_USERNAME]: ADMIN_PASSWORD },
  challenge: true,
  unauthorizedResponse: "Unauthorized",
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many login attempts from this IP, please try again after 15 minutes",
});

const PUBLIC_READ_RATE_LIMIT_WINDOW_MS = Math.max(
  1000,
  Number.parseInt(process.env.PUBLIC_READ_RATE_LIMIT_WINDOW_MS || "60000", 10) || 60_000,
);
const PUBLIC_READ_RATE_LIMIT_MAX = Math.max(
  1,
  Number.parseInt(process.env.PUBLIC_READ_RATE_LIMIT_MAX || "120", 10) || 120,
);

const publicReadLimiter = rateLimit({
  windowMs: PUBLIC_READ_RATE_LIMIT_WINDOW_MS,
  max: PUBLIC_READ_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (request, response, _next, options) => {
    response.status(options.statusCode).json({
      error: "Too many requests from this IP. Please try again later.",
    });
  },
});

// CSRF — one opaque token per server process lifetime.
// Rotates automatically on every restart.
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");

const REFRESH_INTERVAL_HOURS = Number.parseInt(process.env.REFRESH_INTERVAL_HOURS || "24", 10);
const REFRESH_INTERVAL_MS = Math.max(1, REFRESH_INTERVAL_HOURS) * 60 * 60 * 1000;
const RECENT_UPLOADS_PER_CHANNEL = 30;
const DAILY_ROTATION_RECENT_COUNT = 2;
const DAILY_ROTATION_RANDOM_COUNT = 3;
const MIN_VIDEO_DURATION_SECONDS = 3 * 60;
const MAX_VIDEO_DURATION_SECONDS = 3 * 60 * 60;

const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DATABASE_PATH = path.join(ROOT_DIR, "database.json");
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

const DEFAULT_CONFIG = {
  categories: {
    "Travel Vlogs": [{ channelId: "UC_EXAMPLE_PLACEHOLDER_1" }],
    "Tech Reviews": [{ channelId: "UC_EXAMPLE_PLACEHOLDER_2" }],
  },
};

const DEFAULT_DATABASE = {
  updatedAt: null,
  epochStart: null,
  refreshSource: null,
  categories: {},
};

let refreshPromise = null;

let cachedDatabase = null;
let databaseReadInFlight = null;

/**
 * Tracks the outcome of the most recent database refresh attempt.
 * Updated on every scheduled or manual refresh.
 */
const lastRefreshStatus = {
  succeededAt: null,
  failedAt: null,
  error: null,
  isStale: false,
};

function markLastRefreshSucceeded() {
  lastRefreshStatus.succeededAt = new Date().toISOString();
  lastRefreshStatus.failedAt = null;
  lastRefreshStatus.error = null;
  lastRefreshStatus.isStale = false;
}

/** Set when `schedulePeriodicRefresh()` runs; used to compute the next interval tick for `/api/status`. */
let periodicRefreshAnchorMs = null;

function getNextScheduledPeriodicRefreshIso() {
  if (periodicRefreshAnchorMs == null) {
    return null;
  }

  const now = Date.now();
  const k = Math.floor((now - periodicRefreshAnchorMs) / REFRESH_INTERVAL_MS) + 1;
  const nextMs = periodicRefreshAnchorMs + k * REFRESH_INTERVAL_MS;

  return new Date(nextMs).toISOString();
}

// ── Security headers ────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Allow the YouTube iframe API script and same-origin scripts.
        scriptSrc: ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
        // Permit YouTube iframes (both standard and privacy-enhanced).
        frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
        // All API fetches are same-origin; no extra connect origins needed.
        connectSrc: ["'self'"],
        // Allow inline / JS-set styles for the TV schedule layout and small UI tweaks.
        // Script remains locked down; this only relaxes style attribution.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Video thumbnails and channel avatars are served from different YouTube CDNs.
        imgSrc: [
          "'self'",
          "https://i.ytimg.com",
          "https://img.youtube.com",
          "https://yt3.ggpht.com",
          "https://yt3.googleusercontent.com",
          "data:",
        ],
        // No plugins, objects, or base-URI shenanigans.
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        // Upgrade HTTP sub-resources to HTTPS automatically.
        upgradeInsecureRequests: [],
      },
    },
    // Explicitly set a modern referrer policy.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

app.use(express.json({ limit: "1mb" }));

app.use("/admin.html", authLimiter, adminAuth);

app.use(express.static(PUBLIC_DIR));

app.get("/", (request, response) => {
  response.redirect("/tv.html");
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeHandle(value, categoryName) {
  const trimmedHandle = striptags(String(value || "")).trim();

  if (!trimmedHandle) {
    return null;
  }

  if (!trimmedHandle.startsWith("@") || trimmedHandle.length < 2) {
    throw createStatusError(
      `Category "${categoryName}" contains an invalid YouTube handle. Handles must start with "@".`,
      400,
    );
  }

  return trimmedHandle;
}

function normalizeChannelId(value) {
  const trimmedChannelId = striptags(String(value || "")).trim();
  return trimmedChannelId || null;
}

function normalizeChannelEntry(channelInput, categoryName) {
  if (typeof channelInput === "string") {
    const trimmedChannel = String(channelInput || "").trim();

    if (!trimmedChannel) {
      return null;
    }

    return trimmedChannel.startsWith("@")
      ? { handle: normalizeHandle(trimmedChannel, categoryName) }
      : { channelId: trimmedChannel };
  }

  if (!isPlainObject(channelInput)) {
    throw createStatusError(
      `Category "${categoryName}" must contain channel IDs or handle objects.`,
      400,
    );
  }

  const handle = normalizeHandle(channelInput.handle, categoryName);
  const channelId = normalizeChannelId(channelInput.channelId);

  if (!handle && !channelId) {
    throw createStatusError(
      `Category "${categoryName}" contains an entry that is missing both handle and channelId.`,
      400,
    );
  }

  return {
    ...(handle ? { handle } : {}),
    ...(channelId ? { channelId } : {}),
  };
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

function dedupeChannelEntries(channelEntries) {
  const dedupedEntries = [];
  const entryByKey = new Map();

  channelEntries.forEach((channelEntry) => {
    const entryKeys = getChannelEntryKeys(channelEntry);
    const existingEntry = entryKeys
      .map((entryKey) => entryByKey.get(entryKey))
      .find(Boolean);

    if (!existingEntry) {
      const nextEntry = { ...channelEntry };
      dedupedEntries.push(nextEntry);
      getChannelEntryKeys(nextEntry).forEach((entryKey) => {
        entryByKey.set(entryKey, nextEntry);
      });
      return;
    }

    if (!existingEntry.handle && channelEntry.handle) {
      existingEntry.handle = channelEntry.handle;
    }

    if (!existingEntry.channelId && channelEntry.channelId) {
      existingEntry.channelId = channelEntry.channelId;
    }

    getChannelEntryKeys(existingEntry).forEach((entryKey) => {
      entryByKey.set(entryKey, existingEntry);
    });
  });

  return dedupedEntries;
}

async function ensureFile(filePath, fallbackValue) {
  try {
    await fs.access(filePath);
  } catch (error) {
    await atomicWriteJson(filePath, fallbackValue);
  }
}

/**
 * Writes JSON to a temporary sibling file and then renames it into place.
 * fs.rename() is an atomic OS-level operation (single syscall) on POSIX
 * systems, so the target file is never left in a half-written state — even
 * if a scheduled refresh races against a manual "Save" in the admin panel.
 */
async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

/**
 * Persists database.json and updates the in-memory guide cache (single write choke point).
 */
async function writeDatabase(database) {
  await atomicWriteJson(DATABASE_PATH, database);
  cachedDatabase = database;
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await atomicWriteJson(filePath, fallbackValue);
      return fallbackValue;
    }

    throw error;
  }
}

async function ensureDataFiles() {
  await ensureFile(CONFIG_PATH, DEFAULT_CONFIG);
  try {
    await fs.access(DATABASE_PATH);
  } catch {
    await writeDatabase(DEFAULT_DATABASE);
  }
}

// Allowed keys on a channel entry object.
const CHANNEL_ENTRY_ALLOWED_KEYS = new Set(["handle", "channelId"]);

/**
 * Strictly validates the structural shape of a /api/config payload.
 *
 * Rules enforced:
 *  - Root must be a plain object.
 *  - Root may only contain the key "categories".
 *  - "categories" must be a plain object (not an array / null / primitive).
 *  - Each category name must be a non-empty string key.
 *  - Each category value must be an array.
 *  - Each element of that array must be either:
 *      • a non-empty string (bare handle / channel-id shorthand), or
 *      • a plain object whose keys are a non-empty subset of {"handle", "channelId"}.
 *
 * Throws a status-tagged Error (400) on the first violation found.
 */
function validateConfigSchema(input) {
  if (!isPlainObject(input)) {
    throw createStatusError("Request body must be a JSON object.", 400);
  }

  const rootKeys = Object.keys(input);
  const unexpectedRootKeys = rootKeys.filter((k) => k !== "categories");

  if (unexpectedRootKeys.length > 0) {
    throw createStatusError(
      `Unexpected field(s) at root level: ${unexpectedRootKeys.map((k) => `"${k}"`).join(", ")}. Only "categories" is allowed.`,
      400,
    );
  }

  if (!("categories" in input)) {
    throw createStatusError('Request body must contain a "categories" field.', 400);
  }

  if (!isPlainObject(input.categories)) {
    throw createStatusError('"categories" must be a plain object mapping category names to arrays of channels.', 400);
  }

  for (const [categoryName, channelEntries] of Object.entries(input.categories)) {
    if (typeof categoryName !== "string" || categoryName.trim() === "") {
      throw createStatusError("Category names must be non-empty strings.", 400);
    }

    if (!Array.isArray(channelEntries)) {
      throw createStatusError(
        `Category "${categoryName}" must map to an array of channel entries, got ${typeof channelEntries}.`,
        400,
      );
    }

    channelEntries.forEach((entry, index) => {
      // Shorthand string form — valid.
      if (typeof entry === "string") {
        if (entry.trim() === "") {
          throw createStatusError(
            `Category "${categoryName}" contains an empty string at index ${index}. Remove it or supply a valid handle / channel ID.`,
            400,
          );
        }
        return;
      }

      // Object form — validate shape.
      if (!isPlainObject(entry)) {
        throw createStatusError(
          `Category "${categoryName}" index ${index}: each channel entry must be a string or an object, got ${Array.isArray(entry) ? "array" : typeof entry}.`,
          400,
        );
      }

      const entryKeys = Object.keys(entry);

      if (entryKeys.length === 0) {
        throw createStatusError(
          `Category "${categoryName}" index ${index}: channel entry object must contain at least one of "handle" or "channelId".`,
          400,
        );
      }

      const illegalKeys = entryKeys.filter((k) => !CHANNEL_ENTRY_ALLOWED_KEYS.has(k));

      if (illegalKeys.length > 0) {
        throw createStatusError(
          `Category "${categoryName}" index ${index}: unexpected key(s) ${illegalKeys.map((k) => `"${k}"`).join(", ")} on channel entry. Only "handle" and "channelId" are allowed.`,
          400,
        );
      }

      if (entry.handle !== undefined && typeof entry.handle !== "string") {
        throw createStatusError(
          `Category "${categoryName}" index ${index}: "handle" must be a string.`,
          400,
        );
      }

      if (entry.channelId !== undefined && typeof entry.channelId !== "string") {
        throw createStatusError(
          `Category "${categoryName}" index ${index}: "channelId" must be a string.`,
          400,
        );
      }
    });
  }
}

function normalizeConfig(input) {
  if (!isPlainObject(input) || !isPlainObject(input.categories)) {
    throw createStatusError("Config payload must contain a categories object.", 400);
  }

  const categories = {};

  for (const [categoryName, channelEntries] of Object.entries(input.categories)) {
    const trimmedName = striptags(String(categoryName || "")).trim();

    if (!trimmedName) {
      continue;
    }

    if (!Array.isArray(channelEntries)) {
      throw createStatusError(
        `Category "${trimmedName}" must contain an array of channel entries.`,
        400,
      );
    }

    const uniqueChannelEntries = dedupeChannelEntries(
      channelEntries
        .map((channelEntry) => normalizeChannelEntry(channelEntry, trimmedName))
        .filter(Boolean),
    );

    categories[trimmedName] = uniqueChannelEntries;
  }

  return { categories };
}

async function readConfig() {
  const config = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
  return normalizeConfig(config);
}

async function readDatabaseFromDisk() {
  try {
    const raw = await fs.readFile(DATABASE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeDatabase(DEFAULT_DATABASE);
      return DEFAULT_DATABASE;
    }

    throw error;
  }
}

async function readDatabase() {
  if (cachedDatabase !== null) {
    return cachedDatabase;
  }

  if (databaseReadInFlight) {
    return databaseReadInFlight;
  }

  databaseReadInFlight = (async () => {
    const parsed = await readDatabaseFromDisk();
    cachedDatabase = parsed;
    return parsed;
  })().finally(() => {
    databaseReadInFlight = null;
  });

  return databaseReadInFlight;
}

function getWeekEpoch(date = new Date()) {
  const epoch = new Date(date);
  epoch.setHours(0, 0, 0, 0);
  epoch.setDate(epoch.getDate() - epoch.getDay());
  return epoch;
}

function parseIso8601Duration(isoDuration) {
  if (!isoDuration) {
    return 0;
  }

  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(isoDuration);

  if (!match) {
    return 0;
  }

  const days = Number.parseInt(match[1] || "0", 10);
  const hours = Number.parseInt(match[2] || "0", 10);
  const minutes = Number.parseInt(match[3] || "0", 10);
  const seconds = Number.parseInt(match[4] || "0", 10);

  return (((days * 24) + hours) * 60 * 60) + (minutes * 60) + seconds;
}

function selectThumbnail(thumbnails = {}) {
  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

function sortVideosByPublishedAt(videos) {
  return [...videos].sort((left, right) => {
    const leftTime = new Date(left.publishedAt || 0).getTime();
    const rightTime = new Date(right.publishedAt || 0).getTime();
    return rightTime - leftTime;
  });
}

function shuffleArray(items) {
  const shuffledItems = [...items];

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffledItems[index], shuffledItems[swapIndex]] = [
      shuffledItems[swapIndex],
      shuffledItems[index],
    ];
  }

  return shuffledItems;
}

function selectDailyRotation(channelVideos) {
  const sortedVideos = sortVideosByPublishedAt(channelVideos);
  const newestVideos = sortedVideos.slice(0, DAILY_ROTATION_RECENT_COUNT);
  const rerunPool = sortedVideos.slice(DAILY_ROTATION_RECENT_COUNT);
  const rerunVideos = shuffleArray(rerunPool).slice(0, DAILY_ROTATION_RANDOM_COUNT);
  return [...newestVideos, ...rerunVideos];
}

async function fetchYouTubeJson(endpoint, searchParams) {
  const url = new URL(`${YOUTUBE_API_BASE}/${endpoint}`);

  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  let response;

  try {
    response = await fetch(url);
  } catch (error) {
    const causeMessage = error.cause?.message ? ` Cause: ${error.cause.message}` : "";
    throw new Error(`YouTube API fetch failed for ${endpoint}: ${error.message}.${causeMessage}`);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || `YouTube API request failed with ${response.status}.`;
    const status =
      response.status >= 400 && response.status < 600 ? response.status : 502;
    throw createStatusError(message, status);
  }

  return payload;
}

async function resolveChannelIdFromHandle(handle, apiKey) {
  const payload = await fetchYouTubeJson("channels", {
    part: "id",
    forHandle: handle.replace(/^@/, ""),
    key: apiKey,
  });

  const channelId = payload.items?.[0]?.id;

  if (!channelId) {
    throw createStatusError(`No YouTube channel was found for handle "${handle}".`, 400);
  }

  return channelId;
}

async function resolveConfigChannels(config) {
  const categoryEntries = await Promise.all(
    Object.entries(config.categories).map(async ([categoryName, channelEntries]) => {
      const resolvedEntries = await Promise.all(
        channelEntries.map(async (channelEntry) => {
          if (channelEntry.channelId || !channelEntry.handle) {
            return channelEntry;
          }

          try {
            const channelId = await resolveChannelIdFromHandle(channelEntry.handle, YOUTUBE_API_KEY);
            return {
              ...channelEntry,
              channelId,
            };
          } catch (error) {
            // A dead or renamed handle must not abort the entire save. Log it and
            // keep the entry as-is (without a resolved channelId) so the user can
            // clean it up later without losing the rest of the config.
            console.warn(
              `[config] Could not resolve handle "${channelEntry.handle}" — skipping channel ID resolution. Error: ${error.message}`,
            );
            return { ...channelEntry };
          }
        }),
      );
      return [categoryName, resolvedEntries];
    }),
  );

  return normalizeConfig({ categories: Object.fromEntries(categoryEntries) });
}

async function getUploadsPlaylistId(channelId, apiKey) {
  const payload = await fetchYouTubeJson("channels", {
    part: "contentDetails",
    id: channelId,
    key: apiKey,
  });

  const uploadsId = payload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploadsId) {
    throw new Error(`No uploads playlist found for channel "${channelId}".`);
  }

  return uploadsId;
}

async function getRecentUploadIds(
  uploadsPlaylistId,
  apiKey,
  limit = RECENT_UPLOADS_PER_CHANNEL,
) {
  const payload = await fetchYouTubeJson("playlistItems", {
    part: "contentDetails,snippet",
    playlistId: uploadsPlaylistId,
    maxResults: String(Math.max(1, Math.min(50, limit))),
    key: apiKey,
  });

  return (payload.items || [])
    .map((item) => item.contentDetails?.videoId)
    .filter(Boolean)
    .slice(0, limit);
}

async function getVideoDetails(videoIds, apiKey) {
  if (videoIds.length === 0) {
    return [];
  }

  const payload = await fetchYouTubeJson("videos", {
    part: "contentDetails,snippet",
    id: videoIds.join(","),
    maxResults: String(videoIds.length),
    key: apiKey,
  });

  return (payload.items || [])
    .map((item) => {
      const durationSeconds = parseIso8601Duration(item.contentDetails?.duration);

      if (!durationSeconds || durationSeconds <= MIN_VIDEO_DURATION_SECONDS || durationSeconds >= MAX_VIDEO_DURATION_SECONDS) {
        return null;
      }

      return {
        videoId: item.id,
        title: item.snippet?.title || "Untitled Video",
        thumbnail: selectThumbnail(item.snippet?.thumbnails),
        durationSeconds,
        publishedAt: item.snippet?.publishedAt || null,
        channelId: item.snippet?.channelId || null,
        channelTitle: item.snippet?.channelTitle || null,
      };
    })
    .filter(Boolean);
}

async function fetchChannelVideos(
  channelId,
  apiKey,
  limit = RECENT_UPLOADS_PER_CHANNEL,
) {
  const uploadsPlaylistId = await getUploadsPlaylistId(channelId, apiKey);
  const videoIds = await getRecentUploadIds(uploadsPlaylistId, apiKey, limit);
  return getVideoDetails(videoIds, apiKey);
}

/**
 * Fetches fresh YouTube data for a single category's channel list and returns
 * the built category object (videos, channelIds, totalDurationSeconds, errors).
 * Shared by buildDatabase (full rebuild) and the per-category refresh route.
 */
async function buildCategoryData(categoryName, channelEntries, apiKey) {
  if (!apiKey) {
    return {
      channelIds: channelEntries.map((e) => e.channelId).filter(Boolean),
      totalDurationSeconds: 0,
      videos: [],
      errors: ["Missing YOUTUBE_API_KEY in .env."],
    };
  }

  const collectedVideos = [];
  const seenVideoIds = new Set();
  const categoryErrors = [];

  const results = await Promise.all(
    channelEntries.map((channelEntry, index) =>
      channelFetchLimit(async () => {
        if (!channelEntry.channelId) {
          return {
            index,
            kind: "missingId",
            channelEntry,
          };
        }

        try {
          const channelVideos = await fetchChannelVideos(
            channelEntry.channelId,
            apiKey,
            RECENT_UPLOADS_PER_CHANNEL,
          );
          return { index, kind: "ok", channelVideos };
        } catch (error) {
          return {
            index,
            kind: "error",
            message: `Channel ${channelEntry.handle || channelEntry.channelId}: ${error.message}`,
          };
        }
      }),
    ),
  );

  results.sort((a, b) => a.index - b.index);

  for (const result of results) {
    if (result.kind === "missingId") {
      categoryErrors.push(
        `Channel ${result.channelEntry.handle || "unknown"} is missing a saved channel ID. Save the config again to resolve it.`,
      );
      continue;
    }

    if (result.kind === "error") {
      categoryErrors.push(result.message);
      continue;
    }

    const dailyRotation = selectDailyRotation(result.channelVideos);

    dailyRotation.forEach((video) => {
      if (seenVideoIds.has(video.videoId)) {
        return;
      }
      seenVideoIds.add(video.videoId);
      collectedVideos.push(video);
    });
  }

  const shuffledVideos = shuffleArray(collectedVideos);

  return {
    channelIds: channelEntries.map((e) => e.channelId).filter(Boolean),
    totalDurationSeconds: shuffledVideos.reduce((total, video) => total + video.durationSeconds, 0),
    videos: shuffledVideos,
    errors: categoryErrors,
  };
}

async function buildDatabase(refreshSource = "manual") {
  const config = await readConfig();
  const epoch = getWeekEpoch();

  const categoryResults = await Promise.all(
    Object.entries(config.categories).map(([categoryName, channelEntries]) =>
      buildCategoryData(categoryName, channelEntries, YOUTUBE_API_KEY).then((data) => [categoryName, data]),
    ),
  );
  const categories = Object.fromEntries(categoryResults);

  return {
    updatedAt: new Date().toISOString(),
    epochStart: epoch.toISOString(),
    refreshSource,
    categories,
  };
}

async function refreshDatabase(refreshSource) {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const database = await buildDatabase(refreshSource);
      await writeDatabase(database);

      markLastRefreshSucceeded();

      return database;
    } catch (error) {
      const failedAt = new Date().toISOString();

      lastRefreshStatus.failedAt = failedAt;
      lastRefreshStatus.error = error.message;
      lastRefreshStatus.isStale = true;

      console.error(
        `[${failedAt}] Static Stream refresh failed (source: ${refreshSource}). Continuing to serve existing database. Error: ${error.message}`,
      );

      // Return the existing stale database so callers still get valid data.
      // We deliberately do NOT overwrite database.json on failure.
      return readDatabase();
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

function schedulePeriodicRefresh() {
  periodicRefreshAnchorMs = Date.now();
  setInterval(() => {
    refreshDatabase("scheduled_interval").catch((error) => {
      console.error("Failed scheduled Static Stream refresh:", error.message);
    });
  }, REFRESH_INTERVAL_MS);
}

function resolveLiveSlot(videos, liveOffsetSeconds) {
  let runningDuration = 0;

  for (let index = 0; index < videos.length; index += 1) {
    const video = videos[index];
    const nextDuration = runningDuration + video.durationSeconds;

    if (liveOffsetSeconds < nextDuration) {
      return {
        currentIndex: index,
        video,
        startSeconds: liveOffsetSeconds - runningDuration,
      };
    }

    runningDuration = nextDuration;
  }

  return {
    currentIndex: 0,
    video: videos[0],
    startSeconds: 0,
  };
}

// Expose the CSRF token only to authenticated admin sessions.
app.get("/api/csrf-token", authLimiter, adminAuth, (request, response) => {
  response.json({ csrfToken: CSRF_TOKEN });
});

/**
 * GET /api/channel-preview?handle=@foo
 *
 * Resolves a YouTube handle to its channel title and thumbnail using a single
 * lightweight Channels API call (part=snippet only). Used by the admin UI to
 * give the user instant visual confirmation before they save a new channel.
 *
 * Protected by adminAuth + authLimiter so the API key is never exposed
 * to unauthenticated callers.
 */
app.get("/api/channel-preview", authLimiter, adminAuth, async (request, response) => {
  const rawHandle = String(request.query.handle || "").trim();

  if (!rawHandle.startsWith("@") || rawHandle.length < 2) {
    response.status(400).json({ error: "A valid YouTube handle starting with \"@\" is required." });
    return;
  }

  try {
    const payload = await fetchYouTubeJson("channels", {
      part: "snippet",
      forHandle: rawHandle.replace(/^@/, ""),
      key: YOUTUBE_API_KEY,
    });

    const item = payload.items?.[0];

    if (!item) {
      response.status(404).json({ error: `No YouTube channel found for handle "${rawHandle}".` });
      return;
    }

    response.json({
      channelId: item.id,
      title: item.snippet?.title || rawHandle,
      thumbnail:
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url ||
        null,
    });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    response.status(statusCode).json({ error: error.message });
  }
});

// Export config.json as a downloadable file — protected by admin auth.
app.get("/api/config/export", authLimiter, adminAuth, async (request, response) => {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Content-Disposition", 'attachment; filename="config.json"');
    response.send(raw);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/config", authLimiter, adminAuth, async (request, response) => {
  try {
    const config = await readConfig();
    response.json(config);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.post("/api/config", authLimiter, adminAuth, async (request, response) => {
  // Validate CSRF token — must match the value issued by GET /api/csrf-token.
  const incomingToken = request.headers["x-csrf-token"];

  if (!incomingToken || !crypto.timingSafeEqual(Buffer.from(incomingToken), Buffer.from(CSRF_TOKEN))) {
    response.status(403).json({ error: "Invalid or missing CSRF token." });
    return;
  }

  try {
    validateConfigSchema(request.body);
    const nextConfig = await resolveConfigChannels(normalizeConfig(request.body));
    await atomicWriteJson(CONFIG_PATH, nextConfig);
    const database = await refreshDatabase("config_update");

    response.json({
      success: true,
      config: nextConfig,
      guide: database,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    response.status(statusCode).json({ error: error.message });
  }
});

app.get("/api/guide", publicReadLimiter, async (request, response) => {
  try {
    const database = await readDatabase();
    response.setHeader("Cache-Control", "no-store");
    response.json(database);
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/guide/refresh/:category
 *
 * Refreshes a single category in database.json without touching any other
 * category. Requires admin auth and a valid CSRF token so random callers
 * cannot burn YouTube API quota.
 *
 * Body: (empty)
 * Response: { category: string, guide: <updated database> }
 */
app.post("/api/guide/refresh/:category", authLimiter, adminAuth, async (request, response) => {
  // Validate CSRF token.
  const incomingToken = request.headers["x-csrf-token"];

  if (!incomingToken || !crypto.timingSafeEqual(Buffer.from(incomingToken), Buffer.from(CSRF_TOKEN))) {
    response.status(403).json({ error: "Invalid or missing CSRF token." });
    return;
  }

  const categoryName = request.params.category;

  try {
    const [config, database] = await Promise.all([readConfig(), readDatabase()]);

    if (!Object.hasOwn(config.categories, categoryName)) {
      response
        .status(404)
        .json({ error: `Category "${categoryName}" was not found in the current config.` });
      return;
    }

    const channelEntries = config.categories[categoryName];
    const freshCategoryData = await buildCategoryData(categoryName, channelEntries, YOUTUBE_API_KEY);

    const updatedDatabase = {
      ...database,
      updatedAt: new Date().toISOString(),
      categories: {
        ...database.categories,
        [categoryName]: freshCategoryData,
      },
    };

    await writeDatabase(updatedDatabase);

    markLastRefreshSucceeded();

    response.json({ category: categoryName, guide: updatedDatabase });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    response.status(statusCode).json({ error: error.message });
  }
});

app.get("/api/status", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({
    isStale: lastRefreshStatus.isStale,
    succeededAt: lastRefreshStatus.succeededAt,
    failedAt: lastRefreshStatus.failedAt,
    error: lastRefreshStatus.error ? "Refresh failed. Check server logs." : null,
    nextScheduledRefreshAt: getNextScheduledPeriodicRefreshIso(),
    refreshIntervalHours: REFRESH_INTERVAL_HOURS,
  });
});

app.get("/api/tune-in/:category", publicReadLimiter, async (request, response) => {
  try {
    const database = await readDatabase();
    const categoryName = request.params.category;
    const category = database.categories?.[categoryName];

    if (!category) {
      response.status(404).json({ error: `Category "${categoryName}" was not found.` });
      return;
    }

    if (!Array.isArray(category.videos) || category.videos.length === 0 || !category.totalDurationSeconds) {
      response.status(404).json({
        error: `Category "${categoryName}" does not have any playable videos yet.`,
      });
      return;
    }

    const epoch = getWeekEpoch();
    const elapsedSeconds = Math.floor((Date.now() - epoch.getTime()) / 1000);
    const liveOffsetSeconds = ((elapsedSeconds % category.totalDurationSeconds) + category.totalDurationSeconds)
      % category.totalDurationSeconds;
    const liveSlot = resolveLiveSlot(category.videos, liveOffsetSeconds);
    const nextIndex = (liveSlot.currentIndex + 1) % category.videos.length;
    const nextVideoEntry = category.videos[nextIndex];

    response.setHeader("Cache-Control", "no-store");
    response.json({
      category: categoryName,
      playlistDurationSeconds: category.totalDurationSeconds,
      liveOffsetSeconds,
      epochStart: epoch.toISOString(),
      currentIndex: liveSlot.currentIndex,
      videoId: liveSlot.video.videoId,
      title: liveSlot.video.title,
      thumbnail: liveSlot.video.thumbnail,
      durationSeconds: liveSlot.video.durationSeconds,
      startSeconds: liveSlot.startSeconds,
      nextVideo: {
        videoId: nextVideoEntry.videoId,
        title: nextVideoEntry.title,
        durationSeconds: nextVideoEntry.durationSeconds,
      },
    });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

async function start() {
  await ensureDataFiles();
  schedulePeriodicRefresh();

  try {
    await refreshDatabase("startup");
  } catch (error) {
    console.error("Failed to refresh Static Stream database:", error.message);
  }

  app.listen(PORT, () => {
    console.log(`Static Stream is running at http://localhost:${PORT}`);
  });
}

start().catch((error) => {
  console.error("Unable to start Static Stream:", error);
  process.exit(1);
});
