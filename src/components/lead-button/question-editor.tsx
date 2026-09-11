"use client";

import * as React from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/provider";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/switch";
import type { QuestionInput } from "@/lib/validation/leadflow";

const TYPES = ["TEXT", "PHONE", "EMAIL", "NUMBER", "SINGLE_SELECT", "MULTI_SELECT", "DATE", "TIME", "BOOLEAN"] as const;

/** Dialog for creating/editing one CRM question. Pure local state; the parent owns the list. */
export function QuestionEditor({
  open,
  onOpenChange,
  initial,
  onSave,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial: QuestionInput | null;
  onSave: (q: QuestionInput) => void;
}) {
  const { d } = useI18n();
  const [title, setTitle] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [type, setType] = React.useState<QuestionInput["type"]>("TEXT");
  const [required, setRequired] = React.useState(true);
  const [optionsText, setOptionsText] = React.useState("");
  const [mapTo, setMapTo] = React.useState<string>("");

  React.useEffect(() => {
    if (open) {
      setTitle(initial?.title ?? "");
      setPrompt(initial?.prompt ?? "");
      setType(initial?.type ?? "TEXT");
      setRequired(initial?.required ?? true);
      setOptionsText((initial?.options ?? []).join("\n"));
      setMapTo(initial?.mapTo ?? "");
    }
  }, [open, initial]);

  // Sensible automatic mapping so phone/email answers land in lead columns.
  React.useEffect(() => {
    if (type === "PHONE" && !mapTo) setMapTo("phone");
    if (type === "EMAIL" && !mapTo) setMapTo("email");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  const isSelect = type === "SINGLE_SELECT" || type === "MULTI_SELECT";

  function save() {
    const options = optionsText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 13);
    if (!title.trim() || !prompt.trim()) {
      toast.error(d.leadButton.validation.needQuestion);
      return;
    }
    if (isSelect && options.length < 2) {
      toast.error(d.leadButton.validation.optionsNeeded);
      return;
    }
    onSave({
      title: title.trim().slice(0, 120),
      prompt: prompt.trim().slice(0, 900),
      type,
      required,
      options: isSelect ? options : [],
      mapTo: mapTo === "name" || mapTo === "phone" || mapTo === "email" ? mapTo : null,
      validationRegex: initial?.validationRegex ?? null,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial ? d.leadButton.questionsB.editQuestion : d.leadButton.questionsB.addQuestion}>
        <div className="space-y-4">
          <Field label={d.leadButton.questionsB.qPrompt}>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={d.leadButton.questionsB.qPromptPh}
              className="min-h-16"
              maxLength={900}
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={d.leadButton.questionsB.qTitle}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={d.leadButton.questionsB.qTitlePh} maxLength={120} />
            </Field>
            <Field label={d.leadButton.questionsB.qType}>
              <Select value={type} onChange={(e) => setType(e.target.value as QuestionInput["type"])}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {d.leadButton.questionsB.types[t]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {isSelect && (
            <Field label={d.leadButton.questionsB.qOptions}>
              <Textarea
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder={d.leadButton.questionsB.qOptionsPh}
                className="min-h-20"
              />
            </Field>
          )}

          <Field label={d.leadButton.questionsB.qMapTo}>
            <Select value={mapTo} onChange={(e) => setMapTo(e.target.value)}>
              <option value="">{d.leadButton.questionsB.mapNone}</option>
              <option value="name">{d.leadButton.questionsB.mapName}</option>
              <option value="phone">{d.leadButton.questionsB.mapPhone}</option>
              <option value="email">{d.leadButton.questionsB.mapEmail}</option>
            </Select>
          </Field>

          <div className="rounded-lg border border-(--color-border) px-3">
            <ToggleRow
              label={d.leadButton.questionsB.qRequired}
              checked={required}
              onCheckedChange={setRequired}
              onLabel={d.common.required}
              offLabel={d.common.optional}
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {d.common.cancel}
            </Button>
            <Button onClick={save}>{d.common.save}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
