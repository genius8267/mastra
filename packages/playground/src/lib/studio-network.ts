/** Opt-in build profile. Other Studio builds retain their existing network behavior. */
export function isStudioOffline(): boolean {
  return import.meta.env.VITE_MASTRA_STUDIO_OFFLINE === 'true';
}
