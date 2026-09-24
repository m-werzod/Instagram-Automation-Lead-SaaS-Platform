"use client";

import * as React from "react";
import { Info, Trash2, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { formatDuration, type TabProps, type VideoAssetRow } from "./types";
import { defaultEditParams } from "@/lib/video/params";
import { UploadDrop } from "./upload-drop";

/**
 * The audio mixer.
 *
 * The product's central promise lives here: the video's own sound and each
 * uploaded track have independent volume controls. "Original 30%, music 100%"
 * is two separate numbers, not one balance slider — and the note under the
 * controls says plainly that a percentage is a signal level, not perceived
 * loudness, because those are not the same thing and pretending otherwise would
 * mislead someone mixing by ear.
 */
export function AudioTab({ state, onPatch, onReload }: TabProps) {
  const { d } = useI18n();
  const t = d.videoEditor.audioPanel;
  const params = state.project.params ?? defaultEditParams();
  const source = state.project.sourceAsset;

  const audioAssets = state.project.assets.filter((a) => a.role === "AUDIO" && a.status === "READY");
  const inMix = new Set(params.audio.tracks.map((tr) => tr.assetId));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t.originalVolume} />
        <div className="space-y-4 p-4 pt-0">
          {source?.hasAudio === false ? (
            <p className="text-sm text-(--color-fg-muted)">{t.noAudioTrack}</p>
          ) : (
            <>
              <VolumeSlider
                label={t.trackVolume}
                value={params.audio.originalVolume}
                disabled={params.audio.muteOriginal}
                onCommit={(originalVolume) => void onPatch({ audio: { originalVolume } })}
              />
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>{t.muteOriginal}</span>
                <Switch
                  checked={params.audio.muteOriginal}
                  onCheckedChange={(muteOriginal) => void onPatch({ audio: { muteOriginal } })}
                />
              </label>
            </>
          )}
          <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t.volumeNote}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.tracks} />
        <div className="space-y-4 p-4 pt-0">
          {audioAssets.length === 0 && <p className="text-sm text-(--color-fg-muted)">{d.videoEditor.upload.audio}</p>}

          {audioAssets.map((asset) => {
            const track = params.audio.tracks.find((tr) => tr.assetId === asset.id);
            return (
              <TrackRow
                key={asset.id}
                asset={asset}
                track={track}
                onAdd={() =>
                  void onPatch({
                    audio: {
                      tracks: [
                        ...params.audio.tracks,
                        { assetId: asset.id, volume: 100, startSec: 0, fadeInSec: 0, fadeOutSec: 0, loop: false, duckUnderSpeech: false },
                      ],
                    },
                  })
                }
                onRemove={() =>
                  void onPatch({ audio: { tracks: params.audio.tracks.filter((tr) => tr.assetId !== asset.id) } })
                }
                onChange={(next) =>
                  void onPatch({
                    audio: {
                      tracks: params.audio.tracks.map((tr) => (tr.assetId === asset.id ? { ...tr, ...next } : tr)),
                    },
                  })
                }
              />
            );
          })}

          {inMix.size > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {t.duckNote}
            </p>
          )}
        </div>
      </Card>

      <UploadDrop
        projectId={state.project.id}
        role="AUDIO"
        maxUploadMb={state.capabilities.storage.maxUploadMb}
        disabled={!state.capabilities.storage.available}
        disabledReason={state.capabilities.storage.reason}
        onUploaded={() => void onReload()}
      />
    </div>
  );
}

interface TrackParams {
  assetId: string;
  volume: number;
  startSec: number;
  fadeInSec: number;
  fadeOutSec: number;
  loop: boolean;
  duckUnderSpeech: boolean;
}

function TrackRow({
  asset,
  track,
  onAdd,
  onRemove,
  onChange,
}: {
  asset: VideoAssetRow;
  track: TrackParams | undefined;
  onAdd: () => void;
  onRemove: () => void;
  onChange: (next: Partial<TrackParams>) => void;
}) {
  const { d } = useI18n();
  const t = d.videoEditor.audioPanel;

  return (
    <div className="rounded-lg border border-(--color-border) p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{asset.filename}</p>
          <p className="text-xs text-(--color-fg-muted)">{formatDuration(asset.durationSec)}</p>
        </div>
        {track ? (
          <Button size="sm" variant="ghost" aria-label={t.removeTrack} onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={onAdd}>
            <Plus className="mr-1.5 h-4 w-4" />
            {t.addTrack}
          </Button>
        )}
      </div>

      {track && (
        <div className="mt-3 space-y-3">
          <VolumeSlider label={t.trackVolume} value={track.volume} onCommit={(volume) => onChange({ volume })} />
          <div className="grid gap-3 sm:grid-cols-3">
            <SmallNumber label={t.startAt} value={track.startSec} onChange={(startSec) => onChange({ startSec })} />
            <SmallNumber label={t.fadeIn} value={track.fadeInSec} onChange={(fadeInSec) => onChange({ fadeInSec })} />
            <SmallNumber label={t.fadeOut} value={track.fadeOutSec} onChange={(fadeOutSec) => onChange({ fadeOutSec })} />
          </div>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t.loop}</span>
            <Switch checked={track.loop} onCheckedChange={(loop) => onChange({ loop })} />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t.duck}</span>
            <Switch checked={track.duckUnderSpeech} onCheckedChange={(duckUnderSpeech) => onChange({ duckUnderSpeech })} />
          </label>
        </div>
      )}
    </div>
  );
}

function VolumeSlider({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);

  return (
    <label className={`block text-xs ${disabled ? "opacity-50" : ""}`}>
      <span className="mb-1.5 flex items-center justify-between font-medium text-(--color-fg-muted)">
        <span>{label}</span>
        <span className="tabular-nums text-(--color-fg)">{local}%</span>
      </span>
      <input
        type="range"
        className="w-full accent-(--color-accent)"
        value={local}
        min={0}
        max={200}
        step={1}
        disabled={disabled}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        onKeyUp={() => onCommit(local)}
      />
    </label>
  );
}

function SmallNumber({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <label className="block text-xs">
      <span className="mb-1.5 block font-medium text-(--color-fg-muted)">{label}</span>
      <input
        type="number"
        className="w-full rounded-md border border-(--color-border) bg-(--color-panel-2) px-2.5 py-1.5 text-sm"
        value={local}
        min={0}
        step={0.5}
        onChange={(e) => setLocal(Number(e.target.value))}
        onBlur={() => onChange(local)}
      />
    </label>
  );
}
