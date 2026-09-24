import {
  BoxCcgAuth,
  BoxClient,
  BoxDeveloperTokenAuth,
  CcgConfig,
} from "box-node-sdk";
import type { StorageEntry, StorageProvider, StreamingUrl } from "./provider";

/**
 * Server-only. Authenticates as a Box service account via Client Credentials
 * Grant (CCG), scoped to the enterprise — see BOX_* vars in .env.example and
 * the "Box server auth mode" note in the plan. Never import this module into
 * client code; it holds the app's Box client secret.
 */

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

let baseAuth: BoxCcgAuth | undefined;

function getBaseAuth(): BoxCcgAuth {
  if (baseAuth) return baseAuth;
  baseAuth = new BoxCcgAuth({
    config: new CcgConfig({
      clientId: getEnv("BOX_CLIENT_ID"),
      clientSecret: getEnv("BOX_CLIENT_SECRET"),
      enterpriseId: getEnv("BOX_ENTERPRISE_ID"),
    }),
  });
  return baseAuth;
}

/** A client authenticated as the service account, full access to its content. */
function getBaseClient(): BoxClient {
  return new BoxClient({ auth: getBaseAuth() });
}

/**
 * Mints a client whose access token is downscoped to read-only access on a
 * single file, so if the resulting streaming URL ever leaked, the blast
 * radius is that one file, not the whole Box account.
 */
async function getScopedFileClient(fileId: string): Promise<{
  client: BoxClient;
  expiresAt: Date;
}> {
  const resource = `https://api.box.com/2.0/files/${fileId}`;
  const scopedToken = await getBaseAuth().downscopeToken(
    ["item_download"],
    resource
  );
  if (!scopedToken.accessToken) {
    throw new Error(`Box: failed to downscope token for file ${fileId}`);
  }
  const client = new BoxClient({
    auth: new BoxDeveloperTokenAuth({ token: scopedToken.accessToken }),
  });
  const expiresAt = new Date(
    Date.now() + (scopedToken.expiresIn ?? 60) * 1000
  );
  return { client, expiresAt };
}

const PAGE_SIZE = 1000;
const MAX_ENTRIES = 20000; // sanity cap against runaway pagination

async function listFolder(folderId: string): Promise<StorageEntry[]> {
  const client = getBaseClient();
  const entries: StorageEntry[] = [];
  let offset = 0;

  for (;;) {
    const page = await client.folders.getFolderItems(folderId, {
      queryParams: {
        fields: ["name", "size", "type"],
        offset,
        limit: PAGE_SIZE,
      },
    });

    for (const item of page.entries ?? []) {
      if (item.type === "file") {
        entries.push({
          id: item.id,
          name: item.name ?? item.id,
          kind: "file",
          sizeBytes: item.size,
        });
      } else if (item.type === "folder") {
        entries.push({ id: item.id, name: item.name ?? item.id, kind: "folder" });
      }
      // web links are ignored — not relevant to a media library
    }

    const total = page.totalCount ?? entries.length;
    offset += page.entries?.length ?? 0;
    if (offset >= total || !page.entries?.length || entries.length >= MAX_ENTRIES) {
      break;
    }
  }

  return entries;
}

async function getStreamingUrl(fileId: string): Promise<StreamingUrl> {
  const { client, expiresAt } = await getScopedFileClient(fileId);
  const url = await client.downloads.getDownloadFileUrl(fileId);
  return { url, expiresAt };
}

async function fetchByteRange(
  fileId: string,
  startByte: number,
  endByte: number
): Promise<ArrayBuffer> {
  // Reuse the same pre-authenticated download URL path the browser will
  // eventually use, so the probe exercises the real range-request behavior.
  const { url } = await getStreamingUrl(fileId);
  const res = await fetch(url, {
    headers: { Range: `bytes=${startByte}-${endByte}` },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(
      `Box: byte-range fetch failed for file ${fileId} (${res.status})`
    );
  }
  return res.arrayBuffer();
}

export const boxProvider: StorageProvider = {
  listFolder,
  getStreamingUrl,
  fetchByteRange,
};
