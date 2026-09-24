"use client";

import * as React from "react";
import { Sparkles, Info, Loader2, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { UploadDrop } from "./upload-drop";
import { formatDuration, type EditorState, type PlanItemRow } from "./types";

/**
 * Style replication from a reference video.
 *
 * The plan separates what the engine will actually reproduce from what it only
 * approximates and what it cannot do at all, and only the first two categories
 * can be selected. That distinction is the honest core of this feature: the
 * system never claims to have recreated a video it merely measured.
 */
export function SampleTab({ state, onReload }: { state: EditorState; onReload: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.videoEditor.samplePanel;

  const samples = state.project.assets.filter((a) => a.role === "SAMPLE" && a.status === "READY");
  const analyses = state.project.samples;
  const latest = analyses[0];
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);

  const plan: PlanItemRow[] = React.useMemo(() => latest?.plan ?? [], [latest?.plan]);

  // Pre-select the applicable items whenever a new analysis arrives. Keyed on
  // the analysis id, not on `applicable`, so re-rendering does not wipe the
  // operator's own selection.
  const analysisId = latest?.id;
  React.useEffect(() => {
    setSelected((plan ?? []).filter((p) => p.feasibility !== "unsupported" && p.patch).map((p) => p.op));
  }, [analysisId, plan]);

  async function analyze(sampleAssetId: string) {
    setBusy(true);
    try {
      await api("/api/video/sample", { method: "POST", json: { projectId: state.project.id, sampleAssetId } });
      toast.success(t.analyzing);
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!latest || selected.length === 0) return;
    setBusy(true);
    try {
      const res = await api<{ applied: string[]; skipped: string[] }>("/api/video/sample", {
        method: "PATCH",
        json: { analysisId: latest.id, ops: selected },
      });
      toast.success(`${res.applied.length} / ${selected.length}`);
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-4">
        <p className="text-sm font-semibold">{t.title}</p>
        <p className="text-sm text-(--color-fg-muted)">{t.explain}</p>
      </Card>

      <UploadDrop
        projectId={state.project.id}
        role="SAMPLE"
        maxUploadMb={state.capabilities.storage.maxUploadMb}
        disabled={!state.capabilities.storage.available}
        disabledReason={state.capabilities.storage.reason}
        onUploaded={() => void onReload()}
      />

      {samples.length > 0 && (
        <Card>
          <CardHeader title={d.videoEditor.upload.sample} />
          <div className="space-y-2 p-4 pt-0">
            {samples.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border border-(--color-border) p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{s.filename}</p>
                  <p className="text-xs text-(--color-fg-muted)">{formatDuration(s.durationSec)}</p>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void analyze(s.id)}>
                  {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                  {t.analyze}
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!latest ? (
        <Card className="p-6 text-sm text-(--color-fg-muted)">{t.noPlan}</Card>
      ) : latest.status !== "DONE" ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-(--color-fg-muted)">
          {latest.status === "FAILED" ? (
            <span className="text-(--color-danger)">{latest.error}</span>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {t.analyzing}
            </>
          )}
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title={t.measured} />
            <div className="grid gap-3 p-4 pt-0 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Fact label={t.framing} value={latest.measured?.aspectLabel ?? "—"} />
              <Fact label={t.cuts} value={String(latest.measured?.cutCount ?? 0)} />
              <Fact
                label={t.pacing}
                value={`${latest.measured?.pacing ?? "—"}${latest.measured?.medianCutSec ? ` · ${latest.measured.medianCutSec}s` : ""}`}
              />
              <Fact
                label={t.loudness}
                value={latest.measured?.loudnessLufs !== null && latest.measured?.loudnessLufs !== undefined ? `${latest.measured.loudnessLufs.toFixed(1)} LUFS` : "—"}
              />
            </div>
          </Card>

          {latest.observed && (
            <Card>
              <CardHeader title={t.observed} />
              <div className="space-y-2 p-4 pt-0 text-sm">
                <p className="text-(--color-fg-muted)">{latest.observed.summary}</p>
                {latest.observed.pacingDescription && <p className="text-(--color-fg-muted)">{latest.observed.pacingDescription}</p>}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title={t.plan} />
            <div className="space-y-2 p-4 pt-0">
              {plan.map((item) => {
                const canApply = item.feasibility !== "unsupported" && Boolean(item.patch);
                const checked = selected.includes(item.op);
                return (
                  <label
                    key={`${item.op}-${item.label}`}
                    className={`flex items-start gap-3 rounded-md border border-(--color-border) p-3 ${canApply ? "cursor-pointer" : "opacity-70"}`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-(--color-accent)"
                      disabled={!canApply}
                      checked={checked && canApply}
                      onChange={(e) =>
                        setSelected((s) => (e.target.checked ? [...new Set([...s, item.op])] : s.filter((op) => op !== item.op)))
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{item.label}</span>
                        <FeasibilityBadge feasibility={item.feasibility} />
                      </div>
                      <p className="mt-0.5 text-xs text-(--color-fg-muted)">{item.note}</p>
                    </div>
                  </label>
                );
              })}

              <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t.honestNote}
              </p>

              <Button disabled={busy || selected.length === 0} onClick={() => void apply()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {t.applySelected}
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function FeasibilityBadge({ feasibility }: { feasibility: PlanItemRow["feasibility"] }) {
  const { d } = useI18n();
  const labels = d.videoEditor.samplePanel.feasibility;
  if (feasibility === "reproducible") {
    return (
      <Badge tone="ok">
        <CheckCircle2 className="h-3 w-3" /> {labels.reproducible}
      </Badge>
    );
  }
  if (feasibility === "approximate") {
    return (
      <Badge tone="warn">
        <MinusCircle className="h-3 w-3" /> {labels.approximate}
      </Badge>
    );
  }
  return (
    <Badge tone="default">
      <XCircle className="h-3 w-3" /> {labels.unsupported}
    </Badge>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-(--color-fg-muted)">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
