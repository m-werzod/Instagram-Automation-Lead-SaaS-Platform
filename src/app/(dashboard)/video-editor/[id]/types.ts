import type { EditParams } from "@/lib/video/params";

/** Shapes the editor screens share. Mirrors what /api/video/projects/[id] returns. */

export interface VideoAssetRow {
  id: string;
  role: "SOURCE" | "AUDIO" | "SAMPLE" | "EXPORT" | "PREVIEW" | "THUMBNAIL";
  status: "UPLOADING" | "READY" | "FAILED" | "DELETED";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  error: string | null;
  createdAt: string;
}

export interface VideoJobRow {
  id: string;
  kind: "PROBE" | "PREVIEW" | "EXPORT" | "TRANSCRIBE" | "SAMPLE_ANALYZE" | "THUMBNAIL" | "WAVEFORM";
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  progressPct: number;
  error: string | null;
  logTail: string | null;
  outputAssetId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface SubtitleCueRow {
  start: number;
  end: number;
  text: string;
  words?: Array<{ start: number; end: number; text: string }>;
}

export interface SubtitleTrackRow {
  id: string;
  language: string;
  source: "AUTO" | "MANUAL" | "IMPORTED";
  cues: SubtitleCueRow[];
  style: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
}

export interface PlanItemRow {
  op: string;
  label: string;
  feasibility: "reproducible" | "approximate" | "unsupported";
  note: string;
  patch?: Record<string, unknown>;
}

export interface SampleAnalysisRow {
  id: string;
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  sampleAsset: { id: string; filename: string } | null;
  measured: {
    durationSec: number | null;
    aspectLabel: string;
    cutCount: number;
    medianCutSec: number | null;
    pacing: string;
    loudnessLufs: number | null;
    speechRatio: number | null;
    width: number | null;
    height: number | null;
  } | null;
  observed: {
    hasSubtitles: boolean | null;
    subtitlePosition: string | null;
    colorTreatment: string | null;
    pacingDescription: string | null;
    notableEffects: string[];
    summary: string;
  } | null;
  plan: PlanItemRow[] | null;
  error: string | null;
  createdAt: string;
}

export interface ChatMessageRow {
  id: string;
  role: string;
  text: string;
  proposal: { summary?: string; changes?: Array<{ path: string; from: string; to: string }>; unsupported?: string[] } | null;
  state: string;
  language: string | null;
  createdAt: string;
}

export interface CapabilityShape {
  available: boolean;
  reason: string | null;
  fix: string | null;
  detail?: string | null;
}

export interface Capabilities {
  rendering: CapabilityShape;
  worker: CapabilityShape;
  storage: CapabilityShape & { driver: string; maxUploadMb: number };
  subtitlesAuto: CapabilityShape;
  sampleAnalysis: CapabilityShape;
  chatAssistant: CapabilityShape;
  publishing: CapabilityShape;
}

export interface ProjectRecord {
  id: string;
  accountId: string;
  title: string;
  status: "DRAFT" | "READY" | "ARCHIVED";
  params: EditParams | null;
  sourceAssetId: string | null;
  lastExportId: string | null;
  sourceAsset: VideoAssetRow | null;
  assets: VideoAssetRow[];
  subtitle: SubtitleTrackRow[];
  samples: SampleAnalysisRow[];
  jobs: VideoJobRow[];
  messages: ChatMessageRow[];
}

export interface ProjectPayload {
  project: ProjectRecord;
  capabilities: Capabilities;
  exportWarnings: Array<{ code: string; detail: string }>;
  canUndo: boolean;
}

export interface EditorState {
  project: ProjectRecord;
  capabilities: Capabilities;
  exportWarnings: Array<{ code: string; detail: string }>;
  canUndo: boolean;
}

export interface TabProps {
  state: EditorState;
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  onReload: () => Promise<void>;
}

/** Seconds as m:ss — the form every video tool uses. */
export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  const total = Math.max(0, Math.round(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
