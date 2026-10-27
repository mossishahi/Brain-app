import { Tooltip } from "@base-ui/react/tooltip";
import { LuBrain } from "react-icons/lu";

export function RegistryIndicator({ connected, page, target, versionLine }: {
  readonly connected: boolean;
  readonly page?: string;
  readonly target: string;
  readonly versionLine?: string;
}) {
  const description = connected
    ? `Connected to Brain Registry at ${target}${versionLine ? ` — ${versionLine}` : ""}`
    : `Not connected to Brain Registry at ${target}. The registry could not be verified just now.`;
  return <Tooltip.Provider delay={160} closeDelay={240}><Tooltip.Root>
    <Tooltip.Trigger render={<a className={`registry-indicator ${connected ? "connected" : "disconnected"}`} href={page} target="_blank" rel="noreferrer" aria-label={description} onClick={(event) => { if (!page) event.preventDefault(); }} />}><LuBrain aria-hidden="true" /></Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Positioner side="top" sideOffset={10} collisionPadding={12} className="canvas-composer-positioner"><Tooltip.Popup className="canvas-registry-tooltip">{description}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root></Tooltip.Provider>;
}
