import { setPublicSettings, setServerSettingsCache } from '../lib/settingsCache';
import { getDatabase } from '../lib/mongoCollection';
import { DatabaseMetadataRepo } from "./repos";
import { getSqlClient } from '../lib/sql/sqlClient';

let databaseIdPreloaded = false;
let preloadedDatabaseId: string|null = null;
export const getPreloadedDatabaseId = () => {
  return {
    preloaded: databaseIdPreloaded,
    databaseId: preloadedDatabaseId
  };
}

type DatabaseSettings = {
  serverSettingsObject: DbDatabaseMetadata | null,
  publicSettingsObject: DbDatabaseMetadata | null,
  loadedDatabaseId: DbDatabaseMetadata | null,
}

const loadDatabaseSettingsPostgres = async (): Promise<DatabaseSettings> => {
  // eslint-disable-next-line no-console
  console.log("Loading settings from Postgres...");

  const repo = new DatabaseMetadataRepo();

  const [
    serverSettingsObject,
    publicSettingsObject,
    loadedDatabaseId,
  ] = await Promise.all([
    repo.getServerSettings(),
    repo.getPublicSettings(),
    repo.getDatabaseId(),
  ]);

  return {
    serverSettingsObject,
    publicSettingsObject,
    loadedDatabaseId,
  };
}

const loadDatabaseSettingsMongo = async (): Promise<DatabaseSettings> => {
  // eslint-disable-next-line no-console
  console.log("Loading settings from Mongo...");

  const db = getDatabase();
  if (!db) {
    return {
      serverSettingsObject: null,
      publicSettingsObject: null,
      loadedDatabaseId: null,
    };
  }

  const table = db.collection("databasemetadata");

  // Load serverSettings, publicSettings, and databaseId in parallel, so that
  // in development, server startup/restart doesn't have to wait for multiple
  // round trips to a remote database.
  const [
    serverSettingsObject,
    publicSettingsObject,
    loadedDatabaseId,
  ] = await Promise.all([
    await table.findOne({name: "serverSettings"}),
    await table.findOne({name: "publicSettings"}),
    await table.findOne({name: "databaseId"})
  ]);

  return {
    serverSettingsObject,
    publicSettingsObject,
    loadedDatabaseId,
  };
}

const loadDatabaseSettings = (): Promise<DatabaseSettings> => {
  if (getSqlClient()) {
    // This is run very early on in server startup before collections have been
    // built (so we need to use raw queries) and, therefore, before we can check
    // DatabaseMetadata.isPostgres(), so we just try to read from Postgres first
    // and switch to Mongo if that fails.
    try {
      return loadDatabaseSettingsPostgres();
    } catch (e) {
      console.warn("Failed to load database settings from Postgres - trying Mongo...");
      return loadDatabaseSettingsMongo();
    }
  } else {
    return loadDatabaseSettingsMongo();
  }
}

export const refreshSettingsCaches = async () => {
  const {
    serverSettingsObject,
    publicSettingsObject,
    loadedDatabaseId,
  } = await loadDatabaseSettings();

  databaseIdPreloaded = true;
  preloadedDatabaseId = loadedDatabaseId?.value;

  setServerSettingsCache(serverSettingsObject?.value || {__initialized: true});
  // We modify the publicSettings object that is made available in lib to allow both the client and the server to access it
  setPublicSettings(publicSettingsObject?.value || {__initialized: true});
}
