/** Public choices contain no renderer code, so opening settings stays inexpensive. */
export const backgroundOptions = [
  { id: "aurora", label: "Aurora", description: "Soft, slowly evolving blue and lavender light." },
  { id: "orbit", label: "Orbit", description: "Fine flowing curves around a quiet light field." },
  { id: "none", label: "None", description: "A plain background without decorative rendering." },
] as const;

export type BackgroundId = (typeof backgroundOptions)[number]["id"];
