declare module "vanta/dist/vanta.halo.min" {
  interface VantaInstance {
    destroy(): void;
  }

  const HALO: (
    options: Record<string, unknown>,
  ) => VantaInstance;

  export default HALO;
}

declare module "vanta/dist/vanta.clouds.min" {
  interface VantaInstance {
    destroy(): void;
  }

  const CLOUDS: (
    options: Record<string, unknown>,
  ) => VantaInstance;

  export default CLOUDS;
}
