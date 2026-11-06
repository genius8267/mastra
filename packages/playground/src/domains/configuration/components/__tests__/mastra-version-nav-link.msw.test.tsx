// @vitest-environment jsdom
import { TooltipProvider } from '@mastra/playground-ui/components/Tooltip';
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MastraVersionNavLink } from '../mastra-version-nav-link';
import {
  currentPackageRegistryResponse,
  deprecatedPackageRegistryResponse,
  outdatedPackageRegistryResponse,
  systemPackagesWithUpdates,
} from './fixtures/mastra-version-nav-link';
import type { NpmRegistryResponse } from './fixtures/mastra-version-nav-link';
import { server } from '@/test/msw-server';

const BASE_URL = 'http://localhost:4111';

const renderVersionNavLink = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <MastraReactProvider baseUrl={BASE_URL}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ul>
            <MastraVersionNavLink />
          </ul>
        </TooltipProvider>
      </QueryClientProvider>
    </MastraReactProvider>,
  );
};

const mockRegistry = (responses: Record<string, NpmRegistryResponse>) =>
  http.get('https://registry.npmjs.org/:packageName', ({ request }) => {
    const packageName = decodeURIComponent(new URL(request.url).pathname.slice(1));
    return HttpResponse.json(responses[packageName]);
  });

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('MastraVersionNavLink', () => {
  describe('when the Studio build uses offline mode', () => {
    it('lists installed versions without contacting the registry or claiming update readiness', async () => {
      vi.stubEnv('VITE_MASTRA_STUDIO_OFFLINE', 'true');
      const registryRequests = vi.fn();
      server.use(
        http.get(`${BASE_URL}/api/system/packages`, () => HttpResponse.json(systemPackagesWithUpdates)),
        http.get('https://registry.npmjs.org/:packageName', () => {
          registryRequests();
          return HttpResponse.json(currentPackageRegistryResponse);
        }),
      );
      renderVersionNavLink();
      fireEvent.click(await screen.findByRole('button', { name: /Version 1\.0\.0/ }));
      expect(await screen.findByText('Registry checks are disabled in this Studio build.')).toBeTruthy();
      expect(screen.getByText('@mastra/core')).toBeTruthy();
      expect(screen.getByText('@mastra/memory')).toBeTruthy();
      expect(screen.queryByText('Up to date')).toBeNull();
      expect(screen.queryByText('Update with')).toBeNull();
      expect(registryRequests).not.toHaveBeenCalled();
    });
  });

  describe('when installed packages include outdated and deprecated versions', () => {
    it('flags the row and lists both in the popover with an update command', async () => {
      server.use(
        http.get(`${BASE_URL}/api/system/packages`, () => HttpResponse.json(systemPackagesWithUpdates)),
        mockRegistry({
          '@mastra/core': outdatedPackageRegistryResponse,
          '@mastra/memory': deprecatedPackageRegistryResponse,
        }),
      );

      renderVersionNavLink();

      const row = await screen.findByRole('button', { name: /Version 1\.0\.0/ });
      expect(await screen.findByText('Update')).toBeTruthy();

      fireEvent.click(row);

      expect(await screen.findByText('1 deprecated, 1 update available')).toBeTruthy();
      expect(screen.getByText('pnpm add @mastra/core@latest @mastra/memory@latest')).toBeTruthy();
    });
  });

  describe('when every package is current', () => {
    it('shows no update badge and says it is up to date', async () => {
      server.use(
        http.get(`${BASE_URL}/api/system/packages`, () => HttpResponse.json(systemPackagesWithUpdates)),
        mockRegistry({
          '@mastra/core': currentPackageRegistryResponse,
          '@mastra/memory': currentPackageRegistryResponse,
        }),
      );

      renderVersionNavLink();

      fireEvent.click(await screen.findByRole('button', { name: /Version 1\.0\.0/ }));

      expect(await screen.findByText('Up to date')).toBeTruthy();
      expect(screen.queryByText('Update')).toBeNull();
      expect(screen.queryByText('Update with')).toBeNull();
    });
  });
});
