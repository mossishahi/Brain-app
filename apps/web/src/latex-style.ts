/**
 * The repo's shared LaTeX style (app/latex_style.sty), bundled verbatim at
 * build time. Kept in its own module so the renderer (latex.ts) stays pure
 * and runnable outside the browser.
 */
import styleText from "../../../latex_style.sty?raw";

export const LATEX_STYLE: string = styleText;
