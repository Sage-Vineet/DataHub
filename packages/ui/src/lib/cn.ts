import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Compose class names with clsx + tailwind-merge (last conflicting class wins). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
