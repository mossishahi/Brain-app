/**
 * Copy text to the clipboard, wherever the app is served from.
 *
 * The async Clipboard API exists only in SECURE contexts (https, localhost).
 * This app routinely runs over plain http on a cluster node, where
 * `navigator.clipboard` is undefined — every copy button silently did
 * nothing there. The fallback is the old selection path (a hidden textarea
 * plus `document.execCommand("copy")`): deprecated, but it is the one
 * mechanism insecure origins have, and every browser still ships it.
 *
 * Returns whether the text actually reached the clipboard, so a button can
 * refuse to claim "copied" when it did not.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission quirks fall through to the selection path.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-viewport, not display:none — a hidden element cannot be selected.
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous =
    selection !== null && selection.rangeCount > 0
      ? selection.getRangeAt(0)
      : undefined;
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  // The selection path steals the user's selection; hand it back.
  if (previous !== undefined && selection !== null) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}
