import { MAX_SLUG } from "./limits";

/** Turns free text into a URL-safe slug of at most MAX_SLUG characters. */
export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG);
}

/** Turns every dash into a space. */
export function unslugify(s: string): string {
  return s.replaceAll("-", " ");
}

/** Checks for a nonempty slug within MAX_SLUG, with single internal dashes only. */
export function isSlug(s: string): boolean {
  return s.length <= MAX_SLUG && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}
