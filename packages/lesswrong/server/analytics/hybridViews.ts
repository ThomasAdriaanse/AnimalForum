import { getSqlClient } from "../../lib/sql/sqlClient";
import crypto from "crypto";
import { getAnalyticsConnection } from "./postgresConnection";
import { addCronJob } from "../cronUtil";
import { isAnyTest } from "../../lib/executionEnvironment";
import { isEAForum } from "../../lib/instanceSettings";
import { Globals } from "../vulcan-lib";

type HybridViewParams = {
  /**
   * An identifier for the view
   */
  identifier: string;
  /**
   * Function that returns the query from which the materialized view should be generated. This should have the
   * following properties:
   *  - A column window_end marking the end of the aggregation window. This is used to determine when to crossover
   *    from materialized to live data. Any aggregation period will work (including no aggregation at all), but
   *    as it happens all of the current views use daily aggregation.
   *  - A filter on timestamp (or equivalent) against `after`. This is used in the live view to only include
   *    data after the crossover time (which speeds up the query significantly).
   *  - (Optional) A filter on timestamp < NOW() in the materialized version. This is to guard against bad data
   *    (timestamps in the future) messing up the crossover time logic.
   *
   * Here is an example query:
   * SELECT
   *    count(*) AS view_count,
   *    post_id,
   *    (date_trunc('day', timestamp) + interval '1 second') AS window_start,
   *    (date_trunc('day', timestamp) + interval '1 day') AS window_end
   *  FROM
   *    page_view
   *  WHERE
   *    timestamp > '${after.toISOString()}'
   *    ${materialized ? 'AND timestamp < NOW()' : ''}
   *  GROUP BY
   *    post_id,
   *    date_trunc('day', timestamp)
   *
   * When you select from the `virtualTable()` generated by this view you can think of it as selecting from this
   * query, but with the timestamp logic removed.
   */
  queryGenerator: (after: Date, materialized: boolean) => string;
  /**
   * Array of functions that generate index queries, given the view name. You must provide at least one
   * UNIQUE index, without this it isn't possible to refresh the view without locking the table. They
   * should also all include "IF NOT EXISTS", not including this will cause errors to be logged (although
   * it will still work).
   */
  indexQueryGenerators: ((viewName: string) => string)[];
  /**
   * The SQL client for the database you are creating the view in. At time of writing (2023-08-04) they are
   * all in the analytics DB, but this would work in the main DB as well.
   */
  viewSqlClient?: RawSqlClient;
}

export class HybridView {
  protected queryGenerator: (after: Date, materialized: boolean) => string;
  protected indexQueryGenerators: ((viewName: string) => string)[];
  protected versionHash: string;
  protected identifier: string;
  private viewSqlClient: RawSqlClient;
  private matViewName: string;

  constructor({
    identifier,
    queryGenerator,
    indexQueryGenerators,
    viewSqlClient,
  }: HybridViewParams) {
    const viewSqlClientToUse = viewSqlClient ?? getSqlClient();

    if (!viewSqlClientToUse) throw new Error("Unable to connect to database");
    this.viewSqlClient = viewSqlClientToUse;

    this.queryGenerator = queryGenerator;
    const allTimeQuery = queryGenerator(new Date(0), true);
    const versionSignature = `${allTimeQuery}`;

    this.versionHash = crypto.createHash("sha256").update(versionSignature).digest("hex").slice(0, 16);
    this.identifier = identifier;
    // "hv" for "hybrid view"
    this.matViewName = `hv_${this.identifier}_${this.versionHash}`;
    this.indexQueryGenerators = indexQueryGenerators ?? [];
  }

  async viewExists() {
    // Check if materialized view exists
    return this.viewSqlClient.oneOrNone(`
      SELECT
        1
      FROM
        pg_matviews
      WHERE
        matviewname = '${this.matViewName}'
    `);
  }

  async refreshInProgress() {
    // Check if materialized view refresh is in progress
    return this.viewSqlClient.oneOrNone<{duration: string}>(`
      SELECT
        now() - pg_stat_activity.query_start AS duration
      FROM pg_stat_activity
      WHERE
        state = 'active' AND
        query ~* '^REFRESH MATERIALIZED VIEW.*${this.matViewName}.*'
    `);
  }

  async createInProgress() {
    // Check if materialized view creation is in progress
    return this.viewSqlClient.oneOrNone<{duration: string}>(`
      SELECT
        pid,
        now() - pg_stat_activity.query_start AS duration,
        query
      FROM pg_stat_activity
      WHERE
        state = 'active' AND
        query ~* '^CREATE MATERIALIZED VIEW.*${this.matViewName}.*'
    `);
  }

  async dropOldVersions() {
    // Drop older versions of this view, if this fails just continue
    try {
      const olderViews = await this.viewSqlClient.manyOrNone<{matviewname: string}>(
        `SELECT matviewname FROM pg_matviews WHERE matviewname LIKE 'hv_${this.identifier}_%' AND matviewname <> '${this.matViewName}'`
      );
      for (let view of olderViews) {
        await this.viewSqlClient.none(`DROP MATERIALIZED VIEW IF EXISTS "${view.matviewname}"`);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }

  async ensureView() {
    if (await this.viewExists()) {
      // TODO add something like this back in
      // await this.dropOldVersions();
      return;
    }

    const createInProgress = await this.createInProgress();
    if (createInProgress) {
      // eslint-disable-next-line no-console
      console.log(`Materialized view for ${this.identifier} is already in the process of being created.`);
      return;
    }

    // Create the materialized view, filtering by a date in the distant past to include all rows
    await this.viewSqlClient.none(
      `CREATE MATERIALIZED VIEW "${this.matViewName}" AS (${this.queryGenerator(new Date(0), true)})`
    );

    // TODO add something like this back in
    // await this.dropOldVersions();
  }

  async ensureIndexes() {
    if (!(await this.viewExists())) {
      // eslint-disable-next-line no-console
      console.error(`Cannot ensure indexes for "${this.matViewName}" as it doesn't exist`);
      return;
    }

    // Apply each index generator
    for (let i = 0; i < this.indexQueryGenerators.length; i++) {
      const indexQuery = this.indexQueryGenerators[i](this.matViewName);
      try {
        await this.viewSqlClient.none(indexQuery);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`Failed to apply index generator ${i} for "${this.matViewName}"`, e);
      }
    }
  }

  async refreshMaterializedView() {
    if (!(await this.viewExists())) {
      await this.ensureView();
      await this.ensureIndexes();
      return;
    }
    
    if (!(await this.refreshInProgress())) {
      await this.ensureIndexes();
      try {
        await this.viewSqlClient.none(`REFRESH MATERIALIZED VIEW CONCURRENTLY "${this.matViewName}"`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`Failed to refresh materialized view "${this.matViewName}". This may be because there is no unique index, which is required to refresh "CONCURRENTLY" (i.e. without locking the view from reads)`);
        throw e;
      }
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`Materialized view ${this.matViewName} is already in the process of being refreshed.`);
  }

  async virtualTable() {
    /**
     * Use the penultimate window_end as the crossover time, as the last window_end may contain incomplete data.
     * This will return undefined if the view doesn't exist, or there is some other error (such as there being only one window_end),
     * in this case we fall back to using only the live view.
     */
    const getCrossoverTime = async () => {
      try {
        const res = await this.viewSqlClient.oneOrNone<{window_end: string}>(`
          SELECT window_end::text
          FROM (
            SELECT DISTINCT window_end
            FROM ${this.matViewName}
            ORDER BY window_end DESC
            LIMIT 2
          ) AS subquery
          ORDER BY window_end ASC
          LIMIT 1
        `);
        // Enforce a UTC timezone, to avoid issues with the location of the server
        return res?.window_end ? new Date(res.window_end + "Z") : undefined;
      } catch (error) {
        // This can throw an error if the view doesn't exist yet
        return undefined;
      }
    };

    const crossoverTime = await getCrossoverTime();

    if (!crossoverTime) {
      if (!(await this.viewExists())) {
        // eslint-disable-next-line no-console
        console.log(`Falling back to live view: materialized view for ${this.identifier} doesn't exist yet`);
      } else {
        // eslint-disable-next-line no-console
        console.error(`Falling back to live view: unexpected error getting crossover time for ${this.identifier}`);
      }

      return `
        SELECT
            *,
            'live' AS source
        FROM
            (${this.queryGenerator(new Date(0), false)}) AS live_subquery
        `;
    }

    return `
        (
            SELECT
                *,
                'materialized' AS source
            FROM
                "${this.matViewName}"
            WHERE
                window_end <= '${crossoverTime.toISOString()}'
        )
        UNION ALL
        (
            SELECT
                *,
                'live' AS source
            FROM
                (${this.queryGenerator(crossoverTime, false)}) AS live_subquery
        )
    `;
  }
}

let hybridViews: Record<string, HybridView> = {};

export function registerHybridAnalyticsView({
  identifier,
  queryGenerator,
  indexQueryGenerators,
}: Omit<HybridViewParams, "viewSqlClient">) {
  if (isAnyTest || !isEAForum) return;

  const analyticsDb = getAnalyticsConnection();

  if (!analyticsDb) {
    // eslint-disable-next-line no-console
    console.log("No analytics DB configured, ignoring hybrid view");
    return;
  }

  const hybridView = new HybridView({
    identifier,
    queryGenerator,
    indexQueryGenerators,
    viewSqlClient: analyticsDb,
  });

  const ensureViewAndIndexes = async () => {
    await hybridView.ensureView();
    await hybridView.ensureIndexes();
  };

  void ensureViewAndIndexes();

  hybridViews[identifier] = hybridView;
}

export function getHybridView(identifier: string): HybridView | undefined {
  return hybridViews[identifier];
}

export async function refreshHybridViews() {
  Object.values(hybridViews).map((hybridView) => void hybridView.refreshMaterializedView());

  const analyticsDb = getAnalyticsConnection();

  if (!analyticsDb) {
    // eslint-disable-next-line no-console
    console.log("No analytics DB configured, not performing VACUUM ANALYZE");
    return;
  }

  void analyticsDb.none("VACUUM ANALYZE;");
}

addCronJob({
  name: "refreshHybridViews",
  interval: `every 1 day`,
  job: refreshHybridViews,
});

Globals.refreshHybridViews = refreshHybridViews;
