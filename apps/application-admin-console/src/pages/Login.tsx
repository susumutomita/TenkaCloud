import Box from "@cloudscape-design/components/box";
import Button from "@cloudscape-design/components/button";
import Container from "@cloudscape-design/components/container";
import Header from "@cloudscape-design/components/header";
import SpaceBetween from "@cloudscape-design/components/space-between";
import { useAuth } from "../auth/AuthProvider";
import { useT } from "../i18n";

export function LoginPage() {
  const auth = useAuth();
  const t = useT();

  return (
    <Box margin={{ top: "xxxl" }} textAlign="center">
      <Container header={<Header variant="h1">{t("login.header")}</Header>}>
        <SpaceBetween size="m">
          <Box variant="p">{t("login.description")}</Box>
          <Button variant="primary" onClick={auth.login}>
            {t("login.submit")}
          </Button>
        </SpaceBetween>
      </Container>
    </Box>
  );
}
