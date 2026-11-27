import { createHash } from "crypto";
import { readFileSync } from "fs";
import path from "path";
import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import { GraphQLError } from "graphql";
import { logger } from "../logger";

export type PersistedQueryAllowList = Record<string, string>;

let allowList: PersistedQueryAllowList | null = null;

function allowListPath(): string {
  return path.resolve(
    process.env.PERSISTED_QUERIES_PATH ?? path.join(process.cwd(), "persisted-queries.json")
  );
}

/**
 * The hash a client sends as `extensions.persistedQuery.sha256Hash`:
 * SHA-256 of the exact query string, hex encoded. `npm run graphql:persist`
 * keys the allow-list with this same function, so a query persisted by the
 * script is found by the hash its clients compute.
 */
export function hashPersistedQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

/**
 * An allow-list is a plain object of hash to query string. Anything else —
 * an array, a scalar, an object with non-string values — is a broken file,
 * not an empty list.
 */
export function isPersistedQueryAllowList(value: unknown): value is PersistedQueryAllowList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === "string");
}

function loadAllowList(): PersistedQueryAllowList {
  if (allowList !== null) {
    return allowList;
  }

  const filePath = allowListPath();

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    allowList = {};

    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      // A missing file is only a failure in production, where the empty
      // list refuses every query — so it gets one clear warning, once,
      // when the list is first loaded. Outside production the file is
      // optional and its absence stays silent.
      if (process.env.NODE_ENV === "production") {
        logger.warn("graphql.persisted_queries.missing", {
          path: filePath,
          message:
            "Persisted GraphQL query allow-list not found. In production every GraphQL query is refused until the file exists: create it with `npm run graphql:persist`, or set PERSISTED_QUERIES_PATH to its location.",
        });
      }
    } else {
      logger.error("graphql.persisted_queries.unreadable", {
        path: filePath,
        message:
          "Persisted GraphQL query allow-list could not be read. Treating it as empty; in production every GraphQL query is refused.",
      });
    }

    return allowList;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }

  if (!isPersistedQueryAllowList(parsed)) {
    // Name the path, never the contents: the file is operator-supplied and
    // its contents do not belong in a log line.
    logger.error("graphql.persisted_queries.invalid", {
      path: filePath,
      message:
        "Persisted GraphQL query allow-list is not valid JSON, or is not an object of hash to query string. Treating it as empty; in production every GraphQL query is refused.",
    });
    allowList = {};
    return allowList;
  }

  allowList = parsed;
  return allowList;
}

export function getPersistedQuery(hash: string): string | undefined {
  return loadAllowList()[hash];
}

export function resetPersistedQueryCache(): void {
  allowList = null;
}

export const persistedQueryPlugin: ApolloServerPlugin<BaseContext> = {
  async requestDidStart(requestContext) {
    const { request } = requestContext;
    const hash = request?.extensions?.persistedQuery?.sha256Hash;

    if (!hash) {
      if (process.env.NODE_ENV === "production") {
        throw new GraphQLError("Persisted query hash is required in production");
      }
      return;
    }

    const query = getPersistedQuery(hash);
    if (query) {
      request.query = query;
      delete request.extensions?.persistedQuery;
      return;
    }

    if (process.env.NODE_ENV === "production") {
      throw new GraphQLError(`Persisted query not found for hash ${hash}`);
    }
  },
};
