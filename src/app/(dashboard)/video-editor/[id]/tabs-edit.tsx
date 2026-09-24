"use client";

import * as React from "react";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDuration, type TabProps } from "./types";
import { defaultEditParams } from "@/lib/video/params";

/**
 * Trim, speed, framing and colour. Every control writes a parameter patch and
 * the server re-validates it, so the bounds here are a convenience rather than
 * the actual guard.
 */
export function EditTab({ state, onPatch }: TabProps) {
  const { d } = useI18n();
  const t = d.videoEditor.video;
  const params = state.project.params ?? defaultEditParams();
  const source = state.project.sourceAsset;
  const duration = source?.durationSec ?? null;

  const [trimStart, setTrimStart] = React.useState(params.video.trim?.startSec ?? 0);
  const [trimEnd, setTrimEnd] = React.useState(params.video.trim?.endSec ?? duration ?? 0);

  React.useEffect(() => {
    setTrimStart(params.video.trim?.startSec ?? 0);
    setTrimEnd(params.video.trim?.endSec ?? duration ?? 0);
  }, [params.video.trim?.startSec, params.video.trim?.endSec, duration]);

  const previewUrl = source ? `/api/video/assets/${source.id}/stream` : null;

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        {previewUrl && (
          // Streaming route honours Range requests, so scrubbing works.
          <video key={previewUrl} src={previewUrl} controls className="max-h-[420px] w-full bg-black" preload="metadata" />
        )}
        <div className="flex flex-wrap gap-4 p-4 text-xs text-(--color-fg-muted)">
          <span>
            {t.duration}: {formatDuration(duration)}
          </span>
          <span>
            {t.resolution}: {source?.width ?? "?"}×{source?.height ?? "?"}
          </span>
          {source && !source.hasAudio && <span className="text-(--color-warn)">{d.videoEditor.audioPanel.noAudioTrack}</span>}
        </div>
      </Card>

      <Card>
        <CardHeader title={t.trim} />
        <div className="space-y-4 p-4 pt-0">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              label={t.start}
              value={trimStart}
              min={0}
              max={duration ?? 3600}
              step={0.1}
              suffix="s"
              onChange={setTrimStart}
            />
            <NumberField
              label={t.end}
              value={trimEnd}
              min={0}
              max={duration ?? 3600}
              step={0.1}
              suffix="s"
              onChange={setTrimEnd}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() =>
                void onPatch({ video: { trim: { startSec: trimStart, endSec: trimEnd > trimStart ? trimEnd : undefined } } })
              }
            >
              {d.common.save}
            </Button>
            {params.video.trim && (
              <Button size="sm" variant="ghost" onClick={() => void onPatch({ video: { trim: undefined } })}>
                {d.common.cancel}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.speed} />
        <div className="p-4 pt-0">
          <div className="flex flex-wrap gap-2">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
              <Button
                key={speed}
                size="sm"
                variant={params.video.speed === speed ? "default" : "secondary"}
                onClick={() => void onPatch({ video: { speed } })}
              >
                {speed}×
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.aspect} />
        <div className="space-y-3 p-4 pt-0">
          <div className="flex flex-wrap gap-2">
            {(["original", "9:16", "4:5", "1:1", "16:9"] as const).map((aspect) => (
              <Button
                key={aspect}
                size="sm"
                variant={params.video.aspect === aspect ? "default" : "secondary"}
                onClick={() => void onPatch({ video: { aspect } })}
              >
                {aspect === "original" ? t.original : aspect}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {(["cover", "contain"] as const).map((fit) => (
              <Button
                key={fit}
                size="sm"
                variant={params.video.fit === fit ? "default" : "secondary"}
                onClick={() => void onPatch({ video: { fit } })}
              >
                {fit === "cover" ? t.cover : t.contain}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={t.look} />
        <div className="space-y-4 p-4 pt-0">
          <div className="flex flex-wrap gap-2">
            {(["none", "vivid", "warm", "cool", "soft", "contrast", "bw"] as const).map((preset) => (
              <Button
                key={preset}
                size="sm"
                variant={params.look.preset === preset ? "default" : "secondary"}
                onClick={() => void onPatch({ look: { preset } })}
              >
                {preset}
              </Button>
            ))}
          </div>
          <SliderField
            label={t.brightness}
            value={params.look.brightness}
            min={-0.5}
            max={0.5}
            step={0.05}
            onCommit={(brightness) => void onPatch({ look: { brightness } })}
          />
          <SliderField
            label={t.contrast}
            value={params.look.contrast}
            min={0.5}
            max={2}
            step={0.05}
            onCommit={(contrast) => void onPatch({ look: { contrast } })}
          />
          <SliderField
            label={t.saturation}
            value={params.look.saturation}
            min={0}
            max={3}
            step={0.05}
            onCommit={(saturation) => void onPatch({ look: { saturation } })}
          />
        </div>
      </Card>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="mb-1.5 block font-medium text-(--color-fg-muted)">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          className="w-full rounded-md border border-(--color-border) bg-(--color-panel-2) px-2.5 py-1.5 text-sm"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {suffix && <span className="text-(--color-fg-faint)">{suffix}</span>}
      </div>
    </label>
  );
}

/**
 * Commits on release rather than on every frame of a drag — each commit is a
 * server round trip, so continuous updates would flood the API.
 */
function SliderField({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);

  return (
    <label className="block text-xs">
      <span className="mb-1.5 flex items-center justify-between font-medium text-(--color-fg-muted)">
        <span>{label}</span>
        <span className="tabular-nums text-(--color-fg)">{local.toFixed(2)}</span>
      </span>
      <input
        type="range"
        className="w-full accent-(--color-accent)"
        value={local}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setLocal(Number(e.target.value))}
        onMouseUp={() => onCommit(local)}
        onTouchEnd={() => onCommit(local)}
        onKeyUp={() => onCommit(local)}
      />
    </label>
  );
}
