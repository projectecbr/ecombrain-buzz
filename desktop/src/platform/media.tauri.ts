import { invoke } from "@tauri-apps/api/core";

import type { PlatformMedia, UploadResult } from "./types";

export function createTauriMedia(): PlatformMedia {
  return {
    resolveUrl: (path) => path,
    pickAndUpload: () => invoke<UploadResult[]>("pick_and_upload_media", {}),
    uploadBytes: (data, filename, progressId) =>
      invoke<UploadResult>("upload_media_bytes", {
        data: [...data],
        filename,
        progressId,
      }),
    download: (url, filename) => {
      void invoke(filename ? "download_file" : "download_image", {
        url,
        filename,
      });
    },
    copyImage: (url) => invoke("copy_image_to_clipboard", { url }),
  };
}
