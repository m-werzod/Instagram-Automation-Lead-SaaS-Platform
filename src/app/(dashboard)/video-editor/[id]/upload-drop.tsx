"use client";

import * as React from "react";
import { Upload, Loader2, AlertTriangle } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card } from "@/components/ui/card";

/**
 * Upload control for source video, audio tracks and sample videos.
 *
 * The two-step flow (reserve a row, then send the bytes) exists because a
 * serverless deployment cannot accept a video through a function at all: there
 * the first step returns a token and the browser uploads straight to Blob
 * storage. With a resident worker the bytes come back through the app. Progress
 * comes from a real XHR upload event, not a simulated bar.
 */

export type UploadRole = "SOURCE" | "AUDIO" | "SAMPLE";

interface BeginResponse {
  asset: { id: string; storageKey: string };
  upload: { mode: "direct" | "proxy"; url: string; token?: string };
}

export function UploadDrop({
  projectId,
  role,
  maxUploadMb,
  disabled,
  disabledReason,
  onUploaded,
}: {
  projectId: string;
  role: UploadRole;
  maxUploadMb: number;
  disabled?: boolean;
  disabledReason?: string | null;
  onUploaded: (assetId: string) => void;
}) {
  const { d } = useI18n();
  const t = d.videoEditor.upload;
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [phase, setPhase] = React.useState<"idle" | "uploading" | "checking">("idle");
  const [error, setError] = React.useState<string | null>(null);

  const accept =
    role === "AUDIO"
      ? "audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/flac,.mp3,.m4a,.wav,.ogg,.flac"
      : "video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm";

  async function handleFile(file: File) {
    setError(null);
    if (file.size > maxUploadMb * 1024 * 1024) {
      setError(t.maxSize.replace("{mb}", String(maxUploadMb)));
      return;
    }

    setPhase("uploading");
    setProgress(0);
    try {
      // One MIME for the whole upload: the direct-upload token is minted for the
      // type sent here, and Blob rejects a body that arrives with a different
      // one — which is exactly what happened when the browser reported no type
      // and each step guessed separately.
      const mimeType = uploadMimeType(file.name, file.type, role);

      const begin = await api<BeginResponse>("/api/video/assets", {
        method: "PUT",
        json: { projectId, role, filename: file.name, mimeType, sizeBytes: file.size },
      });

      if (begin.upload.mode === "direct") {
        await putWithProgress(begin.upload.url, file, mimeType, setProgress, begin.upload.token);
        await api("/api/video/assets", { method: "POST", json: { assetId: begin.asset.id } });
      } else {
        await putWithProgress(begin.upload.url, file, mimeType, setProgress);
      }

      setPhase("checking");
      setProgress(null);
      onUploaded(begin.asset.id);
    } catch (err) {
      setError(err instanceof ApiError ? [err.shape.message, err.shape.fix].filter(Boolean).join(" — ") : t.failed);
    } finally {
      setPhase("idle");
      setProgress(null);
    }
  }

  const label = role === "AUDIO" ? t.audio : role === "SAMPLE" ? t.sample : t.source;
  const hint = role === "AUDIO" ? t.audioHint : role === "SAMPLE" ? t.sampleHint : t.sourceHint;
  const busy = phase !== "idle";

  return (
    <Card
      className={`relative p-5 transition ${dragging ? "border-(--color-accent) bg-(--color-accent-soft)" : ""} ${
        disabled ? "opacity-60" : ""
      }`}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (disabled || busy) return;
        const file = e.dataTransfer.files?.[0];
        if (file) void handleFile(file);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="sr-only"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="flex w-full flex-col items-center gap-2 text-center disabled:cursor-not-allowed"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <Loader2 className="h-6 w-6 animate-spin text-(--color-fg-faint)" />
        ) : (
          <Upload className="h-6 w-6 text-(--color-fg-faint)" />
        )}
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-(--color-fg-muted)">
          {busy ? (phase === "uploading" ? t.uploading : t.checking) : t.dropHere}
        </span>
        <span className="text-xs text-(--color-fg-faint)">
          {hint} · {t.maxSize.replace("{mb}", String(maxUploadMb))}
        </span>
      </button>

      {progress !== null && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-(--color-panel-2)">
          <div className="h-full bg-(--color-accent) transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}

      {disabled && disabledReason && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
          {disabledReason}
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-(--color-danger)">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </Card>
  );
}

/** XHR rather than fetch: only XHR reports upload progress. */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
  bearer?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(bearer ? "PUT" : "POST", url, true);
    // Credentials only on the same-origin proxy upload. Blob answers with a
    // wildcard CORS origin, which a credentialed request is not allowed to
    // accept, so sending cookies there fails the upload outright — and the
    // one-time token below is the only authentication it needs.
    xhr.withCredentials = !bearer;
    if (bearer) {
      // Direct-to-Blob uploads authenticate with the one-time client token.
      xhr.setRequestHeader("authorization", `Bearer ${bearer}`);
      xhr.setRequestHeader("x-api-version", "7");
      xhr.setRequestHeader("x-content-type", contentType);
    } else {
      xhr.setRequestHeader("content-type", contentType);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}

/**
 * The single MIME type an upload is described by. Browsers occasionally report
 * an empty type (MKV, and some MOV files), so it falls back to the extension —
 * but every step of the upload must then use this same answer.
 */
export function uploadMimeType(filename: string, browserType: string, role: UploadRole): string {
  const reported = browserType.split(";")[0]!.trim();
  return reported || guessMime(filename, role);
}

function guessMime(filename: string, role: UploadRole): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (role === "AUDIO") {
    const map: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac" };
    return map[ext] ?? "audio/mpeg";
  }
  const map: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm" };
  return map[ext] ?? "video/mp4";
}
