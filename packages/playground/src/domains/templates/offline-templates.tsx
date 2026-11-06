import { Header, HeaderTitle } from '@mastra/playground-ui/components/Header';
import { PageLayout } from '@mastra/playground-ui/components/PageLayout';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { PageBreadcrumbs } from '@/components/ui/page-breadcrumbs';

const crumbs = [{ id: 'templates', label: 'Templates' }];

export function OfflineTemplates() {
  return (
    <PageLayout breadcrumbs={<PageBreadcrumbs crumbs={crumbs} />}>
      <Header>
        <HeaderTitle>Templates</HeaderTitle>
      </Header>
      <div className="p-5" role="status">
        <Txt tone="muted">Hosted templates are disabled in this Studio build.</Txt>
      </div>
    </PageLayout>
  );
}
