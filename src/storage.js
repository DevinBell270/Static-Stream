/**
 * Data storage, atomic file persistence, and in-memory caching for Static Stream.
 */

const fs = require("fs/promises");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
const DATABASE_PATH = path.join(ROOT_DIR, "database.json");

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

let cachedConfig = null;
let configReadInFlight = null;

let cachedDatabase = null;
let databaseReadInFlight = null;

async function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function ensureFile(filePath, fallbackValue) {
  try {
    await fs.access(filePath);
  } catch {
    await atomicWriteJson(filePath, fallbackValue);
  }
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

async function writeConfig(config) {
  await atomicWriteJson(CONFIG_PATH, config);
  cachedConfig = config;
}

async function readConfig(normalizeConfigFn) {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  if (configReadInFlight) {
    return configReadInFlight;
  }

  configReadInFlight = (async () => {
    const rawConfig = await readJson(CONFIG_PATH, DEFAULT_CONFIG);
    const normalized = normalizeConfigFn ? normalizeConfigFn(rawConfig) : rawConfig;
    cachedConfig = normalized;
    return normalized;
  })().finally(() => {
    configReadInFlight = null;
  });

  return configReadInFlight;
}

async function writeDatabase(database) {
  await atomicWriteJson(DATABASE_PATH, database);
  cachedDatabase = database;
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

async function ensureDataFiles() {
  await ensureFile(CONFIG_PATH, DEFAULT_CONFIG);
  try {
    await fs.access(DATABASE_PATH);
  } catch {
    await writeDatabase(DEFAULT_DATABASE);
  }
}

module.exports = {
  ROOT_DIR,
  CONFIG_PATH,
  DATABASE_PATH,
  DEFAULT_CONFIG,
  DEFAULT_DATABASE,
  atomicWriteJson,
  ensureFile,
  readJson,
  writeConfig,
  readConfig,
  writeDatabase,
  readDatabase,
  ensureDataFiles,
};
