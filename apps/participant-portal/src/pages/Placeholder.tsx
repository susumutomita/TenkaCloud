import Alert from "@cloudscape-design/components/alert";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";

/**
 * 未実装ページ用 placeholder。`title` / `description` を渡して使う。
 */
export function PlaceholderPage({
  title,
  description,
  comingSoon,
}: {
  title: string;
  description: string;
  comingSoon: string;
}) {
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={description}>
        {title}
      </Header>
      <Container>
        <Alert type="info" header="まだ実装されていません">
          {comingSoon}
        </Alert>
      </Container>
    </SpaceBetween>
  );
}
