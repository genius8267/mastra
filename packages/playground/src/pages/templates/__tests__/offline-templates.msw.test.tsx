// @vitest-environment jsdom
import { MastraReactProvider } from '@mastra/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Templates from '../index';
import Template from '../template/index';
import { cachedHostedTemplate } from './fixtures/offline-template';
import { server } from '@/test/msw-server';

const renderTemplates = (
  detail = false,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) => {
  return render(
    <MastraReactProvider baseUrl="http://localhost:4111">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{detail ? <Template /> : <Templates />}</MemoryRouter>
      </QueryClientProvider>
    </MastraReactProvider>,
  );
};
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Templates', () => {
  describe('when the Studio build uses offline mode', () => {
    it('explains the unavailable catalog without requesting hosted templates', async () => {
      vi.stubEnv('VITE_MASTRA_STUDIO_OFFLINE', 'true');
      const catalogRequests = vi.fn();
      server.use(
        http.get('https://mastra.ai/api/templates.json', () => {
          catalogRequests();
          return HttpResponse.json([]);
        }),
      );
      renderTemplates();
      expect(await screen.findByText('Hosted templates are disabled in this Studio build.')).toBeTruthy();
      expect(screen.queryByText('Weather Agent')).toBeNull();
      expect(catalogRequests).not.toHaveBeenCalled();
    });

    it('does not mount a template installer through a direct detail route', async () => {
      vi.stubEnv('VITE_MASTRA_STUDIO_OFFLINE', 'true');
      const requests = vi.fn();
      server.use(
        http.all('*', () => {
          requests();
          return HttpResponse.json({});
        }),
      );
      renderTemplates(true);
      expect(await screen.findByText('Hosted templates are disabled in this Studio build.')).toBeTruthy();
      expect(requests).not.toHaveBeenCalled();
    });

    it('does not render hosted card resources from a previously cached catalog', async () => {
      vi.stubEnv('VITE_MASTRA_STUDIO_OFFLINE', 'true');
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      queryClient.setQueryData(['mastra-templates'], { templates: [cachedHostedTemplate], tags: [], providers: [] });
      renderTemplates(false, queryClient);
      expect(await screen.findByText('Hosted templates are disabled in this Studio build.')).toBeTruthy();
      expect(screen.queryByText(cachedHostedTemplate.title)).toBeNull();
    });
  });

  describe('when the Studio build keeps its default network mode', () => {
    it('retains the existing hosted catalog behavior', async () => {
      vi.stubEnv('VITE_MASTRA_STUDIO_OFFLINE', 'false');
      const catalogRequests = vi.fn();
      server.use(
        http.get('https://mastra.ai/api/templates.json', () => {
          catalogRequests();
          return HttpResponse.json([]);
        }),
      );
      renderTemplates();
      expect(await screen.findByText('Weather Agent')).toBeTruthy();
      expect(catalogRequests).toHaveBeenCalledTimes(1);
    });
  });
});
