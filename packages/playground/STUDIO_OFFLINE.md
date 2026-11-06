# Offline Studio build

Set `VITE_MASTRA_STUDIO_OFFLINE=true` when you build Studio:

```sh
MASTRA_TELEMETRY_DISABLED=1 VITE_MASTRA_STUDIO_OFFLINE=true \
  pnpm --filter @internal/playground build
```

The profile disables the hosted template catalog, template detail installers and npm package-update queries. Studio still displays installed package versions.

The profile does not load hosted cards from a query cache. It does not claim that installed packages are current.

Without this setting, Studio retains its existing catalog and package-update behavior. Turbo includes this setting in both Studio build cache keys.

This is a build setting, not a runtime switch. Rebuild Studio when you change it. Select the resulting immutable Studio artifact through the existing host configuration.

This profile does not change framework APIs, model routing, authentication, EE checks or license behavior. It does not block or intercept network requests.

Keep the existing telemetry configuration. Do not use this profile as evidence about an EE license request or a user-selected external documentation link.
