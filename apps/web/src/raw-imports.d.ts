/** Vite `?raw` imports used by this app (the bundled LaTeX style file). */
declare module "*.sty?raw" {
  const text: string;
  export default text;
}
