import type { PlatformMedia, PlatformSigner, UploadResult } from "./types";
import {
  activeWorkspaceRelayWsUrl,
  defaultRelayWsUrl,
  relayWsToHttpBase,
} from "./commands/context.ts";
import { getSigner } from "./index.ts";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export type BrowserMediaOptions = {
  baseUrl?: string;
  signer?: PlatformSigner;
  fetchFn?: typeof fetch;
  document?: Document;
};

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function safeFilename(filename?: string): string | undefined {
  return (
    [...(filename ?? "")]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 32 ||
          code === 127 ||
          character === "/" ||
          character === "\\"
          ? "_"
          : character;
      })
      .join("")
      .slice(0, 255) || undefined
  );
}

function validateUpload(data: Uint8Array, filename?: string): void {
  if (data.byteLength === 0) throw new Error("empty upload");
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("upload exceeds the 500 MiB limit");
  }
  const extension = filename?.split(".").pop()?.toLowerCase();
  if (["mov", "avi", "mkv", "webm", "m4v"].includes(extension ?? "")) {
    throw new Error("video uploads must be MP4 in EcomBrain Teams v1");
  }
}

function pickFiles(documentRef: Document): Promise<File[]> {
  return new Promise((resolve) => {
    const input = documentRef.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export function createBrowserMedia(
  options: BrowserMediaOptions = {},
): PlatformMedia {
  const signer = options.signer ?? getSigner();
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const baseUrl = () =>
    (
      options.baseUrl ??
      relayWsToHttpBase(activeWorkspaceRelayWsUrl() ?? defaultRelayWsUrl())
    ).replace(/\/+$/, "");

  async function uploadBytes(
    data: Uint8Array,
    filename?: string,
  ): Promise<UploadResult> {
    validateUpload(data, filename);
    const body = new ArrayBuffer(data.byteLength);
    new Uint8Array(body).set(data);
    const hash = await sha256Hex(body);
    const target = new URL(`${baseUrl()}/media/upload`);
    const auth = await signer.signEvent({
      kind: 24242,
      content: "Upload to EcomBrain Teams",
      tags: [
        ["t", "upload"],
        ["x", hash],
        ["expiration", String(Math.floor(Date.now() / 1000) + 300)],
        ["server", target.host],
      ],
    });
    const response = await fetchFn(target, {
      method: "PUT",
      credentials: "include",
      headers: {
        Authorization: `Nostr ${base64Utf8(JSON.stringify(auth))}`,
        "Content-Type": "application/octet-stream",
        "X-SHA-256": hash,
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`media upload failed (${response.status})`);
    }
    const descriptor = (await response.json()) as UploadResult;
    if (descriptor.sha256 !== hash || typeof descriptor.url !== "string") {
      throw new Error("media upload returned an invalid descriptor");
    }
    return { ...descriptor, filename: safeFilename(filename) };
  }

  return {
    resolveUrl(path) {
      if (/^(?:https?:|blob:|data:)/.test(path)) return path;
      return new URL(path, `${baseUrl()}/`).toString();
    },
    async pickAndUpload() {
      const documentRef = options.document ?? globalThis.document;
      if (!documentRef) throw new Error("file picker is unavailable");
      const files = await pickFiles(documentRef);
      return Promise.all(
        files.map(async (file) => {
          const descriptor = await uploadBytes(
            new Uint8Array(await file.arrayBuffer()),
            file.name,
          );
          return { ...descriptor, type: descriptor.type || file.type };
        }),
      );
    },
    uploadBytes,
    download(url, filename) {
      const documentRef = options.document ?? globalThis.document;
      if (!documentRef) throw new Error("download is unavailable");
      const anchor = documentRef.createElement("a");
      anchor.href = url;
      if (filename) anchor.download = safeFilename(filename) ?? "download";
      anchor.rel = "noopener";
      anchor.click();
    },
    async copyImage(url) {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("image clipboard is unavailable");
      }
      const response = await fetchFn(url, { credentials: "include" });
      if (!response.ok)
        throw new Error(`image download failed (${response.status})`);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
    },
  };
}
