import type { Locale } from "../config";
import { en, type Dictionary } from "./en";
import { uz } from "./uz";
import { ru } from "./ru";

export type { Dictionary };

/** All locales ship in the client bundle so switching is instant, no reload. */
export const DICTIONARIES: Record<Locale, Dictionary> = { en, uz, ru };
