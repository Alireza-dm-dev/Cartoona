import type { ExampleKind } from "@/types/app";

export type ShowcaseType = ExampleKind;

export const showcaseGradients: Record<ShowcaseType, string> = {
  video: "from-sky-blue/20 to-soft-purple/20",
  drawing: "from-mint-green/20 to-sunshine-yellow/20",
  story: "from-candy-pink/20 to-sky-blue/20",
};
