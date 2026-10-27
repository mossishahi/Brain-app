import { useState, type ComponentPropsWithRef } from "react";
import { Menu } from "@base-ui/react/menu";

/**
 * Base UI menus focus their container on open, including pointer previews.
 * Keep that container non-focusable until the user explicitly interacts. This
 * uses the public render and highlightItemOnHover props, leaving keyboard
 * navigation to the menu. Pointer browsing never interrupts a draft being typed.
 */
export function useHoverMenuFocus() {
  const [preview, setPreview] = useState(false);
  const claimInteraction = () => setPreview(false);
  return {
    preview,
    onOpenChange(open: boolean, details: Menu.Root.ChangeEventDetails) {
      // Keep the last opening mode through dismissal so a pointer preview does
      // not move focus to its trigger when it closes.
      if (open) setPreview(details.reason === "trigger-hover");
    },
    rootProps: { highlightItemOnHover: !preview },
    triggerProps: {
      onPointerDown: claimInteraction,
      onKeyDown: claimInteraction,
    },
    popupProps: {
      onPointerDown: claimInteraction,
      onKeyDown: claimInteraction,
      finalFocus: preview ? false : undefined,
      render: (props: ComponentPropsWithRef<"div">) => <div {...props} tabIndex={preview ? undefined : props.tabIndex} />,
    },
  };
}
