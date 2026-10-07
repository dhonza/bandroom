import { setLinkVisitorName, VisitorNameSchema } from "@bandroom/shared";
import { TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { useApiError } from "../api/useApiError";
import { rememberedVisitorName, rememberVisitorName, setLinkView, useLinkMode } from "./linkMode";

export interface VisitorNameState {
  active: boolean;
  name: string;
  setName: (name: string) => void;
  error: string | null;
  /** Stores the name in the link session (SPEC §3.5) if it changed; false when invalid. */
  save: () => Promise<boolean>;
}

/** The display name anonymous link visitors comment under. Inactive outside link mode. */
export function useVisitorName(): VisitorNameState {
  const { t } = useTranslation();
  const apiError = useApiError();
  const view = useLinkMode((s) => s.view);
  const [name, setName] = useState(() => view?.visitor.name ?? rememberedVisitorName());
  const [error, setError] = useState<string | null>(null);
  const active = view?.allowComments === true;
  const save = async (): Promise<boolean> => {
    const n = name.trim();
    if (!VisitorNameSchema.safeParse(n).success) {
      setError(t("links.visitor.nameRequired"));
      return false;
    }
    if (!view || n === view.visitor.name) return true;
    try {
      await api(setLinkVisitorName, { body: { name: n } });
    } catch (err) {
      setError(apiError(err));
      return false;
    }
    setLinkView({ ...view, visitor: { name: n } });
    rememberVisitorName(n);
    setError(null);
    return true;
  };
  return {
    active,
    name,
    setName: (v) => {
      setName(v);
      setError(null);
    },
    error,
    save,
  };
}

export function VisitorName({ visitor }: { visitor: VisitorNameState }) {
  const { t } = useTranslation();
  return (
    <TextInput
      label={t("links.visitor.name")}
      description={t("links.visitor.nameHint")}
      value={visitor.name}
      maxLength={60}
      error={visitor.error}
      onChange={(e) => {
        visitor.setName(e.currentTarget.value);
      }}
      data-testid="visitor-name"
    />
  );
}
